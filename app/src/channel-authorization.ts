import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError, object, string, requireInstalledSecrets, type Secrets } from './contracts.js';
import { requireAdmin, requireIdentity, type GroupConfig, type GroupIdentity } from './groups.js';
import { stateKey } from './security.js';
import { slackClient, requireBotIdentity } from './slack.js';
import type { Storage } from './storage.js';
import type { RequestDeadline } from './deadline.js';
import { ErrorCode } from '@slack/web-api';
export const invitationScopes: ('groups:read' | 'groups:write.invites')[] = ['groups:read', 'groups:write.invites'];
export interface ChannelAuthorization extends GroupIdentity {
  pk: string; userId: string; generation: string; pending?: string; pendingGeneration?: string; cipher?: string; iv?: string; tag?: string; tokenExpiresAt?: number; scopeExcess?: boolean; scopeCheckOwner?: string;
}
export interface ChannelAuthorizationState extends GroupIdentity {
  pk: string; userId: string; generation: string; configVersion: number; expiresAt: number; consumed?: boolean;
}
function aad(value: ChannelAuthorization): Buffer {
  return Buffer.from(JSON.stringify(['roughmate-channel-authorization-v1', value.environmentId, value.appId, value.teamId, value.userId, value.generation, value.tokenExpiresAt ?? null]));
}
function key(secrets: Secrets, identity: GroupIdentity): Buffer {
  if (secrets.appId !== identity.appId) throw new AppError('group_boundary_mismatch');
  return Buffer.from(hkdfSync('sha256', string(secrets.signingSecret), identity.environmentId, 'roughmate-channel-authorization-v1', 32));
}
export function encryptAuthorization(secrets: Secrets, value: ChannelAuthorization, token: string): ChannelAuthorization {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secrets, value), iv);
  cipher.setAAD(aad(value));
  return { ...value, cipher: Buffer.concat([cipher.update(string(token), 'utf8'), cipher.final()]).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function decryptAuthorization(secrets: Secrets, value: ChannelAuthorization, identity: GroupIdentity, user: string): string {
  requireIdentity(value, identity);
  if (value.userId !== user || value.pk !== `channel-user#${user}` || !value.cipher || !value.iv || !value.tag || value.tokenExpiresAt !== undefined && value.tokenExpiresAt <= Math.floor(Date.now()/1000)) throw new AppError('channel_authorization_required');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secrets, identity), Buffer.from(value.iv, 'base64'));
    decipher.setAAD(aad(value)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return string(Buffer.concat([decipher.update(Buffer.from(value.cipher, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new AppError('channel_authorization_required'); }
}
export async function beginChannelAuthorization(store: Storage, config: GroupConfig, secrets: Secrets, user: string, base: string): Promise<string> {
  requireAdmin(config, user);
  const previous = await store.prepareChannelAuthorization(config, user);
  if (previous?.scopeExcess) throw new AppError('channel_authorization_scope_excess');
  if (previous?.scopeCheckOwner !== undefined) throw new AppError('channel_authorization_pending');
  const state = randomBytes(32).toString('base64url'), generation = randomBytes(16).toString('hex');
  await store.beginChannelAuthorization(config, { pk: `channel-state#${stateKey(state)}`, ...configIdentity(config), userId: user, generation, configVersion: config.version, expiresAt: Math.floor(Date.now()/1000)+900 });
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.search = new URLSearchParams({ client_id: secrets.clientId, user_scope: invitationScopes.join(','), redirect_uri: base+'/channel-authorization/callback', state, team: config.teamId }).toString();
  return url.href;
}
export function configIdentity(config: GroupIdentity): GroupIdentity { return { environmentId: config.environmentId, appId: config.appId, teamId: config.teamId }; }
export async function completeChannelAuthorization(store: Storage, config: GroupConfig, secrets: Secrets, state: string, response: { code?: string; error?: string }, base: string, deadline: RequestDeadline): Promise<string> {
  const receipt = await deadline.step(() => store.get<ChannelAuthorizationState>(`channel-state#${stateKey(state)}`));
  if (!receipt || receipt.consumed || receipt.expiresAt <= Math.floor(Date.now()/1000) || receipt.configVersion !== config.version) throw new AppError('invalid_state');
  requireIdentity(receipt, config); requireAdmin(config, receipt.userId);
  const active = await deadline.step(() => store.get<ChannelAuthorization>(`channel-user#${receipt.userId}`));
  if (active?.scopeExcess) throw new AppError('channel_authorization_scope_excess');
  if (active?.scopeCheckOwner) throw new AppError('channel_authorization_pending');
  if (response.error !== undefined && (response.error !== 'access_denied' || response.code !== undefined)) throw new AppError('invalid_input');
  if (response.error === undefined && (typeof response.code !== 'string' || !response.code.trim())) throw new AppError('invalid_input');
  const installed = requireInstalledSecrets(secrets);
  await deadline.step(() => requireBotIdentity(slackClient(installed.botToken, deadline.signal), config.teamId, installed.botUserId));
  await deadline.step(() => store.consumeChannelAuthorization(config, receipt));
  if (response.error === 'access_denied') {
    await deadline.step(() => store.finishChannelScopeCheck(config, receipt));
    throw new AppError('channel_authorization_denied');
  }
  let result;
  try { result = await deadline.step(() => slackClient(undefined, deadline.signal).oauth.v2.access({ client_id: secrets.clientId, client_secret: secrets.clientSecret, code: string(response.code), redirect_uri: base+'/channel-authorization/callback' })); }
  catch (error) {
    const value = error as { code?: string; data?: Record<string, unknown> };
    const user = value?.data?.authed_user as { access_token?: unknown; refresh_token?: unknown } | undefined;
    if (value?.code === ErrorCode.PlatformError && value.data?.ok === false && value.data.access_token === undefined && value.data.refresh_token === undefined && user?.access_token === undefined && user?.refresh_token === undefined && ['invalid_code','bad_client_secret','bad_redirect_uri','invalid_client_id','invalid_code_verifier','invalid_grant_type'].includes(String(value.data.error))) {
      await deadline.step(() => store.finishChannelScopeCheck(config, receipt));
      throw new AppError(`channel_oauth_${value.data.error}`);
    }
    throw new AppError('channel_authorization_pending');
  }
  if (!result || result.ok !== true || 'error' in result || !result.authed_user || typeof result.authed_user !== 'object' || Array.isArray(result.authed_user)) throw new AppError('channel_authorization_pending');
  const user = object(result.authed_user);
  if (result.is_enterprise_install !== undefined && typeof result.is_enterprise_install !== 'boolean') throw new AppError('channel_authorization_pending');
  if (typeof result.app_id !== 'string' || !result.app_id.trim() || typeof result.team?.id !== 'string' || !result.team.id.trim() || typeof user.id !== 'string' || !user.id.trim()) throw new AppError('channel_authorization_pending');
  const appId = result.app_id, teamId = result.team.id, userId = user.id;
  if (user.token_type !== 'user') throw new AppError('channel_authorization_pending');
  if (typeof user.access_token !== 'string' || !user.access_token.trim()) throw new AppError('channel_authorization_pending');
  const token = string(user.access_token);
  if (user.expires_in !== undefined && (!Number.isSafeInteger(user.expires_in) || Number(user.expires_in) <= 0)) throw new AppError('channel_authorization_pending');
  if (typeof user.scope !== 'string' || !user.scope.trim()) throw new AppError('channel_authorization_pending');
  const scopes = user.scope.split(',');
  const allowed:string[]=[...invitationScopes,...(config.environmentId===process.env.SECRET_ARN ? ['channels:read']:[])];
  const excess = scopes.some(scope => !allowed.includes(scope));
  if (appId !== config.appId || teamId !== config.teamId || result.is_enterprise_install || userId !== receipt.userId) {
    if (excess) throw new AppError('channel_authorization_pending');
    await deadline.step(() => store.finishChannelScopeCheck(config, receipt));
    throw new AppError('forbidden');
  }
  if (excess) {
    await deadline.step(() => store.rejectChannelAuthorizationScopes(config, receipt));
    throw new AppError('channel_authorization_scope_excess');
  }
  await deadline.step(() => store.finishChannelScopeCheck(config, receipt));
  if (invitationScopes.some(scope => !scopes.includes(scope))) throw new AppError('channel_authorization_scope_mismatch');
  const auth = await deadline.step(() => slackClient(token, deadline.signal).auth.test());
  if (auth.ok !== true || 'error' in auth || auth.team_id !== config.teamId || auth.user_id !== receipt.userId || auth.bot_id) throw new AppError('forbidden');
  const record: ChannelAuthorization = { pk: `channel-user#${receipt.userId}`, ...configIdentity(config), userId: receipt.userId, generation: receipt.generation };
  if (user.expires_in !== undefined) {
    record.tokenExpiresAt = Math.floor(Date.now()/1000) + Number(user.expires_in);
  }
  await deadline.step(() => store.saveChannelAuthorization(config, receipt, encryptAuthorization(secrets, record, token)));
  return receipt.userId;
}
