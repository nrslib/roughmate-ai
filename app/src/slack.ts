export const botScopes = ['app_mentions:read','channels:history','channels:read','channels:join','groups:history','groups:read','chat:write'] as const;
export const botDeletionConfirmationNotice='削除ボタンは確認画面を開きます。画面が開かない・表示結果が不明な場合は、Homeを開き直して再操作してください。開いた確認画面で「停止して削除」を送信するまで、Botの停止・削除は始まりません。送信後の保存結果が不明な場合は、登録窓口Homeの削除状況を確認し、新たな削除を送信しないでください。';
import { diagnosticCode } from './diagnostics.js';
import { WebClient, LogLevel, type KnownBlock, type View } from '@slack/web-api';
import { type GroupConfig } from './groups.js';
import { AppError, type Consultation, type Workspace, env } from './contracts.js';
export function slackClient(token?: string, signal?: AbortSignal, timeoutMs = 1800): WebClient {
  return new WebClient(token, { fetch: signal ? (url, init) => { signal.throwIfAborted(); return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }); } : undefined, logLevel: LogLevel.ERROR, logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return LogLevel.ERROR; }, setName() {} }, retryConfig: { retries: 0 }, timeout: timeoutMs, rejectRateLimitedCalls: true });
}
export async function requireBotIdentity(client: WebClient, teamId: string, botUserId: string): Promise<void> {
  const auth = await client.auth.test();
  if (auth.ok !== true || 'error' in auth || auth.team_id !== teamId || auth.user_id !== botUserId) throw new AppError('group_boundary_mismatch');
}
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
export function approvalBlocks(item: Consultation): KnownBlock[] {
  return [ { type: 'section', text: { type: 'plain_text', text: item.draft ?? '回答案を生成中です。' } },
    ...(item.knowledgeReferences?.flatMap(reference => [{ type: 'section' as const, text: { type: 'plain_text' as const, text: `参照資料: ${reference.title} (${reference.id}, v${reference.version})\n出典: ${reference.source}` } }, ...Array.from({ length: Math.ceil(reference.body.length / 2800) }, (_, index) => ({ type: 'section' as const, text: { type: 'plain_text' as const, text: reference.body.slice(index * 2800, (index + 1) * 2800) } }))]) ?? []),
    { type: 'actions', elements: [ { type: 'button', action_id: 'adopt', text: { type: 'plain_text', text: '採用する' }, value: item.pk }, { type: 'button', action_id: 'edit', text: { type: 'plain_text', text: '編集する' }, value: item.pk } ] } ];
}
export function editView(item: Consultation, receiptId: string): View {
  if (!item.draft) throw new AppError('invalid_status');
  return { type: 'modal', callback_id: 'answer', private_metadata: receiptId,
    title: { type: 'plain_text', text: '回答を編集' }, submit: { type: 'plain_text', text: '送信する' }, close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [{ type: 'input', block_id: 'answer', label: { type: 'plain_text', text: '最終回答' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true, initial_value: item.draft, max_length: 3000 } }] };
}
export function preparingEditView(): View {
  return { type: 'modal', callback_id: 'answer_preparing', title: { type: 'plain_text', text: '回答を編集' }, close: { type: 'plain_text', text: '閉じる' },
    blocks: [{ type: 'section', text: { type: 'plain_text', text: '対応チャンネルの所属と回答案を確認しています。確認後に編集欄を表示します。表示されない場合は閉じてから編集ボタンを押し直してください。' } }] };
}
export function settingsView(config: GroupConfig): View {
  return { type: 'modal', callback_id: 'settings', private_metadata: String(config.version), title: { type: 'plain_text', text: 'Roughmate 設定' }, submit: { type: 'plain_text', text: '保存する' }, blocks: [
    { type: 'input', block_id: 'name', label: { type: 'plain_text', text: 'ホーム表示名（別Bot作成・改名はしません）' }, element: { type: 'plain_text_input', action_id: 'text', initial_value: config.name, max_length: 35 } },
    { type: 'input', block_id: 'description', optional: true, label: { type: 'plain_text', text: '所属・説明' }, element: { type: 'plain_text_input', action_id: 'text', initial_value: config.description || undefined, max_length: 500, multiline: true } },
    { type: 'input', block_id: 'admins', label: { type: 'plain_text', text: '管理者' }, element: { type: 'multi_users_select', action_id: 'select', initial_users: config.adminIds, max_selected_items: 20 } },
    { type: 'input', block_id: 'notifyUsers', optional: true, label: { type: 'plain_text', text: '回答案の通知メンション先（任意）' }, hint: { type: 'plain_text', text: '回答案のスレッドで選んだ人だけにメンションします。通知の到達はSlackの公開範囲・通知設定に依存します。未選択なら通知投稿を行いません。対応チャンネルのメンバーは誰でも採用・編集できます。権限付与や自動招待は行いません。' }, element: { type: 'multi_users_select', action_id: 'select', initial_users: config.notifyUserIds, max_selected_items: 20 } },
    { type: 'input', block_id: 'intake', optional: true, label: { type: 'plain_text', text: '相談受付チャンネル' }, hint: { type: 'plain_text', text: '保存時に公開先へ自動参加します。非公開はHomeで本人認可が必要です。未選択で新しい相談の受付を停止します。' }, element: { type: 'multi_conversations_select', action_id: 'select', initial_conversations: config.intakeChannelIds.length ? config.intakeChannelIds : undefined, max_selected_items: 20, filter: { include: ['public','private'], exclude_external_shared_channels: true } } },
    { type: 'input', block_id: 'channel', label: { type: 'plain_text', text: '対応用チャンネル' }, hint: { type: 'plain_text', text: '公開先へ自動参加。非公開は操作者本人の認可・所属・招待権限が必要です。' }, element: { type: 'conversations_select', action_id: 'select', initial_conversation: config.reviewChannelId, filter: { include: ['public','private'], exclude_external_shared_channels: true } } }
  ] };
}
export async function publishHome(client: WebClient, _workspace: Workspace, user: string, notice: string, config?: GroupConfig, extra: KnownBlock[] = [], channelAuthorization?: 'pending' | 'scope_excess'): Promise<void> {
  const blocks: KnownBlock[] = [...(config ? [{ type: 'header' as const, text: { type: 'plain_text' as const, text: config.name } }, { type: 'section' as const, text: { type: 'plain_text' as const, text: config.description || '所属・説明は未設定です。' } }] : []), { type: 'section', text: { type: 'mrkdwn', text: notice } }];
  if(config && process.env.PUBLIC_URL) {
    const child=/\/bots\/([a-f0-9]{32})\/runtime-/.exec(config.environmentId);
    const url=env('PUBLIC_URL')+'/wiki/'+(child ? 'bots/'+child[1]:'root');
    blocks.push({type:'actions',elements:[{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text:'Wikiを開く'},url}]});
    if(!child && user===_workspace.ownerId) blocks.push({type:'actions',elements:[{type:'button',action_id:'open_wiki_archives',text:{type:'plain_text',text:'削除したBotのアーカイブ'},url:env('PUBLIC_URL')+'/wiki/archives'}]});
    if(child && user===_workspace.ownerId && config.adminIds.includes(user)) blocks.push({type:'section',text:{type:'plain_text',text:botDeletionConfirmationNotice}},{type:'actions',elements:[{type:'button',action_id:'delete_bot',text:{type:'plain_text',text:'このBotを削除'},value:child[1]}]});
  }
  if (config && !config.lifecycle && config.adminIds.includes(user)) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'configure', text: { type: 'plain_text', text: '受付・対応先・任意通知を設定' }, value: 'configure' }] }, { type: 'actions', elements: [...(!channelAuthorization ? [{ type: 'button' as const, action_id: 'authorize_channels', text: { type: 'plain_text' as const, text: '非公開招待を本人認可' }, value: 'authorize_channels' }] : []), { type: 'button', action_id: 'disconnect_channels', text: { type: 'plain_text', text: '本人の招待認可を解除' }, value: 'disconnect_channels' }] });
    if (channelAuthorization === 'pending') blocks.push({ type: 'section', text: { type: 'plain_text', text: '本人OAuthの交換・権限確認が未完了のため、新しい認可リンクは発行しません。進行中の処理が完了するまで待ち、保存状態を確認してください。未確認状態が残る場合は環境管理者へ確認を依頼し、未保存と仮定して保護を解除しないでください。同じOAuth codeは再交換しません。本人認可の明示解除は直ちに反映します。' } });
  }
  if (config && config.adminIds.includes(user)) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: '本人認可の解除は直ちに反映します。招待呼出し直前の開始許可が先に確定した1件は、解除後に送信・完了する場合があります。開始許可はSlack送信完了を意味せず、以後の招待と設定保存は停止します。' }] });
  await client.views.publish({ user_id: user, view: { type: 'home', blocks: [...blocks, ...extra] } });
}
export async function requireMember(client: WebClient, channel: string, user: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const result = await client.conversations.members({ channel, limit: 200, cursor });
    if (result.members?.includes(user)) return;
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
  throw new AppError('forbidden');
}
export async function requireBotChannel(client: WebClient, channel: string): Promise<void> {
  try {
    const result = await client.conversations.info({ channel });
    if (result.channel?.is_ext_shared || result.channel?.is_pending_ext_shared || result.channel?.pending_shared?.length || result.channel?.pending_connected_team_ids?.length) throw new AppError('external_channel_not_supported');
    if (!result.channel?.is_member || result.channel.is_archived || result.channel.is_im || result.channel.is_mpim) throw new AppError('bot_not_in_channel');
  } catch (error) {
    if (['slack_channel_not_found', 'slack_not_in_channel'].includes(diagnosticCode(error))) throw new AppError('bot_not_in_channel');
    throw error;
  }
}
