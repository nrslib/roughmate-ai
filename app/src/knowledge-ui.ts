import type { KnownBlock, View } from '@slack/web-api';
import { AppError, object, string } from './contracts.js';
import { requireAdmin, validateDocument, validateCatalog, requireIdentity, type GroupConfig, type KnowledgeCatalog, type KnowledgeDocument, type GroupIdentity } from './groups.js';
import { hashText } from './wiki-contract.js';
import { Storage, requireSettingsExpiry, settingsRetentionSeconds } from './storage.js';

export function knowledgeBlocks(catalog: KnowledgeCatalog, incomplete=false): KnownBlock[] {
  return [{ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: '専用資料' } },
    { type: 'section', text: { type: 'plain_text', text: '非公開資料は管理者が閲覧でき、Wiki整理AIへ送信します。相談回答には相談受付と対応先の両方を許可し、本人が許可範囲すべてに所属する資料を使います。' } },
    ...(incomplete ? [{type:'section' as const,text:{type:'plain_text' as const,text:'所属確認の上限に達したため未確認の資料があります。未確認は権限なし・不存在を意味しません。Wikiの資料一覧で5件ずつ確認できます。'}}]:[]),
    { type: 'actions', elements: [{ type: 'button', action_id: 'knowledge_add', text: { type: 'plain_text', text: '資料を登録' }, value: 'new' }] },
    ...catalog.documents.flatMap(document => [{ type: 'section' as const, text: { type: 'plain_text' as const, text: `${document.title} (${document.id}, 内容識別子: ${hashText(document.body).slice(0,12)})\n出典: ${document.source}` } },
      { type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'knowledge_edit', text: { type: 'plain_text' as const, text: '閲覧・編集' }, value: document.id }, { type: 'button' as const, action_id: 'knowledge_delete', text: { type: 'plain_text' as const, text: '削除' }, value: document.id, confirm: { title: { type: 'plain_text' as const, text: '資料を削除' }, text: { type: 'plain_text' as const, text: 'この資料を使用した回答案は以後送信できなくなります。' }, confirm: { type: 'plain_text' as const, text: '削除' }, deny: { type: 'plain_text' as const, text: 'キャンセル' } } }] }])];
}
export function knowledgeView(config: GroupConfig, catalog: KnowledgeCatalog, document?: KnowledgeDocument): View {
  const channels = (block: string, label: string, allowed: string[], selected: string[]): KnownBlock[] => {
    if (!allowed.length) return [{ type: 'section', text: { type: 'plain_text', text: `${label}: 未設定のため非公開で保存します。公開先はHomeの設定でチャンネルを設定した後に選べます。` } }];
    const options = allowed.map((value, index) => ({ text: { type: 'plain_text' as const, text: `${index+1}: ${value}` }, value }));
    return [{ type: 'section', text: { type: 'mrkdwn', text: allowed.map((value,index) => `${index+1}: <#${value}>`).join('、') } },
      { type: 'input', block_id: block, optional: true, label: { type: 'plain_text', text: label }, element: { type: 'multi_static_select', action_id: 'select', options, initial_options: options.filter(option => selected.includes(option.value)), max_selected_items: allowed.length } }];
  };
  return { type: 'modal', callback_id: 'knowledge', private_metadata: JSON.stringify({ groupVersion: config.version, catalogVersion: catalog.version, ...(document ? { id: document.id } : {}) }), title: { type: 'plain_text', text: '専用資料' }, submit: { type: 'plain_text', text: '保存' }, blocks: [
    { type: 'input', block_id: 'id', label: { type: 'plain_text', text: '資料ID（英数字 _ -、先頭は英数字）' }, element: { type: 'plain_text_input', action_id: 'text', initial_value: document?.id, max_length: 64 } },
    { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'タイトル' }, element: { type: 'plain_text_input', action_id: 'text', initial_value: document?.title, max_length: 150 } },
    { type: 'input', block_id: 'source', label: { type: 'plain_text', text: '出典（URL・文書名）' }, element: { type: 'plain_text_input', action_id: 'text', initial_value: document?.source, max_length: 500 } },
    ...[0,1,2].map(index => ({ type: 'input' as const, block_id: index === 0 ? 'body' : `body${index+1}`, optional: index > 0, label: { type: 'plain_text' as const, text: `本文 ${index+1}/3（全体8192 UTF-8 bytes）` }, element: { type: 'plain_text_input' as const, action_id: 'text', initial_value: Array.from(document?.body ?? '').slice(index*3000,(index+1)*3000).join('') || undefined, multiline: true, max_length: 3000 } })),
    ...channels('intake', '利用を許可する相談チャンネル', config.intakeChannelIds, document?.channelIds ?? []),
    ...channels('review', '全文閲覧を許可する対応チャンネル', config.reviewChannelId ? [config.reviewChannelId] : [], document?.reviewChannelIds ?? [])
  ] };
}
export interface KnowledgeRequest extends GroupIdentity { configVersion: number; catalogVersion: number; requestId: string; userId: string; expiresAt: number; document?: KnowledgeDocument; deleteId?: string; }
export async function requestKnowledge(store: Storage, config: GroupConfig, user: string, requestId: string, catalog: KnowledgeCatalog, document: KnowledgeDocument | undefined, deleteId: string | undefined): Promise<KnowledgeRequest> {
  requireAdmin(config, user);
  const pk = `knowledge#${requestId}`;
  const previous = await store.get<KnowledgeRequest>(pk);
  const expiresAt = previous ? requireSettingsExpiry(previous.expiresAt) : Math.floor(Date.now()/1000)+settingsRetentionSeconds;
  const request: KnowledgeRequest = { environmentId: config.environmentId, appId: config.appId, teamId: config.teamId, configVersion: config.version, catalogVersion: catalog.version, requestId, userId: user, expiresAt, ...(document ? { document } : {}), ...(deleteId ? { deleteId } : {}) };
  if (previous) {
    const { isDeepStrictEqual } = await import('node:util');
    if (!isDeepStrictEqual(knowledgeContent(previous), request)) throw new AppError('forbidden');
  } else await store.requestKnowledge(config, request);

  return request;
}
export function submittedDocument(values: Record<string, unknown>, previous: KnowledgeDocument | undefined, catalogVersion: number): KnowledgeDocument {
  const input = (id: string) => values[id] === undefined ? undefined : object(object(values[id]).text).value;
  const id = string(input('id'));
  if (previous && id !== previous.id) throw new AppError('invalid_knowledge');
  const body = [input('body'), input('body2'), input('body3')].map(value => { if (value === undefined || value === null) return ''; if (typeof value !== 'string') throw new AppError('invalid_input'); return value; }).join('');
  return validateDocument({ id, title: input('title'), source: input('source'), body, version: catalogVersion+1,
    channelIds: selectedChannels(values.intake), reviewChannelIds: selectedChannels(values.review) });
}
export interface KnowledgeReceipt extends KnowledgeRequest { pk: string; status?: 'pending' | 'saved' | 'failed'; failureCode?: string; wikiTasks?:string[]; }
export interface KnowledgeHead extends GroupIdentity { pk: string; requestId: string; userId: string; expiresAt: number; noticeUntil?: number; noticeOwner?: string; }
export function knowledgeContent(raw: KnowledgeRequest): KnowledgeRequest {
  const { environmentId, appId, teamId, configVersion, catalogVersion, requestId, userId, expiresAt, document, deleteId } = raw;
  return { environmentId, appId, teamId, configVersion, catalogVersion, requestId, userId, expiresAt, ...(document ? { document } : {}), ...(deleteId ? { deleteId } : {}) };
}
function selectedChannels(raw: unknown): string[] {
  if (raw === undefined) return [];
  const selected = object(object(raw).select).selected_options;
  if (selected === undefined || selected === null) return [];
  if (!Array.isArray(selected)) throw new AppError('invalid_input');
  return selected.map(option => string(object(option).value));
}
export async function applyKnowledge(store: Storage, config: GroupConfig, raw: unknown): Promise<void> {
  const request = object(raw) as unknown as KnowledgeRequest;
  requireIdentity(request, config);
  requireAdmin(config, string(request.userId));
  requireSettingsExpiry(request.expiresAt);
  const catalog = await store.knowledge(config);
  if ((catalog as KnowledgeCatalog & { lastRequestId?: string }).lastRequestId === request.requestId) return;
  if (config.version !== request.configVersion || catalog.version !== request.catalogVersion) throw new AppError('settings_conflict');
  let documents: KnowledgeDocument[];
  if (request.document && !request.deleteId) {
    const document = validateDocument(request.document);
    const previous = catalog.documents.find(item => item.id === document.id);
    if (document.version !== catalog.version+1 || previous && document.version <= previous.version) throw new AppError('invalid_knowledge');
    if (document.channelIds.some(channel => !config.intakeChannelIds.includes(channel))) throw new AppError('intake_channel_not_allowed');
    if (document.reviewChannelIds.some(channel => channel !== config.reviewChannelId)) throw new AppError('review_channel_not_allowed');
    documents = [...catalog.documents.filter(item => item.id !== document.id), document];
  } else if (request.deleteId && !request.document) {
    if (!catalog.documents.some(item => item.id === request.deleteId)) throw new AppError('invalid_knowledge');
    documents = catalog.documents.filter(item => item.id !== request.deleteId);
  } else throw new AppError('invalid_input');
  const next = validateCatalog({ ...catalog, version: catalog.version+1, documents, lastRequestId: string(request.requestId) }, config);
  await store.saveKnowledge(config, catalog, next, request.userId, request);
}
