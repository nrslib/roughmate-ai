import { fenced, environmentFence } from './environment-lease.js';
import { password } from '@inquirer/prompts';
import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ConfigurationAccess, type ConfigurationStatus } from '../../app/src/configuration-tokens.js';
import { Storage } from '../../app/src/storage.js';
import { AppError, object, string } from '../../app/src/contracts.js';
import { Registrations, childResources, registrationKey, configurationKey, type Registry, type Registration } from '../../app/src/registration.js';
import { childScopes, confirmedCreateFailure } from '../../app/src/provisioner.js';
import { invitationScopes } from '../../app/src/channel-authorization.js';
import { slackClient } from './leased-slack.js';
import type { SetupAws } from './aws.js';
import type { Descriptor } from './config.js';

export async function connectRegistration(aws: SetupAws, descriptor: Descriptor, prompt: typeof password, reconnect = false): Promise<void> {
  const root = fenced(new Storage(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region));
  const secret = `roughmate-${aws.target.environment}/configuration`;
  const access = fenced(new ConfigurationAccess(root, descriptor.tableName, secret, aws.target.region));
  let needsRefresh = reconnect;
  if (!reconnect) {
    try { await access.connect(); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'configuration_refresh_required') throw error;
      needsRefresh = true;
    }
  }
  if (needsRefresh) {
    const refresh = string(await prompt({ message: reconnect ? 'root OAuth ownerが新しく生成した未使用のConfiguration Refresh Token（非表示）:' : 'root OAuth ownerが生成したConfiguration Refresh Token（非表示）:', mask: '*' }));
    await access.connect(refresh, reconnect);
  }
  process.stdout.write('登録サービスを接続しました。既存RoughmateのHomeから新しいBotを作成できます。\n');
}

export async function resumeRegistrationAfterSetup(aws: SetupAws, descriptor: Descriptor, retiredAppId: string, appId: string): Promise<void> {
  if (!/^A[A-Z0-9]+$/.test(retiredAppId) || !/^A[A-Z0-9]+$/.test(appId) || retiredAppId === appId) throw new AppError('registration_boundary');
  const registry = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: registrationKey }, ConsistentRead: true }))).Item as Registry | undefined;
  if (!registry) return;
  if (registry.pk !== registrationKey || registry.parentSecret !== descriptor.secretArn || !Number.isSafeInteger(registry.version) || registry.version < 1 || !Array.isArray(registry.entries) || registry.entries.length) throw new AppError('registration_children_present');
  if (!registry.deleting) return;
  if (registry.removingAppId !== retiredAppId) throw new AppError('registration_boundary');
  if ((await aws.readSecrets(descriptor))?.appId !== appId) throw new AppError('registration_boundary');
  const status = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: configurationKey }, ConsistentRead: true }))).Item as ConfigurationStatus | undefined;
  if (status && (status.pk !== configurationKey || typeof status.version !== 'string' || !['ready','rotating','disconnected'].includes(status.phase) || status.phase === 'rotating' && !status.nextVersion)) throw new AppError('configuration_boundary');
  // 削除完了から作り直した親だけを開き、旧ownerのrefreshを再利用しない。
  try {
    await environmentFence();
    await aws.db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConditionExpression: '#phase = :created AND appId = :app AND retiredAppId = :retired', ExpressionAttributeNames: { '#phase': 'phase' }, ExpressionAttributeValues: { ':created': 'created', ':app': appId, ':retired': retiredAppId } } },
      { Put: { TableName: descriptor.tableName, Item: { ...registry, version: registry.version+1, deleting: false }, ConditionExpression: '#version = :version AND parentSecret = :parent AND deleting = :deleting AND (attribute_not_exists(homeNoticeUntil) OR homeNoticeUntil <= :now)', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': registry.version, ':parent': descriptor.secretArn, ':deleting': true, ':now': Math.floor(Date.now()/1000) } } },
      { Put: { TableName: descriptor.tableName, Item: { pk: configurationKey, version: randomUUID(), phase: 'disconnected' }, ConditionExpression: status ? '#version = :version AND #phase = :phase' + (status.phase === 'rotating' ? ' AND nextVersion = :nextVersion' : '') : 'attribute_not_exists(pk)', ...(status ? { ExpressionAttributeNames: { '#version': 'version', '#phase': 'phase' }, ExpressionAttributeValues: { ':version': status.version, ':phase': status.phase, ...(status.phase === 'rotating' ? { ':nextVersion': status.nextVersion } : {}) } } : {}) } }
    ] }));
  } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('registration_conflict'); throw error; }
}
export async function stopRegistrationForRemoval(aws: SetupAws, descriptor: Descriptor, appId?: string): Promise<void> {
  const previous = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: registrationKey }, ConsistentRead: true }))).Item as Registry | undefined;
  if (previous && (previous.pk !== registrationKey || previous.parentSecret !== descriptor.secretArn || !Number.isSafeInteger(previous.version) || previous.version < 1 || !Array.isArray(previous.entries) || previous.entries.length)) throw new AppError('registration_children_present');
  if (previous?.deleting) return;
  const removingAppId = appId;
  if (removingAppId !== undefined && !/^A[A-Z0-9]+$/.test(removingAppId)) throw new AppError('registration_boundary');
  try {
    await environmentFence();
    await aws.db.send(new PutCommand({ TableName: descriptor.tableName, Item: { pk: registrationKey, parentSecret: descriptor.secretArn, version: (previous?.version ?? 0)+1, entries: [], deleting: true, ...(removingAppId ? { removingAppId } : {}) },
      ConditionExpression: previous ? '#version = :version AND parentSecret = :parent AND (attribute_not_exists(homeNoticeUntil) OR homeNoticeUntil <= :now)' : 'attribute_not_exists(pk)',
      ...(previous ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previous.version, ':parent': descriptor.secretArn, ':now': Math.floor(Date.now()/1000) } } : {}) }));
  } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('registration_conflict'); throw error; }
}

