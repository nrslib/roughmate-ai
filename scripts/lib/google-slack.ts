import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { password, input } from '@inquirer/prompts';
import { ErrorCode, type WebClient } from '@slack/web-api';
import { AppError, object, string, requireInstalledSecrets, type Secrets } from '../../app/src/contracts.js';
import { runtime } from '../../app/src/runtime.js';
import { SecretVersionUnavailableError } from '../../app/src/runtime-ports.js';
import { c, type DocumentInput, type DocumentOperation } from '../../app/src/document-store.js';
import { Storage } from '../../app/src/storage.js';
import { Registrations } from '../../app/src/registration.js';
import { BotMaintenance } from '../../app/src/bot-maintenance.js';
import { ConfigurationAccess } from '../../app/src/configuration-tokens.js';
import { slackClient, requireBotIdentity } from '../../app/src/slack.js';
import { validateName, validateGroup, validateSetupSeed } from '../../app/src/groups.js';
import { stateKey } from '../../app/src/security.js';
export interface GoogleSlackTarget { project: string; projectNumber: string; region: string; environment: string; publicUrl: string; }
type Manifest = Parameters<WebClient['apps']['manifest']['create']>[0]['manifest'];
export function googleSlackMarker(target: GoogleSlackTarget): string { return 'roughmate-google:v1:' + createHash('sha256').update(JSON.stringify([target.project, target.projectNumber, target.region, target.environment, target.publicUrl])).digest('hex'); }
export async function googleRootManifest(target: GoogleSlackTarget, name: string): Promise<Manifest> {
  const raw = object(JSON.parse(await readFile(new URL('../../slack/manifest.json', import.meta.url), 'utf8'))), settings = object(raw.settings), features = object(raw.features);
  return { ...raw, display_information: { ...object(raw.display_information), name: validateName(name), description: `Roughmate AI [${googleSlackMarker(target)}]` }, features: { ...features, bot_user: { ...object(features.bot_user), display_name: `roughmate-${target.environment}` } }, oauth_config: { ...object(raw.oauth_config), redirect_urls: ['/oauth/callback', '/channel-authorization/callback', '/wiki/auth/callback'].map(path => target.publicUrl + path) }, settings: { ...settings, event_subscriptions: { ...object(settings.event_subscriptions), request_url: target.publicUrl + '/slack/events' }, interactivity: { ...object(settings.interactivity), request_url: target.publicUrl + '/slack/interactive' } } } as Manifest;
}
export function requireGoogleRootManifest(value: NonNullable<Awaited<ReturnType<WebClient['apps']['manifest']['export']>>['manifest']>, target: GoogleSlackTarget): void {
  if (!value.display_information?.description?.endsWith(`[${googleSlackMarker(target)}]`)) throw new AppError('slack_target_mismatch');
  const redirects = value.oauth_config?.redirect_urls;
  if (redirects && redirects.some(url => !['/oauth/callback', '/channel-authorization/callback', '/wiki/auth/callback'].some(path => target.publicUrl + path === url))) throw new AppError('slack_target_mismatch');
  for (const [url, path] of [[value.settings?.event_subscriptions?.request_url, '/slack/events'], [value.settings?.interactivity?.request_url, '/slack/interactive']]) if (url && url !== target.publicUrl + path) throw new AppError('slack_target_mismatch');
}
export async function saveRecoveredGoogleRootSecrets(target: GoogleSlackTarget, createOwner: string, value: Secrets): Promise<void> {
  const table = `roughmate-${target.environment}`, secret = `projects/${target.projectNumber}/secrets/${table}-runtime`, store = new Storage(table, secret);
  const progress = await store.get<{ phase: string; createOwner: string; appId?: string }>('setup#slack');
  if (progress?.phase !== 'creating' || progress.createOwner !== createOwner || progress.appId && progress.appId !== value.appId) throw new AppError('root_setup_boundary');
  await runtime().secrets().write({ id: secret, operationId: createOwner, value: JSON.stringify(value) });
}
export async function setupGoogleSlack(target: GoogleSlackTarget, name: string, recoverAppId?: string): Promise<void> {
  const table = `roughmate-${target.environment}`, secret = `projects/${target.projectNumber}/secrets/${table}-runtime`, store = new Storage(table, secret);
  const progress = await store.get<{ pk: string; phase: string; createOwner: string; appId?: string; oauthAttempt?: string; scopeExcess?: boolean }>('setup#slack');
  if (progress?.scopeExcess || progress && !['creating', 'created'].includes(progress.phase)) throw new AppError('root_setup_boundary');
  const fullManifest = await googleRootManifest(target, name);
  let value: Secrets;
  if (!progress || progress.phase === 'creating') {
    const token = string(await password({ message: 'Slack App Configuration access token:', mask: '*' })), client = slackClient(token, undefined, 30000);
    let owner = progress?.createOwner;
    if (!progress) {
      const apiKey = string(await password({ message: 'OpenAI API key:', mask: '*' }));
      owner = randomUUID();
      if (!await store.create({ pk: 'setup#slack', phase: 'creating', createOwner: owner })) throw new AppError('slack_creation_ambiguous');
      const result = await client.apps.manifest.create({ manifest: { display_information: fullManifest.display_information, features: fullManifest.features, oauth_config: { scopes: fullManifest.oauth_config?.scopes } } });
      if (result.ok !== true || 'error' in result) throw new AppError('slack_creation_ambiguous');
      const credentials = object(result.credentials);
      value = { appId: string(result.app_id), clientId: string(credentials.client_id), clientSecret: string(credentials.client_secret), signingSecret: string(credentials.signing_secret), apiKey, model: 'gpt-6-luna' };
      await runtime().secrets().write({ id: secret, operationId: owner, value: JSON.stringify(value) });
    } else {
      try { value = JSON.parse(await runtime().secrets().read({ id: secret, version: string(owner) })) as Secrets; }
      catch (error) {
        if (!recoverAppId || !(error instanceof SecretVersionUnavailableError) || error.outcome === 'unknown') throw new AppError('slack_creation_ambiguous');
        const exported = await client.apps.manifest.export({ app_id: recoverAppId });
        if (exported.ok !== true || !exported.manifest) throw new AppError('slack_target_mismatch');
        requireGoogleRootManifest(exported.manifest, target);
        value = { appId: recoverAppId, clientId: string(await input({ message: '既存AppのClient ID:' })), clientSecret: string(await password({ message: '既存AppのClient secret:', mask: '*' })), signingSecret: string(await password({ message: '既存AppのSigning secret:', mask: '*' })), apiKey: string(await password({ message: 'OpenAI API key:', mask: '*' })), model: 'gpt-6-luna' };
        await saveRecoveredGoogleRootSecrets(target, string(owner), value);
      }
    }
    const exported = await client.apps.manifest.export({ app_id: value.appId });
    if (exported.ok !== true || !exported.manifest) throw new AppError('slack_target_mismatch');
    requireGoogleRootManifest(exported.manifest, target);
    await store.create({ pk: 'roughmate#setup', appId: value.appId, name, description: '' });
    const changed = await client.apps.manifest.update({ app_id: value.appId, manifest: fullManifest });
    if (changed.ok !== true || changed.app_id !== value.appId) throw new AppError('slack_target_mismatch');
    await runtime().documents().update({ namespace: table, key: { pk: 'setup#slack' }, changes: [c.set('phase', ':phase'), c.set('appId', ':app')], condition: c.all(c.compare('phase', '=', ':creating'), c.compare('createOwner', '=', ':owner')), parameters: { ':phase': 'created', ':app': value.appId, ':creating': 'creating', ':owner': owner } });
  } else value = await store.readSecrets();
  if (progress?.appId && progress.appId !== value.appId) throw new AppError('slack_target_mismatch');
  let workspace: { teamId: string; ownerId: string } | undefined;
  try { workspace = await store.workspace(); } catch (error) { if (!(error instanceof AppError) || error.code !== 'not_installed') throw error; }
  if (progress?.oauthAttempt) {
    value = await store.resumeRootOAuthSecrets(value, progress.oauthAttempt);
    workspace = await store.workspace();
    const receipt = value.rootOAuth;
    if (!workspace || !receipt || receipt.requestId !== progress.oauthAttempt || receipt.teamId !== workspace.teamId || receipt.ownerId !== workspace.ownerId) throw new AppError('root_oauth_pending');
    const installed = requireInstalledSecrets(value); await requireBotIdentity(slackClient(installed.botToken), workspace.teamId, installed.botUserId);
    if (!await store.get('roughmate')) { const seed = validateSetupSeed(await store.get('roughmate#setup')); await store.initializeGroup(validateGroup({ pk: 'roughmate', environmentId: secret, appId: value.appId, teamId: workspace.teamId, version: 1, name: seed.name, description: seed.description, adminIds: [workspace.ownerId], notifyUserIds: [], intakeChannelIds: [] })); }
    await store.finishRootOAuth(value.appId, progress.oauthAttempt);
    process.stdout.write('保存済みOAuthの結果を復旧しました。\n'); return;
  }
  const state = randomBytes(32).toString('base64url');
  if (!await store.create({ pk: stateKey(state), expiresAt: Math.floor(Date.now() / 1000) + 900, ...workspace })) throw new AppError('invalid_state');
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.search = new URLSearchParams({ client_id: value.clientId, scope: fullManifest.oauth_config!.scopes!.bot!.join(','), redirect_uri: target.publicUrl + '/oauth/callback', state, ...(workspace ? { team: workspace.teamId } : {}) }).toString();
  process.stdout.write('次のURLを登録者本人のSlackアカウントで開いてください。URLは保存・共有しないでください。\n' + url.href + '\n');
}
function absentApp(error: unknown): boolean { const value = error as { code?: string; data?: { ok?: boolean; error?: string } }; return value?.code === ErrorCode.PlatformError && value.data?.ok === false && value.data.error === 'app_not_found'; }
interface RootRemoval {
  pk: 'google#root-removal'; schemaVersion: 1; targetMarker: string; environmentId: string;
  appId: string; teamId: string; ownerId: string; stopId: string; stoppedAt: number; configVersion: number;
  phase: 'stopping' | 'unknown' | 'deleted'; notBefore: number; deletedAt?: number;
}
function requireRootRemoval(value: RootRemoval, target: GoogleSlackTarget, secret: string): void {
  if (value.pk !== 'google#root-removal' || value.schemaVersion !== 1 || value.targetMarker !== googleSlackMarker(target) || value.environmentId !== secret || !/^A[A-Z0-9]+$/.test(value.appId) || !/^T[A-Z0-9]+$/.test(value.teamId) || !/^[UW][A-Z0-9]+$/.test(value.ownerId) || !/^[a-f0-9]{32}$/.test(value.stopId) || !Number.isSafeInteger(value.stoppedAt) || value.stoppedAt < 0 || !Number.isSafeInteger(value.configVersion) || value.configVersion < 1 || !['stopping', 'unknown', 'deleted'].includes(value.phase) || !Number.isSafeInteger(value.notBefore) || value.notBefore < value.stoppedAt + 150) throw new AppError('root_removal_boundary');
  if (value.phase === 'deleted' ? !Number.isSafeInteger(value.deletedAt) || value.deletedAt! < value.stoppedAt + 150 || value.deletedAt! > Math.floor(Date.now() / 1000) : value.deletedAt !== undefined) throw new AppError('root_removal_boundary');
}
function removalGuard(table: string, removal: RootRemoval): DocumentInput {
  return { namespace: table, key: { pk: removal.pk }, condition: c.all(c.compare('schemaVersion', '=', ':schema'), c.compare('targetMarker', '=', ':marker'), c.compare('environmentId', '=', ':env'), c.compare('appId', '=', ':app'), c.compare('teamId', '=', ':team'), c.compare('ownerId', '=', ':owner'), c.compare('stopId', '=', ':stop'), c.compare('stoppedAt', '=', ':stopped'), c.compare('configVersion', '=', ':version'), c.compare('phase', '=', ':phase'), c.compare('notBefore', '=', ':after'), removal.deletedAt === undefined ? c.absent('deletedAt') : c.compare('deletedAt', '=', ':deletedAt')), parameters: { ':schema': removal.schemaVersion, ':marker': removal.targetMarker, ':env': removal.environmentId, ':app': removal.appId, ':team': removal.teamId, ':owner': removal.ownerId, ':stop': removal.stopId, ':stopped': removal.stoppedAt, ':version': removal.configVersion, ':phase': removal.phase, ':after': removal.notBefore, ...(removal.deletedAt === undefined ? {} : { ':deletedAt': removal.deletedAt }) } };
}
async function removalBoundaryChecks(registrations: Registrations, removal: RootRemoval): Promise<DocumentOperation[]> {
  const workspace = await registrations.root.workspace(), group = await registrations.root.group(removal), registry = await registrations.read(), now = Math.floor(Date.now() / 1000);
  if (workspace.teamId !== removal.teamId || workspace.ownerId !== removal.ownerId || group.version !== removal.configVersion || group.lifecycle !== 'stopping' || group.stopId !== removal.stopId || group.stoppedAt !== removal.stoppedAt || group.publicationOwner || group.postingUntil !== undefined && group.postingUntil > now || registry.version < 1 || !registry.deleting || registry.entries.length) throw new AppError('root_removal_boundary');
  const namespace = registrations.parentTable;
  return [
    { check: { namespace, key: { pk: 'workspace' }, condition: c.all(c.compare('teamId', '=', ':team'), c.compare('ownerId', '=', ':owner')), parameters: { ':team': removal.teamId, ':owner': removal.ownerId } } },
    { check: { namespace, key: { pk: 'roughmate' }, condition: c.all(c.compare('version', '=', ':version'), c.compare('environmentId', '=', ':env'), c.compare('appId', '=', ':app'), c.compare('teamId', '=', ':team'), c.compare('lifecycle', '=', ':phase'), c.compare('stopId', '=', ':stop'), c.compare('stoppedAt', '=', ':stopped'), c.absent('publicationOwner'), c.group(c.any(c.absent('postingUntil'), c.compare('postingUntil', '<=', ':now')))), parameters: { ':version': removal.configVersion, ':env': removal.environmentId, ':app': removal.appId, ':team': removal.teamId, ':phase': 'stopping', ':stop': removal.stopId, ':stopped': removal.stoppedAt, ':now': now } } },
    { check: { namespace, key: { pk: 'registrations' }, condition: c.all(c.compare('parentSecret', '=', ':env'), c.compare('deleting', '=', ':deleting'), c.compare('entries', '=', ':empty')), parameters: { ':env': removal.environmentId, ':deleting': true, ':empty': [] } } }
  ];
}
export async function removeGoogleSlack(target: GoogleSlackTarget): Promise<boolean> {
  const table = `roughmate-${target.environment}`, secret = `projects/${target.projectNumber}/secrets/${table}-runtime`, registrations = new Registrations(table, secret), store = registrations.root;
  const previousRemoval = await store.get<RootRemoval>('google#root-removal');
  if (previousRemoval) {
    requireRootRemoval(previousRemoval, target, secret);
    const checks = await removalBoundaryChecks(registrations, previousRemoval);
    await runtime().documents().transaction({ operations: [...checks, { check: removalGuard(table, previousRemoval) }] });
    if (previousRemoval.phase === 'deleted') return true;
  }
  const workspace = await store.workspace(), root = requireInstalledSecrets(await store.readSecrets());
  if (previousRemoval && (root.appId !== previousRemoval.appId || workspace.teamId !== previousRemoval.teamId || workspace.ownerId !== previousRemoval.ownerId)) throw new AppError('root_removal_boundary');
  if (previousRemoval?.phase !== 'unknown') await requireBotIdentity(slackClient(root.botToken), workspace.teamId, root.botUserId);
  const access = new ConfigurationAccess(store, table, `projects/${target.projectNumber}/secrets/${table}-configuration`), client = slackClient(await access.token(false), undefined, 30000), maintenance = new BotMaintenance(registrations);
  const registry = await registrations.read();
  process.stdout.write(`削除対象: project=${target.project} region=${target.region} env=${target.environment} Root=${root.appId} 子App=${registry.entries.map(entry => entry.appId ?? entry.id).join(',')}\n`);
  for (const entry of registry.entries) {
    if (!entry.deletion) { const view = await maintenance.confirmation(entry.id, workspace.ownerId, root.appId); await maintenance.accept(string(view.private_metadata), workspace.ownerId, workspace.teamId, root.appId); }
    try { await maintenance.process(entry.id, workspace.ownerId, workspace.teamId, root.appId, client); }
    catch (error) { if (!(error instanceof AppError) || !['bot_deletion_waiting', 'bot_delete_unknown', 'answer_reconciliation_required'].includes(error.code)) throw error; process.stdout.write(`${entry.id}: ${error.code}\n`); }
  }
  const latest = await registrations.read();
  if (latest.entries.length) { process.stdout.write('子Botの停止・削除確認が進行中です。150秒後以降に再実行してください。未知結果の削除は再送しません。\n'); return false; }
  const removal = await store.get<RootRemoval>('google#root-removal');
  if (removal) requireRootRemoval(removal, target, secret);
  if (removal?.appId && removal.appId !== root.appId) throw new AppError('slack_target_mismatch');
  if (removal?.phase === 'deleted') {
    await runtime().documents().transaction({ operations: [...await removalBoundaryChecks(registrations, removal), { check: removalGuard(table, removal) }] });
    return true;
  }
  if (!removal) {
    const group = await store.group({ environmentId: secret, appId: root.appId, teamId: workspace.teamId });
    if (group.publicationOwner || group.postingUntil !== undefined && group.postingUntil > Math.floor(Date.now() / 1000)) throw new AppError('answer_reconciliation_required');
    const stoppedAt = Math.floor(Date.now() / 1000), stopId = randomBytes(16).toString('hex');
    const intent: RootRemoval = { pk: 'google#root-removal', schemaVersion: 1, targetMarker: googleSlackMarker(target), environmentId: secret, appId: root.appId, teamId: workspace.teamId, ownerId: workspace.ownerId, stopId, stoppedAt, configVersion: group.version, phase: 'stopping', notBefore: stoppedAt + 150 };
    await runtime().documents().transaction({ operations: [
      { check: { namespace: table, key: { pk: 'workspace' }, condition: c.all(c.compare('teamId', '=', ':team'), c.compare('ownerId', '=', ':owner')), parameters: { ':team': workspace.teamId, ':owner': workspace.ownerId } } },
      { put: { namespace: table, item: { ...latest, version: latest.version + 1, deleting: true }, condition: latest.version === 0 ? c.absent('pk') : c.all(c.compare('version', '=', ':v'), c.compare('parentSecret', '=', ':parent')), ...(latest.version ? { parameters: { ':v': latest.version, ':parent': secret } } : {}) } },
      { update: { namespace: table, key: { pk: 'roughmate' }, condition: c.all(c.compare('version', '=', ':v'), c.compare('environmentId', '=', ':env'), c.compare('appId', '=', ':app'), c.compare('teamId', '=', ':team'), c.absent('lifecycle'), c.absent('publicationOwner'), c.group(c.any(c.absent('postingUntil'), c.compare('postingUntil', '<=', ':now')))), changes: [c.set('lifecycle', ':stop'), c.set('stopId', ':id'), c.set('stoppedAt', ':now')], parameters: { ':v': group.version, ':env': secret, ':app': root.appId, ':team': workspace.teamId, ':stop': 'stopping', ':id': stopId, ':now': stoppedAt } } },
      { put: { namespace: table, item: intent, condition: c.absent('pk') } }
    ] });
    process.stdout.write('登録窓口を停止しました。150秒後以降に再実行してください。\n'); return false;
  }
  if (removal.notBefore > Math.floor(Date.now() / 1000)) return false;
  const exists = async () => {
    try { const result = await client.apps.manifest.export({ app_id: root.appId }); if (result.ok !== true || !result.manifest) throw new AppError('root_delete_unknown'); requireGoogleRootManifest(result.manifest, target); return true; }
    catch (error) { if (absentApp(error)) return false; throw error; }
  };
  if (removal.phase === 'stopping') {
    if (await exists()) {
      const guard = removalGuard(table, removal);
      await runtime().documents().update({ ...guard, changes: [c.set('phase', ':unknown'), c.set('notBefore', ':nextAfter')], parameters: { ...guard.parameters, ':unknown': 'unknown', ':nextAfter': Math.floor(Date.now() / 1000) + 90 } });
      const result = await client.apps.manifest.delete({ app_id: root.appId }); if (result.ok !== true || 'error' in result) throw new AppError('root_delete_unknown');
    }
  }
  if (await exists()) throw new AppError('root_delete_unknown');
  const completed = await store.get<RootRemoval>(removal.pk);
  if (!completed) throw new AppError('root_removal_boundary');
  requireRootRemoval(completed, target, secret);
  const guard = removalGuard(table, completed);
  await runtime().documents().transaction({ operations: [
    ...await removalBoundaryChecks(registrations, completed),
    { update: { ...guard, changes: [c.set('phase', ':deleted'), c.set('deletedAt', ':completed')], parameters: { ...guard.parameters, ':deleted': 'deleted', ':completed': Math.floor(Date.now() / 1000) } } }
  ] });
  process.stdout.write('専用Slack Appと登録窓口Appの不存在を確認しました。Wiki/回答アーカイブは保持します。\n'); return true;
}
