import { runtime } from './runtime.js';
import { enqueueArchiveRetention } from './wiki-queue.js';
import { BotMaintenance } from './bot-maintenance.js';
import { invitationScopes } from './channel-authorization.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { ErrorCode } from '@slack/web-api';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { AppError, env, object, string, type Secrets } from './contracts.js';
import { diagnosticCode } from './diagnostics.js';
import { Registrations, childResources, configurationKey, type Registry, type Registration } from './registration.js';
import { ConfigurationAccess } from './configuration-tokens.js';
import { RequestDeadline } from './deadline.js';
import { Storage } from './storage.js';
import { slackClient, botScopes } from './slack.js';
type Manifest = Parameters<ReturnType<typeof slackClient>['apps']['manifest']['create']>[0]['manifest'];
import { stateKey } from './security.js';
import { validateGroup } from './groups.js';

export const childScopes: NonNullable<NonNullable<NonNullable<Manifest['oauth_config']>['scopes']>['bot']> = [...botScopes];
export function childManifest(entry: Registration, publicUrl: string, connected: boolean): Manifest {
  const base = `${publicUrl}/bots/${entry.id}`;
  let description = '';
  for (const character of entry.description) {
    if (Buffer.byteLength(description + character, 'utf8') > 140) break;
    description += character;
  }
  return { display_information: { name: entry.name, description: description || '専用知識で回答案を作るRoughmate', long_description: `This application is a dedicated Roughmate consultation bot. Its knowledge, settings and Slack credentials are stored separately from the registration service and other bots. Registration: ${base}`, background_color: '#23344a' },
    features: { bot_user: { display_name: entry.botName, always_online: false }, app_home: { home_tab_enabled: true, messages_tab_enabled: false } },
    oauth_config: { scopes: { bot: childScopes, user: invitationScopes }, ...(connected ? { redirect_urls: [`${base}/oauth/callback`, `${base}/channel-authorization/callback`] } : {}) },
    ...(connected ? { settings: { event_subscriptions: { request_url: `${base}/slack/events`, bot_events: ['app_mention','app_home_opened'] }, interactivity: { is_enabled: true, request_url: `${base}/slack/interactive` }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false } } : {}) };
}
const secrets = runtime().secrets();
const queue = runtime().queue();
export const OAUTH_CALLBACK_BUDGET_MS = 8500;
const callbackSecrets = runtime().secrets();
const callbackQueue = runtime().queue();
async function patch(registrations: Registrations, registry: Registry, entry: Registration, changes: Partial<Registration>, clear: (keyof Registration)[] = []): Promise<Registry> {
  return registrations.save(registry, registry.entries.map(item => {
    if (item.id !== entry.id) return item;
    const next = { ...item, ...changes };
    for (const key of clear) delete next[key];
    return next;
  }));
}
interface FailureProof { kind: 'create_rate_limited' | 'create_rejected' | 'oauth_rejected'; id: string; owner: string; actor: string; teamId: string; parentAppId: string; expiresAt: number; failureCode: string; retryAt: number; }
const createRejections = ['invalid_manifest','invalid_auth','not_allowed_token_type','not_in_team','missing_scope','token_expired','no_permission'];
function createRejection(error: unknown): string | undefined {
  const value = error as { code?: string; data?: Record<string, unknown> };
  if (value?.code !== ErrorCode.PlatformError || value.data?.ok !== false || 'app_id' in value.data || 'credentials' in value.data) return undefined;
  return createRejections.includes(String(value.data.error)) ? `slack_${String(value.data.error)}` : undefined;
}
function rateLimitUntil(error: unknown): number | undefined {
  const value = error as { code?: string; retryAfter?: number; data?: { ok?: boolean; error?: string; response_metadata?: { retryAfter?: number } } };
  const seconds = value?.code === ErrorCode.RateLimitedError ? value.retryAfter : value?.code === ErrorCode.PlatformError && value.data?.ok === false && value.data.error === 'ratelimited' ? value.data.response_metadata?.retryAfter : undefined;
  const retryAt = Math.floor(Date.now()/1000) + Number(seconds);
  return Number.isSafeInteger(seconds) && seconds! >= 0 && Number.isSafeInteger(retryAt) && Number.isFinite(new Date(retryAt*1000).getTime()) ? retryAt : undefined;
}
function oauthRejection(error: unknown): string | undefined {
  const value = error as { code?: string; data?: Record<string, unknown> };
  if (value?.code !== ErrorCode.PlatformError || value.data?.ok !== false || value.data.access_token || value.data.refresh_token) return undefined;
  return ['invalid_code','bad_client_secret','bad_redirect_uri','invalid_client_id','invalid_code_verifier','invalid_grant_type'].includes(String(value.data.error)) ? String(value.data.error) : undefined;
}
function failureProof(entry: Registration, owner: string, kind: FailureProof['kind'], failureCode: string, retryAt = 0): FailureProof {
  return { kind, id: entry.id, owner, actor: entry.actor, teamId: entry.teamId, parentAppId: entry.parentAppId, expiresAt: entry.expiresAt, failureCode, retryAt };
}
function checkedProof(raw: unknown, entry: Registration, owner: string, kind: FailureProof['kind']): FailureProof {
  const proof = object(raw);
  if (proof.kind !== kind || proof.id !== entry.id || proof.owner !== owner || proof.actor !== entry.actor || proof.teamId !== entry.teamId || proof.parentAppId !== entry.parentAppId || proof.expiresAt !== entry.expiresAt || !Number.isSafeInteger(proof.retryAt) || Number(proof.retryAt) < 0) throw new AppError('registration_boundary');
  string(proof.failureCode);
  return proof as unknown as FailureProof;
}
export function confirmedCreateFailure(raw: unknown, entry: Registration): FailureProof {
  const value = object(raw), proof = object(value.registrationFailure);
  const checked = checkedProof(proof, entry, string(entry.createOwner), 'create_rejected');
  if (entry.appId || value.appId || value.credentials || proof.appId !== null || proof.secretArn !== entry.secretArn || proof.name !== entry.name || proof.botName !== entry.botName || proof.description !== entry.description || checked.retryAt !== 0 || !createRejections.some(code => `slack_${code}` === checked.failureCode)) throw new AppError('registration_boundary');
  return checked;
}
async function resources(registrations: Registrations, entry: Registration): Promise<string> {
  return runtime().children.ensure(registrations, entry);
}
async function createdSecrets(entry: Registration): Promise<Secrets | FailureProof | undefined> {
  if (!entry.secretArn || !entry.createOwner) throw new AppError('registration_boundary');
  try {
    const result = await secrets.read({ id: string(entry.secretArn), version: entry.createOwner });
    const value = object(JSON.parse(string(result)));
    if (value.registrationFailure) return object(value.registrationFailure).kind === 'create_rejected' ? confirmedCreateFailure(value, entry) : checkedProof(value.registrationFailure, entry, entry.createOwner, 'create_rate_limited');
    for (const field of ['appId','clientId','clientSecret','signingSecret','model','apiKey']) string(value[field]);
    return value as unknown as Secrets;
  } catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined; throw error; }
}
export async function provision(raw: string): Promise<void> {
  const job = object(JSON.parse(raw));
  const registrations = new Registrations(env('TABLE_NAME'), env('SECRET_ARN'));
  const access = new ConfigurationAccess(registrations.root, registrations.parentTable, env('CONFIGURATION_SECRET_ARN'));
  if(job.kind==='delete_bot') {
    const client=slackClient(await access.token(false),undefined,30000);
    await new BotMaintenance(registrations).process(string(job.id),string(job.actor),string(job.teamId),string(job.appId),client);
    return;
  }
  if (job.kind === 'rotate') {
    const pendingHomes = await registrations.read();
    if (pendingHomes.deleting) return;
    for(const entry of pendingHomes.entries.filter(entry=>entry.deletion && entry.deletion.status!=='failed')) await queue.enqueue({destination:env('PROVISION_QUEUE_URL'),body:JSON.stringify({kind:'delete_bot',id:entry.id,actor:entry.actor,teamId:entry.teamId,appId:entry.parentAppId})});
    for (const entry of pendingHomes.entries.filter(item => !item.deletion && (item.homeNotificationPending || item.phase === 'install_wait' && item.installOwner) && (item.phase === 'available' || item.expiresAt > Math.floor(Date.now()/1000)))) await queue.enqueue({ destination: env('PROVISION_QUEUE_URL'), body: JSON.stringify({ kind: 'provision', id: entry.id, actor: entry.actor, teamId: entry.teamId, appId: entry.parentAppId }) });
    const maintenance=new BotMaintenance(registrations),archives=await maintenance.archives(pendingHomes.archiveRetentionCursor);
    for(const archived of archives.items) {
      const resolved=await maintenance.browserBot(archived.entry.id);
      const identity={environmentId:string(archived.entry.secretArn),appId:string(archived.entry.appId),teamId:archived.entry.teamId};
      const step=await resolved.store.wiki.archiveRetentionStep(identity);
      if(step!==undefined) await enqueueArchiveRetention(identity,archived.entry.id,step);
    }
    const latestArchives=await registrations.read();
    if(latestArchives.archiveRetentionCursor===pendingHomes.archiveRetentionCursor && archives.next!==pendingHomes.archiveRetentionCursor) await registrations.save(latestArchives,latestArchives.entries,{archiveRetentionCursor:archives.next});
    const status = await registrations.root.get<{ phase?: string }>(configurationKey);
    if (!status || status.phase === 'disconnected') return;
    await access.token(false);
    const registry = await registrations.read();
    if (registry.deleting) return;
    for (const entry of registry.entries.filter(item => !item.deletion && ['queued','resources','creating','created'].includes(item.phase) && item.expiresAt > Math.floor(Date.now()/1000) && (!item.createRetryAt || item.createRetryAt <= Math.floor(Date.now()/1000)))) await queue.enqueue({ destination: env('PROVISION_QUEUE_URL'), body: JSON.stringify({ kind: 'provision', id: entry.id, actor: entry.actor, teamId: entry.teamId, appId: entry.parentAppId }) });
    return;
  }
  if (job.kind !== 'provision') throw new AppError('invalid_input');
  let registry = await registrations.read();
  if (registry.deleting) throw new AppError('registration_removal_pending');
  let entry = registry.entries.find(item => item.id === job.id);
  const workspace = await registrations.root.workspace(), rootSecrets = await registrations.root.readSecrets();
  if(!entry) {
    const archived=await new BotMaintenance(registrations).archive(string(job.id));
    if(job.actor!==archived.entry.actor || job.teamId!==archived.entry.teamId || job.appId!==archived.entry.parentAppId) throw new AppError('registration_boundary');
    return;
  }
  if (entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== rootSecrets.appId || job.actor !== entry.actor || job.teamId !== entry.teamId || job.appId !== entry.parentAppId) throw new AppError('registration_boundary');
  if(entry.deletion) return;
  if (entry.phase !== 'available' && entry.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('registration_expired');
  if (entry.homeNotificationPending) {
    await notifyRegistrationHomes(registrations, entry.id);
    registry = await registrations.read();
    entry = registry.entries.find(item => item.id === job.id);
    if (registry.deleting || !entry || entry.actor !== job.actor || entry.teamId !== job.teamId || entry.parentAppId !== job.appId) throw new AppError('registration_boundary');
  }
  if (entry.phase === 'install_wait' && entry.installOwner) { await recoverInstall(registrations, entry.id); return; }
  if (entry.phase === 'available') return;
  if (['install_wait','failed'].includes(entry.phase)) return;
  if (entry.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('registration_expired');
  const fail = async (failureCode: string) => {
    await patch(registrations, registry, entry!, { phase: 'failed', failureCode, homeNotificationPending: true });
    await notifyRegistrationHomes(registrations, entry!.id);
  };
  if (entry.phase === 'creating') {
    const recovered = await createdSecrets(entry);
    if (!recovered) return;
    if ('kind' in recovered) {
      if (recovered.kind === 'create_rejected') { await fail(recovered.failureCode); return; }
      if (recovered.retryAt > Math.floor(Date.now()/1000)) {
        if (entry.createRetryAt !== recovered.retryAt) await patch(registrations, registry, entry, { createRetryAt: recovered.retryAt });
        return;
      }
      registry = await patch(registrations, registry, entry, { phase: 'resources' }, ['createOwner','createRetryAt']);
      entry = registry.entries.find(item => item.id === job.id)!;
    }
  }
  const client = slackClient(await access.token(false), undefined, 30_000);
  const validate = async (manifest: Manifest, appId?: string) => {
    try {
      const result = await client.apps.manifest.validate({ manifest, ...(appId ? { app_id: appId } : {}) });
      if ('error' in result) throw new AppError('registration_boundary');
      if (!result.ok || result.errors?.length) { await fail('invalid_manifest'); return false; }
      return true;
    } catch (error) {
      const failure = createRejection(error);
      if (failure) { await fail(failure); return false; }
      throw error;
    }
  };
  if (entry.phase === 'queued') {
    const secretArn = await resources(registrations, entry);
    registry = await patch(registrations, registry, entry, { secretArn, phase: 'resources' });
    entry = registry.entries.find(item => item.id === job.id)!;
  }
  if (entry.phase === 'resources') {
    const manifest = childManifest(entry, env('PUBLIC_URL'), false);
    if (!await validate(manifest)) return;
    const createOwner = randomUUID();
    registry = await patch(registrations, registry, entry, { phase: 'creating', createOwner });
    entry = registry.entries.find(item => item.id === job.id)!;
    let result;
    try { result = await client.apps.manifest.create({ manifest }); }
    catch (error) {
      const retryAt = rateLimitUntil(error);
      if (retryAt) {
        await secrets.write({ id: string(entry.secretArn), operationId: createOwner, value: JSON.stringify({ registrationFailure: failureProof(entry, createOwner, 'create_rate_limited', 'ratelimited', retryAt) }) });
        await patch(registrations, registry, entry, { createRetryAt: retryAt });
        return;
      }
      const failure = createRejection(error);
      if (failure) {
        const proof = { ...failureProof(entry, createOwner, 'create_rejected', failure), appId: null, secretArn: entry.secretArn, name: entry.name, botName: entry.botName, description: entry.description };
        await secrets.write({ id: string(entry.secretArn), operationId: createOwner, value: JSON.stringify({ registrationFailure: proof }) });
        await fail(failure);
        return;
      }
      throw error;
    }
    if (result.ok !== true || 'error' in result) throw new AppError('registration_boundary');
    const credentials = object(result.credentials);
    const root = await registrations.root.readSecrets();
    const value: Secrets = { appId: string(result.app_id), clientId: string(credentials.client_id), clientSecret: string(credentials.client_secret), signingSecret: string(credentials.signing_secret), apiKey: root.apiKey, model: root.model };
    await secrets.write({ id: string(entry.secretArn), operationId: createOwner, value: JSON.stringify(value) });
  }
  if (entry.phase === 'creating') {
    const recovered = await createdSecrets(entry);
    if (!recovered) return;
    if ('kind' in recovered) throw new AppError('registration_boundary');
    if (recovered.appId === rootSecrets.appId || !/^A[A-Z0-9]+$/.test(recovered.appId) || registry.entries.some(item => item.id !== entry!.id && item.appId === recovered.appId)) throw new AppError('registration_boundary');
    registry = await patch(registrations, registry, entry, { phase: 'created', appId: recovered.appId, credentialVersion: string(entry.createOwner) });
    entry = registry.entries.find(item => item.id === job.id)!;
  }
  if (entry.phase === 'created') {
    const manifest = childManifest(entry, env('PUBLIC_URL'), true);
    if (!await validate(manifest, string(entry.appId))) return;
    const updated = await client.apps.manifest.update({ app_id: string(entry.appId), manifest });
    if (updated.app_id !== entry.appId) throw new AppError('registration_boundary');
    const child = new Storage(childResources(registrations.parentTable, registrations.parentSecret, entry.id).tableName, string(entry.secretArn));
    await child.create({ pk: 'roughmate#setup', appId: entry.appId, name: entry.name, description: entry.description });
    await patch(registrations, registry, entry, { phase: 'install_wait', homeNotificationPending: true });
    await notifyRegistrationHomes(registrations, entry.id);
  }
}
export async function beginInstall(registrations: Registrations, id: string, actor: string, deadline?: RequestDeadline): Promise<string> {
  const workspace = await registrations.root.workspace();
  if (workspace.ownerId !== actor) throw new AppError('forbidden');
  const registry = await registrations.read();
  const entry = registry.entries.find(item => item.id === id);
  if (entry?.failureCode === 'oauth_scope_excess') throw new AppError('oauth_scope_excess');
  if (registry.deleting || !entry || entry.deletion || entry.phase !== 'install_wait' || entry.actor !== actor || entry.teamId !== workspace.teamId || entry.installOwner || entry.expiresAt <= Math.floor(Date.now()/1000) || entry.oauthRetryAt && entry.oauthRetryAt > Math.floor(Date.now()/1000)) throw new AppError('invalid_state');
  const { store } = await registrations.child(id, false);
  const value = await store.readSecrets();
  await registrations.requireRootBotIdentity(workspace, entry.parentAppId, await registrations.root.readSecrets(), deadline);
  const state = randomBytes(32).toString('base64url');
  await patch(registrations, registry, entry, { oauthState: stateKey(state), oauthExpiresAt: Math.floor(Date.now()/1000)+900 }, ['failureCode','oauthRetryAt']);
  const authorize = new URL('https://slack.com/oauth/v2/authorize');
  authorize.search = new URLSearchParams({ client_id: value.clientId, scope: childScopes.join(','), redirect_uri: `${env('PUBLIC_URL')}/bots/${id}/oauth/callback`, state, team: workspace.teamId }).toString();
  return authorize.href;
}
async function finishInstall(registrations: Registrations, registry: Registry, entry: Registration, store: Storage, installed: Secrets): Promise<void> {
  if (installed.appId !== entry.appId || !installed.botScopes || childScopes.some(scope => !installed.botScopes!.includes(scope)) || installed.botScopes.some(scope => !childScopes.some(expected => expected === scope))) throw new AppError('registration_boundary');
  const auth = await slackClient(string(installed.botToken)).auth.test();
  if (auth.team_id !== entry.teamId || auth.user_id !== installed.botUserId) throw new AppError('registration_boundary');
  await store.install({ teamId: entry.teamId, ownerId: entry.actor });
  const group = validateGroup({ pk: 'roughmate', environmentId: entry.secretArn, appId: entry.appId, teamId: entry.teamId, version: 1, name: entry.name, description: entry.description, adminIds: [entry.actor], notifyUserIds: [], intakeChannelIds: [] });
  const current = await store.get('roughmate');
  if (!current) await store.initializeGroup(group);
  else {
    const checked = validateGroup(current);
    if (checked.environmentId !== group.environmentId || checked.appId !== group.appId || checked.teamId !== group.teamId) throw new AppError('registration_boundary');
    await store.manualKnowledge(group);
  }
  await patch(registrations, registry, entry, { phase: 'available', credentialVersion: string(entry.installOwner), homeNotificationPending: true });
  try { await notifyRegistrationHomes(registrations, entry.id); }
  catch (error) { process.stderr.write(JSON.stringify({ event: 'roughmate_install_home_pending', code: diagnosticCode(error) })+'\n'); }

}
async function notifyRegistrationHomes(registrations: Registrations, id: string): Promise<void> {
  const registry = await registrations.read();
  if (registry.deleting) throw new AppError('registration_removal_pending');
  const entry = registry.entries.find(item => item.id === id);
  const workspace = await registrations.root.workspace(), root = await registrations.root.readSecrets();
  if (!entry || entry.deletion || entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== root.appId || entry.phase !== 'available' && entry.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('registration_boundary');
  if (!entry.homeNotificationPending) return;
  if (entry.phase === 'available') await registrations.child(id, true);
  for (const job of [
    ...(entry.phase === 'available' ? [{ kind: 'home', botId: entry.id, payload: { environmentId: entry.secretArn, appId: entry.appId, teamId: entry.teamId, userId: entry.actor } }] : []),
    { kind: 'home', payload: { environmentId: registrations.parentSecret, appId: entry.parentAppId, teamId: entry.teamId, userId: entry.actor } }
  ]) await queue.enqueue({ destination: env('QUEUE_URL'), body: JSON.stringify(job) });
  await patch(registrations, registry, entry, {}, ['homeNotificationPending']);
}
async function recoverInstall(registrations: Registrations, id: string): Promise<'available' | 'rejected'> {
  const registry = await registrations.read();
  const { entry, store } = await registrations.child(id, false);
  if (entry.phase !== 'install_wait' || !entry.installOwner || entry.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('invalid_state');
  let saved;
  try { saved = await secrets.read({ id: string(entry.secretArn), version: entry.installOwner }); }
  catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') throw new AppError('oauth_install_unknown'); throw error; }
  const value = object(JSON.parse(string(saved)));
  if (value.registrationFailure) {
    const proof = checkedProof(value.registrationFailure, entry, entry.installOwner, 'oauth_rejected');
    await patch(registrations, registry, entry, { failureCode: proof.failureCode, oauthRetryAt: proof.retryAt, homeNotificationPending: true }, ['installOwner','oauthState','oauthExpiresAt']);
    await notifyRegistrationHomes(registrations, entry.id);
    return 'rejected';
  }
  const installed = value as unknown as Secrets;
  await finishInstall(registrations, registry, entry, store, installed);
  return 'available';
}
export async function installChild(registrations: Registrations, id: string, state: string, response: string | { error: 'access_denied' }, deadline = new RequestDeadline(Date.now()+OAUTH_CALLBACK_BUDGET_MS)): Promise<'processing'> {
  return deadline.run<'processing'>(async () => {
    let registry = await deadline.step(() => registrations.read());
    const entry = registry.entries.find(item => item.id === id);
    const workspace = await deadline.step(() => registrations.root.workspace());
    const rootSecrets = await deadline.step(() => registrations.root.readSecrets());
    if (registry.deleting || !entry || entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || entry.parentAppId !== rootSecrets.appId || entry.phase !== 'install_wait' || !entry.appId || !entry.secretArn || entry.expiresAt <= Math.floor(Date.now()/1000) || entry.oauthState !== stateKey(state) || !entry.oauthExpiresAt || entry.oauthExpiresAt <= Math.floor(Date.now()/1000)) throw new AppError('invalid_state');
    if (typeof response !== 'string') {
      if (response.error !== 'access_denied' || entry.installOwner) throw new AppError('invalid_state');
      await deadline.step(() => patch(registrations, registry, entry, { failureCode: 'access_denied', homeNotificationPending: true }, ['oauthState','oauthExpiresAt']));
      try { await deadline.step(() => callbackQueue.enqueue({ destination: env('PROVISION_QUEUE_URL'), body: JSON.stringify({ kind: 'provision', id: entry.id, actor: entry.actor, teamId: entry.teamId, appId: entry.parentAppId }) }, { abortSignal: deadline.signal })); }
      catch (error) { process.stderr.write(JSON.stringify({ event: 'roughmate_denied_home_pending', code: diagnosticCode(error) })+'\n'); }
      throw new AppError('oauth_rejected');
    }
    const code = string(response);
    let installOwner = entry.installOwner;
    const enqueue = async () => {
      const latest = await deadline.step(() => registrations.read());
      const current = latest.entries.find(item => item.id === id);
      if (latest.deleting || !current || current.installOwner !== installOwner || current.oauthState !== stateKey(state) || !current.oauthExpiresAt || current.oauthExpiresAt <= Math.floor(Date.now()/1000) || current.actor !== entry.actor || current.teamId !== entry.teamId || current.parentAppId !== entry.parentAppId || current.appId !== entry.appId || current.secretArn !== entry.secretArn || !['install_wait','available'].includes(current.phase)) throw new AppError('invalid_state');
      await deadline.step(() => callbackQueue.enqueue({ destination: env('PROVISION_QUEUE_URL'), body: JSON.stringify({ kind: 'provision', id: entry.id, actor: entry.actor, teamId: entry.teamId, appId: entry.parentAppId }) }, { abortSignal: deadline.signal }));
    };
    const reject = async (proof: FailureProof) => {
      await deadline.step(() => patch(registrations, registry, entry, { failureCode: proof.failureCode, oauthRetryAt: proof.retryAt, homeNotificationPending: true }, ['installOwner','oauthState','oauthExpiresAt']));
      throw new AppError(proof.failureCode === 'oauth_scope_excess' ? 'oauth_scope_excess' : 'oauth_rejected');
    };
    if (entry.installOwner) {
      let saved;
      try { saved = await deadline.step(() => callbackSecrets.read({ id: string(entry.secretArn), version: entry.installOwner }, { abortSignal: deadline.signal })); }
      catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') throw new AppError('oauth_install_unknown'); throw error; }
      const value = object(JSON.parse(string(saved)));
      if (value.registrationFailure) await reject(checkedProof(value.registrationFailure, entry, entry.installOwner, 'oauth_rejected'));
      if (value.appId !== entry.appId || !value.botToken || !value.botUserId) throw new AppError('registration_boundary');
      await enqueue();
      return 'processing';
    }
    const store = new Storage(childResources(registrations.parentTable, registrations.parentSecret, id).tableName, entry.secretArn, deadline.signal, undefined, entry.credentialVersion);
    const value = await deadline.step(() => store.readSecrets());
    if (value.appId !== entry.appId) throw new AppError('registration_boundary');
    // intent/資格情報/台帳再検査/queue各900ms、交換1800msと応答の余裕を残す。
    deadline.requireRemaining(5500);
    installOwner = randomUUID();
    registry = await deadline.step(() => patch(registrations, registry, entry, { installOwner }));
    let result;
    try { result = await deadline.step(() => slackClient(undefined, deadline.signal, 1800).oauth.v2.access({ client_id: value.clientId, client_secret: value.clientSecret, code, redirect_uri: `${env('PUBLIC_URL')}/bots/${id}/oauth/callback` })); }
    catch (error) {
      const rejected = oauthRejection(error), retryAt = rateLimitUntil(error);
      if (!rejected && !retryAt) throw new AppError('oauth_install_unknown');
      const proof = failureProof(entry, installOwner, 'oauth_rejected', rejected ?? 'ratelimited', retryAt ?? 0);
      await deadline.step(() => callbackSecrets.write({ id: string(entry.secretArn), operationId: installOwner, value: JSON.stringify({ ...value, registrationFailure: proof }) }, { abortSignal: deadline.signal }));
      await reject(proof);
    }
    if (!result || result.ok !== true || 'error' in result || result.is_enterprise_install !== undefined && typeof result.is_enterprise_install !== 'boolean') throw new AppError('oauth_install_unknown');
    if (typeof result.app_id !== 'string' || !result.app_id.trim() || typeof result.team?.id !== 'string' || !result.team.id.trim() || typeof result.authed_user?.id !== 'string' || !result.authed_user.id.trim() || typeof result.bot_user_id !== 'string' || !result.bot_user_id.trim() || typeof result.access_token !== 'string' || !result.access_token.trim() || typeof result.scope !== 'string' || !result.scope.trim() || result.expires_in !== undefined && (!Number.isSafeInteger(result.expires_in) || result.expires_in <= 0)) throw new AppError('oauth_install_unknown');
    const mismatch = result.app_id !== entry.appId ? 'oauth_app_mismatch' : result.team.id !== entry.teamId || result.is_enterprise_install ? 'oauth_workspace_mismatch' : result.authed_user.id !== entry.actor ? 'oauth_actor_mismatch' : undefined;
    if (mismatch) {
      const proof = failureProof(entry, installOwner, 'oauth_rejected', mismatch);
      await deadline.step(() => callbackSecrets.write({ id: string(entry.secretArn), operationId: installOwner, value: JSON.stringify({ ...value, registrationFailure: proof }) }, { abortSignal: deadline.signal }));
      await reject(proof);
    }
    const scopes = string(result.scope).split(',');
    if (childScopes.some(scope => !scopes.includes(scope)) || scopes.some(scope => !childScopes.some(expected => expected === scope))) {
      const proof = failureProof(entry, installOwner, 'oauth_rejected', scopes.some(scope => !childScopes.some(expected => expected === scope)) ? 'oauth_scope_excess' : 'oauth_scope_mismatch');
      await deadline.step(() => callbackSecrets.write({ id: string(entry.secretArn), operationId: installOwner, value: JSON.stringify({ ...value, registrationFailure: proof }) }, { abortSignal: deadline.signal }));
      await reject(proof);
    }
    const installed: Secrets = { appId: value.appId, clientId: value.clientId, clientSecret: value.clientSecret, signingSecret: value.signingSecret, apiKey: value.apiKey, model: value.model, botUserId: string(result.bot_user_id), botToken: string(result.access_token), botScopes: scopes };
    await deadline.step(() => callbackSecrets.write({ id: string(entry.secretArn), operationId: installOwner, value: JSON.stringify(installed) }, { abortSignal: deadline.signal }));
    await enqueue();
    return 'processing';
  });
}
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try { await provision(record.body); }
    catch (error) {
      process.stderr.write(JSON.stringify({ event: 'roughmate_provision_failed', code: diagnosticCode(error), messageId: record.messageId })+'\n');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