export async function recoverRegistration(aws: SetupAws, descriptor: Descriptor, id: string, appId: string, prompt: typeof password): Promise<void> {
  if (!/^A[A-Z0-9]+$/.test(appId)) throw new AppError('registration_boundary');
  const registrations = fenced(new Registrations(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region));
  const registry = await registrations.read(), entry = registry.entries.find(item => item.id === id);
  const workspace = await registrations.root.workspace(), root = await registrations.root.readSecrets();
  if (registry.deleting || !entry || !['creating','failed'].includes(entry.phase) || !entry.createOwner || !entry.secretArn || entry.installOwner || entry.appId && entry.appId !== appId || entry.expiresAt <= Math.floor(Date.now()/1000) || entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== root.appId) throw new AppError('registration_boundary');
  childResources(descriptor.tableName, descriptor.secretArn, id);
  await verifyChildManifest(aws, descriptor, registrations, entry, appId);
  let recovered: Record<string, unknown> | undefined;
  try { recovered = object(JSON.parse(string((await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.createOwner }))).SecretString))); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error; }
  if (recovered) {
    if (recovered.appId !== appId) throw new AppError('registration_boundary');
    for (const field of ['clientId','clientSecret','signingSecret','apiKey','model']) string(recovered[field]);
  } else {
    recovered = { appId, clientId: string(await prompt({ message: '照合したappのClient ID（非表示）:', mask: '*' })), clientSecret: string(await prompt({ message: 'Client secret（非表示）:', mask: '*' })), signingSecret: string(await prompt({ message: 'Signing secret（非表示）:', mask: '*' })), apiKey: root.apiKey, model: root.model };
    await environmentFence();
    await aws.secrets.send(new PutSecretValueCommand({ SecretId: entry.secretArn, ClientRequestToken: entry.createOwner, SecretString: JSON.stringify(recovered) }));
  }
  await registrations.save(registry, registry.entries.map(item => item.id === id ? { ...item, phase: 'created', appId, credentialVersion: entry.createOwner } : item));
  process.stdout.write('照合した既存appを復旧しました。root Homeの再確認ボタンで接続準備を再開してください。新しいappは作成していません。\n');
}
async function verifyChildManifest(aws: SetupAws, descriptor: Descriptor, registrations: Registrations, entry: Registration, appId: string, connected = false): Promise<void> {
  const token = await fenced(new ConfigurationAccess(registrations.root, descriptor.tableName, `${descriptor.tableName}/configuration`, aws.target.region)).token(false);
  const client = slackClient(token, undefined, 30_000);
  const manifest = object((await client.apps.manifest.export({ app_id: appId })).manifest);
  const display = object(manifest.display_information), base = `${descriptor.publicUrl}/bots/${entry.id}`;
  const oauth = object(manifest.oauth_config), scopes = object(oauth.scopes).bot;
  const userScopes = object(oauth.scopes).user;
  if (!Array.isArray(userScopes) || userScopes.length !== invitationScopes.length || invitationScopes.some(scope => !userScopes.includes(scope))) throw new AppError('registration_boundary');
  if (display.name !== entry.name || typeof display.long_description !== 'string' || !display.long_description.endsWith(`Registration: ${base}`) || object(object(manifest.features).bot_user).display_name !== entry.botName || !Array.isArray(scopes) || scopes.length !== childScopes.length || childScopes.some(scope => !scopes.includes(scope))) throw new AppError('registration_boundary');
  if (connected && (!Array.isArray(oauth.redirect_urls) || oauth.redirect_urls.length !== 2 || !oauth.redirect_urls.includes(`${base}/oauth/callback`) || !oauth.redirect_urls.includes(`${base}/channel-authorization/callback`) || object(object(manifest.settings).event_subscriptions).request_url !== `${base}/slack/events` || object(object(manifest.settings).interactivity).request_url !== `${base}/slack/interactive`)) throw new AppError('registration_boundary');
  if (oauth.redirect_urls !== undefined && (!Array.isArray(oauth.redirect_urls) || oauth.redirect_urls.some(url => ![`${base}/oauth/callback`,`${base}/channel-authorization/callback`].includes(String(url))))) throw new AppError('registration_boundary');
  if (manifest.settings !== undefined) for (const [key,path] of [['event_subscriptions','/slack/events'],['interactivity','/slack/interactive']]) {
    const setting = object(manifest.settings)[key];
    if (setting !== undefined && object(setting).request_url !== `${base}${path}`) throw new AppError('registration_boundary');
  }
}

