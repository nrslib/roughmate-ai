import type { WebClient } from '@slack/web-api';
import { ErrorCode } from '@slack/web-api';
import { AppError, string, type Secrets } from './contracts.js';
import type { GroupConfig } from './groups.js';
import type { Storage } from './storage.js';
import { decryptAuthorization } from './channel-authorization.js';
import { slackClient, botScopes } from './slack.js';
type Channel = NonNullable<Awaited<ReturnType<WebClient['conversations']['info']>>['channel']>;
function requireUsable(channel: Channel | undefined): asserts channel is Channel {
  if (!channel || channel.is_archived || channel.is_im || channel.is_mpim) throw new AppError('bot_not_in_channel');
  if (channel.is_ext_shared || channel.is_pending_ext_shared || channel.pending_shared?.length || channel.pending_connected_team_ids?.length) throw new AppError('external_channel_not_supported');
}
function platformError(error: unknown): string | undefined {
  const value = error as { code?: string; data?: { ok?: boolean; error?: string; channel?: unknown } };
  return value?.code === ErrorCode.PlatformError && value.data?.ok === false && value.data.channel === undefined ? value.data.error : undefined;
}
function participationFailure(error: unknown, privateChannel: boolean, inviting: boolean): never {
  const code = platformError(error);
  if (code === 'missing_scope') throw new AppError(privateChannel ? 'channel_authorization_required' : 'channel_join_scope_required');
  if (privateChannel && ['token_revoked','token_expired','invalid_auth','account_inactive'].includes(code ?? '')) throw new AppError('channel_authorization_required');
  if (code === 'accesslimited') throw new AppError('channel_network_restricted');
  if (code === 'ekm_access_denied') throw new AppError('channel_admin_restricted');
  if (code === 'enterprise_is_restricted') throw new AppError('channel_enterprise_restricted');
  if (code === 'two_factor_setup_required') throw new AppError('channel_mfa_required');
  if (['access_denied','channel_is_limited_access','team_access_not_granted','invitee_cant_see_channel','org_user_not_in_team','user_is_restricted','not_in_channel','channel_not_found','user_not_found'].includes(code ?? '')) throw new AppError('channel_access_restricted');
  if (['too_many_members','ura_max_channels'].includes(code ?? '')) throw new AppError('channel_capacity_restricted');
  if (['is_archived','method_not_supported_for_channel_type'].includes(code ?? '')) throw new AppError('bot_not_in_channel');
  if (code === 'app_cannot_join_channel') throw new AppError('channel_join_forbidden');
  if (['no_permission','restricted_action','cant_invite','cant_invite_self','no_external_invite_permission'].includes(code ?? '')) throw new AppError(inviting ? 'channel_invitation_forbidden' : privateChannel ? 'channel_access_restricted' : 'channel_join_forbidden');
  throw error;
}
async function channelInfo(client: WebClient, channel: string, team: string): Promise<Channel> {
  const result = await client.conversations.info({ channel });
  if (result.ok !== true || 'error' in result || !result.channel) throw new AppError('channel_participation_unknown');
  const value = result.channel;
  if (value.id !== channel || value.context_team_id !== team) throw new AppError('channel_participation_unknown');
  if (value.is_im === true || value.is_mpim === true) throw new AppError('bot_not_in_channel');
  if (value.is_channel !== true && value.is_group !== true || value.is_group === true && value.is_private !== true) throw new AppError('channel_participation_unknown');
  for (const field of ['is_private','is_member','is_archived','is_ext_shared','is_pending_ext_shared'] as const) if (typeof value[field] !== 'boolean') throw new AppError('channel_participation_unknown');
  for (const field of ['is_channel','is_group','is_im','is_mpim'] as const) if (value[field] !== undefined && typeof value[field] !== 'boolean') throw new AppError('channel_participation_unknown');
  for (const field of ['pending_shared','pending_connected_team_ids'] as const) if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field]!.some(id => typeof id !== 'string'))) throw new AppError('channel_participation_unknown');
  return value;
}
async function checkedInfo(client: WebClient, channel: string, team: string, privateChannel: boolean): Promise<Channel> {
  try { return await channelInfo(client, channel, team); }
  catch (error) { participationFailure(error, privateChannel, false); }
}
export interface ChannelParticipation { channel: string; private: boolean; userClient?: WebClient; generation?: string; }
export async function planParticipation(store: Storage, client: WebClient, config: GroupConfig, secrets: Secrets, user: string, channels: string[]): Promise<ChannelParticipation[]> {
  if (!secrets.botScopes || botScopes.some(scope => !secrets.botScopes!.includes(scope)) || secrets.botScopes.some(scope => !botScopes.some(expected => expected === scope))) throw new AppError('channel_join_scope_required');
  const plan: ChannelParticipation[] = [];
  let userClient: WebClient | undefined;
  let generation: string | undefined;
  for (const channel of new Set(channels)) {
    let info: Channel | undefined;
    try { info = await channelInfo(client, channel, config.teamId); }
    catch (error) { if (!['channel_not_found','not_in_channel'].includes(platformError(error) ?? '')) participationFailure(error, false, false); }
    if (info) { requireUsable(info); if (info.is_member) continue; }
    if (info && !info.is_private) {
      plan.push({ channel, private: false }); continue;
    }
    if (!userClient) {
      try {
        const record = await store.prepareChannelAuthorization(config, user);
        if (!record) throw new AppError('channel_authorization_required');
        userClient = slackClient(decryptAuthorization(secrets, record, config, user));
        generation = record.generation;
        const auth = await userClient.auth.test();
        if (auth.ok !== true || 'error' in auth || typeof auth.team_id !== 'string' || !auth.team_id || typeof auth.user_id !== 'string' || !auth.user_id) throw new AppError('channel_participation_unknown');
        if (auth.team_id !== config.teamId || auth.user_id !== user || auth.bot_id) throw new AppError('group_boundary_mismatch');
      } catch (error) {
        if (error instanceof AppError && ['group_boundary_mismatch','settings_conflict','invalid_input'].includes(error.code)) throw new AppError('channel_authorization_boundary');
        if (['token_revoked','token_expired','invalid_auth','account_inactive'].includes(platformError(error) ?? '')) throw new AppError('channel_authorization_required');
        throw error;
      }
    }
    const visible = await checkedInfo(userClient, channel, config.teamId, true);
    requireUsable(visible);
    if (!visible.is_private || !visible.is_member) throw new AppError('channel_access_restricted');
    plan.push({ channel, private: true, userClient, generation });
  }
  return plan;
}
export async function participate(client: WebClient, secrets: Secrets, config: GroupConfig, plan: ChannelParticipation[], guard: () => Promise<void>, startInvite: (channel: string, generation: string) => Promise<void>): Promise<void> {
  if (!plan.length) return;
  for (const item of plan) {
    await guard();
    const visible = await checkedInfo(item.private ? item.userClient! : client, item.channel, config.teamId, item.private);
    requireUsable(visible);
    if (Boolean(visible.is_private) !== item.private || item.private && !visible.is_member) throw new AppError('channel_access_restricted');
    await guard();
    if (item.private) await startInvite(item.channel, string(item.generation));
    try {
      const result = item.private ? await item.userClient!.conversations.invite({ channel: item.channel, users: string(secrets.botUserId) }) : await client.conversations.join({ channel: item.channel });
      if (result.ok !== true || 'error' in result || !result.channel || result.channel.id !== undefined && result.channel.id !== item.channel) throw new AppError('channel_participation_unknown');
    } catch (error) {
      const code = platformError(error);
      if (code !== 'already_in_channel') participationFailure(error, item.private, item.private);
    }
    const joined = await checkedInfo(client, item.channel, config.teamId, false);
    requireUsable(joined);
    if (!joined.is_member) throw new AppError('bot_not_in_channel');
  }
}
