import { validateRootCreation, prepareRootCreation, finishRootCreation } from './root-history.js';
import {advanceRootHistory,validateRootHistory,type RootHistory} from './root-history-model.js';
import { preservePurgeEvidence } from './purge-evidence.js';
import { fenced, environmentFence } from './environment-lease.js';
import type { password, input, confirm } from '@inquirer/prompts';
export interface SetupInteraction { password: typeof password; input: typeof input; confirm: typeof confirm; }
import { randomBytes } from 'node:crypto';
import { GetCommand, PutCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AppError, object, string, requireInstalledSecrets, type Workspace, type Secrets } from '../../app/src/contracts.js';
import { requireBotIdentity } from '../../app/src/slack.js';
import { slackClient } from './leased-slack.js';
import { validateGroup, validateName, validateDescription, validateSetupSeed } from '../../app/src/groups.js';
import { stateKey } from '../../app/src/security.js';
import { manifest, requireSlackAppTarget, type Descriptor, type SlackTarget } from './config.js';
import type { SetupAws } from './aws.js';
import { Storage } from '../../app/src/storage.js';
import { botScopes } from '../../app/src/slack.js';
import { stopRegistrationForRemoval, resumeRegistrationAfterSetup } from './registration-setup.js';
export async function setupSlack(aws: SetupAws, descriptor: Descriptor, reinstall: boolean, recoverAppId: string | undefined, interaction: SetupInteraction, options?: { name?: string; description?: string; rootHistory?: RootHistory }): Promise<void> {
  if (options?.name !== undefined) validateName(options.name);
  validateDescription(options?.description ?? '');
  const existingGroup = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'roughmate' }, ConsistentRead: true }))).Item;
  const group = existingGroup ? validateGroup(existingGroup) : undefined;
  if (group && (group.environmentId !== descriptor.secretArn || options?.name && options.name !== group.name)) throw new AppError('group_name_mismatch');
  let fullManifest = await manifest(descriptor, options?.name ?? group?.name);
  const progress = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }))).Item;
  if (progress?.phase !== 'deleted' && progress?.scopeExcess) throw new AppError('slack_scope_reduction_required');
  const existingWorkspace = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'workspace' }, ConsistentRead: true }))).Item as Workspace | undefined;
  let rootHistory = progress?.rootHistory ? validateRootHistory(progress.rootHistory) : options?.rootHistory;
  const creating = progress?.phase === 'creating';
  if (creating && !recoverAppId) throw new AppError('slack_creation_ambiguous');
  const retiredAppId = progress?.phase === 'deleted' ? progress.appId : progress?.retiredAppId;
  if (retiredAppId && recoverAppId === retiredAppId) throw new AppError('slack_target_mismatch');
  const savedSecrets = progress?.phase === 'deleted' ? undefined : await aws.readSecrets(descriptor);
  if (progress?.phase !== 'deleted' && progress?.oauthAttempt) {
    const receipt = savedSecrets?.rootOAuth;
    if (!reinstall || !existingWorkspace || !savedSecrets || !receipt || savedSecrets.appId !== progress.appId || receipt?.requestId !== progress.oauthAttempt || !receipt.teamId || !receipt.ownerId || !savedSecrets.botToken || !savedSecrets.botUserId || !savedSecrets.botScopes || botScopes.some(scope => !savedSecrets.botScopes!.includes(scope)) || savedSecrets.botScopes.some(scope => !botScopes.some(expected => expected === scope)) || existingWorkspace?.teamId !== receipt.teamId || existingWorkspace.ownerId !== receipt.ownerId) throw new AppError('root_oauth_pending');
    const auth = await slackClient(savedSecrets.botToken).auth.test();
    if (auth.ok !== true || 'error' in auth || auth.team_id !== receipt.teamId || auth.user_id !== savedSecrets.botUserId) throw new AppError('root_oauth_pending');
    const store = fenced(new Storage(descriptor.tableName, descriptor.secretArn));
    if (!group) {
      const rawSeed = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'roughmate#setup' }, ConsistentRead: true }))).Item;
      const seed = validateSetupSeed(rawSeed);
      if (seed.appId !== savedSecrets.appId) throw new AppError('root_oauth_pending');
      await store.initializeGroup(validateGroup({ pk: 'roughmate', environmentId: descriptor.secretArn, appId: savedSecrets.appId, teamId: receipt.teamId, version: 1, name: seed.name, description: seed.description, adminIds: [receipt.ownerId], notifyUserIds: [], intakeChannelIds: [] }));
    } else if (group.environmentId !== descriptor.secretArn || group.appId !== savedSecrets.appId || group.teamId !== receipt.teamId) throw new AppError('root_oauth_pending');
    await store.finishRootOAuth(savedSecrets.appId, string(progress.oauthAttempt));
    process.stdout.write('保存済みのRoot OAuth成功結果を照合し、未完了の保存を復旧しました。\n');
    return;
  }
  // creating の秘密値は保存成功・状態保存失敗の値か、退役アプリの値か未確定。
  let secrets = creating ? undefined : savedSecrets;
  const activeAppId = progress?.phase === 'deleted' ? undefined : progress?.appId;
  if (activeAppId && secrets && activeAppId !== secrets.appId) throw new AppError('slack_target_mismatch');
  if (activeAppId && recoverAppId && activeAppId !== recoverAppId) throw new AppError('slack_target_mismatch');
  const requiredScopes = fullManifest.oauth_config?.scopes?.bot;
  if (!requiredScopes) throw new AppError('invalid_manifest');
  let tokenRevoked = false;
  const verifySavedInstallation = async (saved: Secrets): Promise<Secrets> => {
    // OAuth は権限を追加するため、余剰権限は既存アプリの削除・再作成で解消する。
    if (saved.botScopes?.some(scope => !requiredScopes.some(required => required === scope))) throw new AppError('slack_scope_reduction_required');
    if (saved.botToken && !saved.botScopes) throw new AppError('slack_scopes_unknown');
    if (saved.botToken && reinstall) {
      const installed = requireInstalledSecrets(saved);
      if (!existingWorkspace || group && (group.appId !== saved.appId || group.teamId !== existingWorkspace.teamId)) throw new AppError('group_boundary_mismatch');
      try { await requireBotIdentity(slackClient(installed.botToken), string(existingWorkspace.teamId), string(installed.botUserId)); }
      catch (error) {
        const code = error && typeof error === 'object' && 'data' in error ? object(error.data).error : undefined;
        if (code !== 'token_revoked') throw error;
        tokenRevoked = true;
        return { ...saved, botToken: undefined, botUserId: undefined, botScopes: undefined };
      }
    }
    return saved;
  };
  if (secrets) secrets = await verifySavedInstallation(secrets);
  if (!secrets) rootHistory=await validateRootCreation(aws,progress,recoverAppId,options?.rootHistory?{history:validateRootHistory(options.rootHistory)}:undefined);
  const configurationToken = await interaction.password({ message: 'Slack App configuration token (12時間有効、新しいtokenを入力可):', mask: '*' });
  // アプリ管理APIは対話セットアップで使い、Slackイベント受付の応答期限には拘束されない。
  const client = slackClient(string(configurationToken), undefined, 30_000);
  if (!secrets) {
    if (recoverAppId) {
      if (!/^A[A-Z0-9]+$/.test(recoverAppId)) throw new AppError('invalid_app_id');
      requireSlackAppTarget((await client.apps.manifest.export({ app_id: recoverAppId })).manifest, descriptor);
      if (savedSecrets?.appId === recoverAppId) secrets = await verifySavedInstallation(savedSecrets);
    }
    if (!secrets) {
      const apiKey = string(await interaction.password({ message: 'OpenAI API key:', mask: '*' }));
      const model = string(await interaction.input({ message: '使用する OpenAI モデルID（利用可能なIDを指定）:' }));
      if (recoverAppId) {
        secrets = { appId: recoverAppId, clientId: string(await interaction.input({ message: '復旧するアプリの Client ID:' })), clientSecret: string(await interaction.password({ message: 'Client secret:', mask: '*' })), signingSecret: string(await interaction.password({ message: 'Signing secret:', mask: '*' })), apiKey, model };
      } else {
        rootHistory=await prepareRootCreation(aws,progress,undefined,{history:rootHistory});
        try { await environmentFence(); await aws.db.send(new PutCommand({ TableName: descriptor.tableName, Item: { pk: 'setup#slack', phase: 'creating', ...(rootHistory?{rootHistory}:{}), ...(retiredAppId ? { retiredAppId: string(retiredAppId) } : {}) }, ConditionExpression: 'attribute_not_exists(pk) OR phase = :deleted', ExpressionAttributeValues: { ':deleted': 'deleted' } })); }
        catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('slack_creation_ambiguous'); throw error; }
        // URL検証前に署名秘密を保存できるよう、作成時にはHTTP接続をまだ設定しない。
        const initial = { display_information: fullManifest.display_information, features: fullManifest.features, oauth_config: { scopes: object(fullManifest.oauth_config).scopes } };
        const result = await client.apps.manifest.create({ manifest: initial as Parameters<typeof client.apps.manifest.create>[0]['manifest'] });
        const credentials = object(result.credentials);
        secrets = { appId: string(result.app_id), clientId: string(credentials.client_id), clientSecret: string(credentials.client_secret), signingSecret: string(credentials.signing_secret), apiKey, model };
        if (rootHistory) rootHistory=await finishRootCreation(aws,secrets.appId,rootHistory);
        requireSlackAppTarget((await client.apps.manifest.export({ app_id: secrets.appId })).manifest, descriptor);
      }
    }
    if (recoverAppId) {
      rootHistory=await validateRootCreation(aws,progress,recoverAppId,{history:rootHistory});
      if (rootHistory) rootHistory=await finishRootCreation(aws,secrets.appId,rootHistory);
    }
    await aws.saveSecrets(descriptor, secrets);
    tokenRevoked = false;
    await environmentFence();
    await aws.db.send(new PutCommand({ TableName: descriptor.tableName, Item: { pk: 'setup#slack', phase: 'created', appId: secrets.appId, ...(rootHistory?{rootHistory:advanceRootHistory(rootHistory,secrets.appId)}:{}), ...(retiredAppId ? { retiredAppId: string(retiredAppId) } : {}) } }));
  }
  const exported = await client.apps.manifest.export({ app_id: secrets.appId });
  if (!exported.manifest) throw new AppError('slack_app_unavailable');
  requireSlackAppTarget(exported.manifest, descriptor);
  if (group && (group.appId !== secrets.appId || group.teamId !== existingWorkspace?.teamId)) throw new AppError('group_boundary_mismatch');
  if (tokenRevoked) await aws.saveSecrets(descriptor, secrets);
  const exportedValue = object(exported.manifest);
  const existingBotName = string(object(object(exportedValue.features).bot_user).display_name);
  const finalName = options?.name ?? group?.name ?? string(object(exportedValue.display_information).name);
  fullManifest = await manifest(descriptor, finalName, existingBotName);
  if (!existingWorkspace && !group) {
    const previousSeed = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'roughmate#setup' }, ConsistentRead: true }))).Item;
    if (previousSeed && previousSeed.appId !== secrets.appId) throw new AppError('group_boundary_mismatch');
    const seed = validateSetupSeed({ appId: secrets.appId, name: finalName, description: options?.description ?? previousSeed?.description ?? '' });
    await environmentFence();
    await aws.db.send(new PutCommand({ TableName: descriptor.tableName, Item: { pk: 'roughmate#setup', ...seed } }));
  }
  await client.apps.manifest.update({ app_id: secrets.appId, manifest: fullManifest });
  if (retiredAppId) await resumeRegistrationAfterSetup(aws, descriptor, string(retiredAppId), secrets.appId);
  process.stdout.write(`Slack アプリ ${secrets.appId} の Manifest を更新しました。\n`);
  const needsScopes = requiredScopes.some(scope => !secrets.botScopes?.includes(scope));
  if (secrets.botToken && existingWorkspace && !reinstall && !needsScopes) {
    process.stdout.write('既存の OAuth インストールを保持しました。再承認には --reinstall を指定してください。\n');
    return;
  }
  const state = randomBytes(32).toString('base64url');
  await environmentFence();
  await aws.db.send(new TransactWriteCommand({ TransactItems: [
    { ConditionCheck: { TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConditionExpression: 'appId = :app AND #phase = :created AND attribute_not_exists(scopeExcess) AND attribute_not_exists(oauthAttempt)', ExpressionAttributeNames: { '#phase': 'phase' }, ExpressionAttributeValues: { ':app': secrets.appId, ':created': 'created' } } },
    { Put: { TableName: descriptor.tableName, Item: { pk: stateKey(state), ...(existingWorkspace ? { teamId: existingWorkspace.teamId, ownerId: existingWorkspace.ownerId } : {}), expiresAt: Math.floor(Date.now()/1000) + 900 } } }
  ] }));
  const scopes = object(object(fullManifest.oauth_config).scopes).bot;
  if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) throw new AppError('invalid_manifest');
  const authorize = new URL('https://slack.com/oauth/v2/authorize');
  authorize.search = new URLSearchParams({ client_id: secrets.clientId, scope: scopes.join(','), redirect_uri: descriptor.publicUrl + '/oauth/callback', state, ...(existingWorkspace ? { team: existingWorkspace.teamId } : {}) }).toString();
  process.stdout.write(`次のURLをブラウザで開いて承認してください（15分有効）:\n${authorize.href}\n`);
  process.stdout.write('承認後、Slack の Roughmate ホームを開き、チャンネルを選択して保存してください。公開先へ自動参加します。非公開先はHomeで操作者本人が招待を認可してください。\n');
}
export async function deleteSlack(aws: SetupAws, descriptor: Descriptor, interaction: SetupInteraction, preserveEvidence = false): Promise<void> {
  const progress = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }))).Item;
  if (progress?.phase === 'deleted') { if (preserveEvidence) await preservePurgeEvidence(aws, descriptor); process.stdout.write('この環境の Slack アプリは削除済みです。\n'); return; }
  if (progress?.phase === 'creating') throw new AppError('slack_creation_ambiguous');
  const secrets = await aws.readSecrets(descriptor);
  if (!secrets) {
    if(preserveEvidence)throw new AppError('purge_evidence_missing');
    if (progress) throw new AppError('slack_app_unavailable');
    process.stdout.write('この環境の Slack アプリは未作成です。\n');
    return;
  }
  if (progress?.appId && progress.appId !== secrets.appId) throw new AppError('slack_target_mismatch');
  if (preserveEvidence) await preservePurgeEvidence(aws,descriptor);
  let history=progress?.rootHistory?validateRootHistory(progress.rootHistory):undefined;
  if(history){const workspace=(await aws.db.send(new GetCommand({TableName:descriptor.tableName,Key:{pk:'workspace'},ConsistentRead:true}))).Item;if(workspace?.ownerId&&workspace?.teamId){if(history.ownerId&&history.ownerId!==workspace.ownerId||history.teamId&&history.teamId!==workspace.teamId)throw new AppError('purge_root_history');history=validateRootHistory({...history,ownerId:workspace.ownerId,teamId:workspace.teamId});}}
  await stopRegistrationForRemoval(aws, descriptor, secrets.appId);
  await deleteDedicatedSlackApp(secrets.appId, descriptor, interaction);
  await aws.saveSecrets(descriptor, { ...secrets, botToken: undefined, botUserId: undefined, botScopes: undefined });
  for (const pk of ['workspace','roughmate','knowledge','roughmate#setup']) { await environmentFence(); await aws.db.send(new DeleteCommand({ TableName: descriptor.tableName, Key: { pk } })); }
  await environmentFence();
  await aws.db.send(new PutCommand({ TableName: descriptor.tableName, Item: { pk: 'setup#slack', phase: 'deleted', appId: secrets.appId, ...(history?{rootHistory:history}:{}) } }));
}
export async function deleteDedicatedSlackApp(appId: string, target: SlackTarget, interaction: SetupInteraction): Promise<void> {
  const client = slackClient(string(await interaction.password({ message: '削除対象アプリを管理できる Slack configuration token:', mask: '*' })), undefined, 30_000);
  try {
    const result = await client.apps.manifest.export({ app_id: appId });
    const exported = object(result.manifest);
    requireSlackAppTarget(exported, target);
    const redirects = object(exported.oauth_config).redirect_urls;
    if (!Array.isArray(redirects) || !redirects.includes(target.publicUrl + '/oauth/callback')) throw new AppError('slack_target_mismatch');
  } catch (error) {
    const code = error && typeof error === 'object' && 'data' in error ? object(error.data).error : undefined;
    if (code !== 'app_not_found') throw error;
  }
  if (!await interaction.confirm({ message: `この環境専用の Slack アプリ ${appId} を完全削除します。全インストールが解除されます。続行しますか？`, default: false })) throw new AppError('cancelled');
  const confirmedId = await interaction.input({ message: `対象確認のため ${appId} を入力:` });
  if (confirmedId !== appId) throw new AppError('slack_target_mismatch');
  try { await client.apps.manifest.delete({ app_id: appId }); }
  catch (error) { const code = error && typeof error === 'object' && 'data' in error ? object(error.data).error : undefined; if (code !== 'app_not_found') throw error; }
  process.stdout.write(`Slack アプリ ${appId} を削除しました。\n`);
}