export async function restartRegistrationOAuth(aws: SetupAws, descriptor: Descriptor, id: string, appId: string): Promise<void> {
  const registrations = fenced(new Registrations(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region));
  const registry = await registrations.read(), entry = registry.entries.find(item => item.id === id);
  const workspace = await registrations.root.workspace(), root = await registrations.root.readSecrets();
  if (registry.deleting || !entry || entry.phase !== 'install_wait' || !entry.installOwner || !entry.createOwner || !entry.secretArn || entry.appId !== appId || entry.expiresAt <= Math.floor(Date.now()/1000) || entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== root.appId) throw new AppError('registration_boundary');
  try {
    await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.installOwner }));
    process.stdout.write('OAuthの既知保存版があります。root Homeの再確認で同じ版を復旧してください。新しいstateは発行していません。\n');
    return;
  } catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error; }
  await verifyChildManifest(aws, descriptor, registrations, entry, appId, true);
  const credentials = object(JSON.parse(string((await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.createOwner }))).SecretString)));
  if (credentials.appId !== appId) throw new AppError('registration_boundary');
  for (const field of ['clientId','clientSecret','signingSecret','apiKey','model']) string(credentials[field]);
  const next = { ...entry, credentialVersion: entry.createOwner };
  delete next.installOwner; delete next.oauthState; delete next.oauthExpiresAt; delete next.failureCode; delete next.oauthRetryAt;
  await registrations.save(registry, registry.entries.map(item => item.id === id ? next : item));
  process.stdout.write('同じ子appの新しいOAuth承認を許可しました。root Homeを開き直してSlackに追加してください。旧codeは交換せず、Botは承認完了まで利用可能にしません。\n');
}

export async function resumeFailedRegistration(aws: SetupAws, descriptor: Descriptor, id: string): Promise<void> {
  const registrations = fenced(new Registrations(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region));
  const registry = await registrations.read(), entry = registry.entries.find(item => item.id === id);
  const workspace = await registrations.root.workspace(), root = await registrations.root.readSecrets();
  if (registry.deleting || !entry || entry.phase !== 'failed' || !entry.secretArn || entry.expiresAt <= Math.floor(Date.now()/1000) || entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== root.appId || !['invalid_manifest','slack_invalid_manifest','slack_invalid_auth','slack_not_allowed_token_type','slack_not_in_team','slack_missing_scope','slack_token_expired','slack_no_permission'].includes(entry.failureCode ?? '')) throw new AppError('registration_boundary');
  const next = { ...entry };
  if (entry.appId) {
    if (!entry.createOwner) throw new AppError('registration_boundary');
    await verifyChildManifest(aws, descriptor, registrations, entry, entry.appId);
    const credentials = object(JSON.parse(string((await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.createOwner }))).SecretString)));
    if (credentials.appId !== entry.appId) throw new AppError('registration_boundary');
    for (const field of ['clientId','clientSecret','signingSecret','apiKey','model']) string(credentials[field]);
    next.phase = 'created'; next.credentialVersion = entry.createOwner;
  } else {
    if (entry.installOwner || entry.credentialVersion) throw new AppError('registration_recovery_requires_inspection');
    if (entry.createOwner) {
      const saved = object(JSON.parse(string((await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.createOwner }))).SecretString)));
      if (confirmedCreateFailure(saved, entry).failureCode !== entry.failureCode) throw new AppError('registration_boundary');
      delete next.createOwner; delete next.createRetryAt;
    }
    await fenced(new ConfigurationAccess(registrations.root, descriptor.tableName, `${descriptor.tableName}/configuration`, aws.target.region)).token(false);
    next.phase = 'resources';
  }
  delete next.failureCode;
  await registrations.save(registry, registry.entries.map(item => item.id === id ? next : item));
  process.stdout.write('同じ登録IDの再確認を許可しました。root Homeの再確認で再開してください。既存appは保持します。\n');
}
