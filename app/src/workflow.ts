import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import { AppError, object, string, metadataEvents, workerDrainSeconds, type Consultation, type Workspace, type Secrets } from './contracts.js';
import { requireBotChannel, requireMember, approvalBlocks, escapeSlackText } from './slack.js';
import type { AnswerStore, ConsultationStateStore, ConsultationStore, ConsultationEvidenceStore, DraftPublicationStore } from './consultation-store.js';
import { generateDraft } from './llm.js';
import { consultationDisplay } from './consultation-display.js';
import { requireIntake, requireIdentity, references, validateDraftBoundary, type GroupConfig, type GroupIdentity } from './groups.js';
import { requireWikiViewer, visibleScopes, viewerKey, WikiAccess } from './wiki-access.js';
import { ChannelAudience } from './channel-audience.js';
import { searchTerms, relevance, retrieveOriginals, shareableDocuments, validateSharedReferences, validateOriginalReferences } from './wiki-retrieval.js';
import { selectAnswerDocuments, validateAnswerStorage } from './answer-evidence.js';
type DraftWorkflowStore = ConsultationStore & ConsultationEvidenceStore & DraftPublicationStore & { readSecrets(): Promise<Secrets> };
export interface AnswerDelivery {
  validate(item: Consultation): Promise<void>;
  send(item: Consultation, answer: string): Promise<string>;
  find(item: Consultation): Promise<string | undefined>;
}
// workerの120秒制限より長く保護し、実行中の投稿を再照合が追い越さないようにする。
const postingGuardSeconds = workerDrainSeconds;
export function isAnswerInProgress(item: Consultation): boolean {
  return item.status === 'posting' && item.postingUntil !== undefined && item.postingUntil > Math.floor(Date.now() / 1000);
}
async function saveSentAnswer(store: ConsultationStateStore, item: Consultation, answerTs: string): Promise<void> {
  if (await store.transition(item.pk, 'posting', { status: 'sent', answerTs })) return;
  if (await store.transition(item.pk, 'uncertain', { status: 'sent', answerTs })) return;
  const current = await store.get(item.pk);
  if (current?.status !== 'sent' || current.answerTs !== answerTs) throw new AppError('answer_state_conflict');
}
export async function approve(store: AnswerStore, delivery: AnswerDelivery, item: Consultation, answer: string, actorId: string): Promise<void> {
  if (!answer.trim() || answer.length > 3000) throw new AppError('invalid_answer');
  validateAnswerStorage(item,answer,actorId);
  await delivery.validate(item);
  const claim: Consultation = { ...item, status: 'posting', answer, actorId, postingOwner: randomUUID(), postingUntil: Math.floor(Date.now() / 1000) + postingGuardSeconds };
  const claimed = await store.transition(item.pk, 'draft', { status: claim.status, answer, actorId, postingOwner: claim.postingOwner, postingUntil: claim.postingUntil });
  if (!claimed) return;
  try { await delivery.validate(claim); }
  catch (error) {
    await store.cancelAnswerClaim(claim);
    throw error;
  }
  // 投稿の成否が不明な場合は自動再投稿せず、後続の再照合へ渡す。
  try {
    const answerTs = await delivery.send(claim, answer);
    await saveSentAnswer(store, claim, answerTs);
  } catch (error) {
    await store.transition(item.pk, 'posting', { postingUntil: 0 }, { kind: 'posting_owner', owner: string(claim.postingOwner) });
    throw error;
  }
}
export async function reconcile(store: ConsultationStateStore, delivery: AnswerDelivery, item: Consultation): Promise<{startedAt:number;completedAt:number}|undefined> {
  if (item.status !== 'posting' && item.status !== 'uncertain') return;
  if (isAnswerInProgress(item)) return;
  const startedAt=Math.floor(Date.now()/1000);
  const answerTs = await delivery.find(item);
  const completedAt=Math.floor(Date.now()/1000);
  const saved=await store.transition(item.pk, item.status, answerTs ? { status: 'sent', answerTs } : { status: 'uncertain' }, item.status === 'posting' ? { kind: 'posting_guard_elapsed', now: completedAt } : undefined);
  if(!answerTs && saved) return {startedAt,completedAt};
}
export function answerDelivery(client: WebClient, appId: string, requireCompleteThread=false): AnswerDelivery {
  return {
    async validate(item) {
      await requireBotChannel(client, item.sourceChannel);
    },
    async send(item, answer) {
      const response = await client.chat.postMessage({ channel: item.sourceChannel, thread_ts: item.sourceTs, text: escapeSlackText(answer), mrkdwn: false, parse: 'none', link_names: false, reply_broadcast: false, unfurl_links: false, unfurl_media: false, metadata: { event_type: metadataEvents.answer, event_payload: { request_id: item.pk } } });
      return string(response.ts);
    },
    async find(item) {
      let cursor: string | undefined;
      let parentFound=false;
      const cursors=new Set<string>();
      do {
        const page = await client.conversations.replies({ channel: item.sourceChannel, ts: item.sourceTs, limit: 100, cursor, include_all_metadata: true });
        if(page.ok!==true || page.error || !Array.isArray(page.messages) || requireCompleteThread && typeof page.has_more!=='boolean') throw new AppError('answer_reconciliation_incomplete');
        parentFound ||= page.messages.some(message=>message.ts===item.sourceTs);
        const message = page.messages?.find(message => message.app_id === appId && message.metadata?.event_type === metadataEvents.answer && object(message.metadata.event_payload).request_id === item.pk);
        if (message) return string(message.ts);
        cursor = page.response_metadata?.next_cursor;
        if(cursor!==undefined && typeof cursor!=='string' || page.has_more===true && !cursor || cursor && cursors.has(cursor)) throw new AppError('answer_reconciliation_incomplete');
        if(cursor) cursors.add(cursor);
      } while (cursor);
      if(requireCompleteThread && !parentFound) throw new AppError('answer_reconciliation_incomplete');
      return undefined;
    }
  };
}
async function publishDraftControls(store: DraftWorkflowStore, client: WebClient, item: Consultation, config: GroupConfig, audience:ChannelAudience): Promise<void> {
  await requireBotChannel(client, item.sourceChannel);
  await requireBotChannel(client, item.reviewChannel);
  const current = await store.get(item.pk);
  if (!current) throw new AppError('missing_request');
  if (current.status !== 'draft') return;
  const latest = await store.group(config),catalog=await store.knowledge(latest);
  validateDraftBoundary(current,latest,catalog);
  if(current.knowledgeReferences?.length && !current.requesterId) throw new AppError('draft_boundary_changed');
  if(current.requesterId) await validateOriginalReferences(store,client,latest,current.requesterId,current,catalog);
  await validateSharedReferences(store,client,latest,current,catalog,audience.refresh());
  await client.chat.update({ channel: current.reviewChannel, ts: string(current.draftTs), text: escapeSlackText(string(current.draft)), parse: 'full', link_names: false, blocks: approvalBlocks(current) });
}
async function notifyDraft(store: DraftWorkflowStore, client: WebClient, item: Consultation, config: GroupConfig, audience:ChannelAudience): Promise<void> {
  if (!config.notifyUserIds.length) return;
  const current = await store.get(item.pk);
  if (!current) throw new AppError('missing_request');
  if (current.status !== 'draft') return;
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({ channel: current.reviewChannel, ts: string(current.reviewTs), limit: 100, cursor, include_all_metadata: true });
    if (page.messages?.some(message => message.app_id === config.appId && message.metadata?.event_type === metadataEvents.notification && object(message.metadata.event_payload).request_id === current.pk)) return;
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);
  const latest = await store.group(config);
  validateDraftBoundary(current, latest, await store.knowledge(latest));
  await requireBotChannel(client, current.sourceChannel);
  await requireBotChannel(client, current.reviewChannel);
  await validateSharedReferences(store,client,latest,current,await store.knowledge(latest),audience.refresh());
  await client.chat.postMessage({ channel: current.reviewChannel, thread_ts: string(current.reviewTs), text: `${latest.notifyUserIds.map(user => `<@${user}>`).join(' ')} 回答案を確認してください。`, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false, metadata: { event_type: metadataEvents.notification, event_payload: { request_id: current.pk } } });
}
export async function createConsultation(store: DraftWorkflowStore, client: WebClient, workspace: Workspace, eventId: string, channel: string, ts: string, threadTs: string, appId: string, config: GroupConfig, mention: { text: string; botUserId: string; userId:string }): Promise<void> {
  if(!/^[UW][A-Z0-9]+$/.test(mention.userId) || mention.userId===mention.botUserId) throw new AppError('forbidden');
  requireIntake(config, channel);
  requireIdentity(config, { environmentId: config.environmentId, appId, teamId: workspace.teamId });
  if (!config.reviewChannelId) throw new AppError('channel_not_configured');
  await requireBotChannel(client, channel);
  await requireBotChannel(client, config.reviewChannelId);
  const access=new WikiAccess(client,config,mention.userId);
  const audience=new ChannelAudience(client,config,[channel,config.reviewChannelId]);
  await access.member(channel);
  const pk = `request#${appId}#${workspace.teamId}#${eventId}`;
  const now = Math.floor(Date.now() / 1000);
  const initial: Consultation = { pk, environmentId: config.environmentId, appId, configVersion: config.version, groupName: config.name, teamId: workspace.teamId, sourceChannel: channel, sourceTs: threadTs, mentionTs: ts, requesterId:mention.userId, reviewChannel: config.reviewChannelId, status: 'generating', leaseUntil: now + 150 };
  const created = await store.createConsultation(config, initial);
  const item = created ? initial : await store.get(pk);
  if (!item) throw new AppError('missing_request');
  requireIdentity(item as Consultation & { environmentId: string; appId: string }, config);
  if (item.requesterId!==mention.userId) throw new AppError('forbidden');
  if (item.reviewChannel !== config.reviewChannelId) throw new AppError('draft_boundary_changed');
  if (item.status === 'draft') {
    const latest = await store.group(config), catalog = await store.knowledge(config);
    validateDraftBoundary(item, latest, catalog);
    const publicationOwner = randomUUID();
    await store.reservePublication(latest, catalog, publicationOwner);
    await publishDraftControls(store, client, item, config,audience);
    await notifyDraft(store, client, item, config,audience);
    await store.releasePublication(publicationOwner);
    return;
  }
  if (item.status !== 'generating') return;
  if (!created && !await store.transition(pk, 'generating', { leaseUntil: now + 150 }, { kind: 'generation_lease_expired', now })) throw new AppError('generation_in_progress');
  let draft = item.draft;
  let publicationOwner: string | undefined;
  if (!draft) {
    const messages: string[] = [];
    let question = '';
    let cursor: string | undefined;
    let size = 0;
    do {
      const page = await client.conversations.replies({ channel, ts: threadTs, limit: 100, cursor });
      for (const message of page.messages ?? []) {
        if (message.ts === item.mentionTs && typeof message.text === 'string') question = message.text;
        if (message.text) { size += message.text.length; if (size > 40000) throw new AppError('conversation_too_large'); messages.push(message.text); }
      }
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    if (!question) question = mention.text;
    if(question.length>40000 || Buffer.byteLength(question)>120000) throw new AppError('conversation_too_large');
    const secrets = await store.readSecrets();
    const latest = await store.group(config);
    const catalog = await store.knowledge(latest);
    const allowed = (document: import('./groups.js').KnowledgeDocument) => document.channelIds.includes(channel) && document.reviewChannelIds.includes(item.reviewChannel);
    const terms=searchTerms(mention.text);
    const score=(document:import('./groups.js').KnowledgeDocument)=>relevance(document,terms);
    const candidates=[...(catalog.wikiDocuments ?? []).filter(allowed).sort((a,b)=>score(b)-score(a)).slice(0,4),...catalog.documents.filter(document=>!catalog.withheldManualIds?.includes(document.id)).filter(allowed).sort((a,b)=>score(b)-score(a)).slice(0,4)];
    requireIntake(latest,channel);
    if(latest.version!==config.version) throw new AppError('draft_boundary_changed');
    const {visible}=await visibleScopes(client,latest,mention.userId,candidates,access);
    const selected=await shareableDocuments(candidates.filter(document=>visible.has(viewerKey(document))),audience);
    const originals=await retrieveOriginals(store,client,latest,mention.userId,catalog,selected,terms,channel,item.reviewChannel,access,audience);
    const documents=selectAnswerDocuments([...selected,...originals]);
    item.knowledgeReferences = references(documents);
    validateDraftBoundary(item, latest, catalog);
    await validateSharedReferences(store,client,latest,item,catalog,audience);
    publicationOwner = randomUUID();
    await store.reservePublication(latest, catalog, publicationOwner);
    try {
      draft = await generateDraft(secrets.apiKey, secrets.model, messages.join('\n\n'), latest, documents);
      validateAnswerStorage({...item,draft,question,reviewTs:'9999999999.999999'},draft,mention.userId);
      if (!await store.transition(pk, 'generating', { draft, question, knowledgeReferences: item.knowledgeReferences })) throw new AppError('generation_in_progress');
    } catch (error) {
      // Slack投稿前の失敗は所有者を条件に解除する。解除失敗・停止時は期限まで保護する。
      await store.releasePublication(publicationOwner);
      throw error;
    }
  }
  const latest = await store.group(config);
  const currentCatalog = await store.knowledge(latest);
  validateDraftBoundary(item, latest, currentCatalog);
  if (!publicationOwner) {
    publicationOwner = randomUUID();
    await store.reservePublication(latest, currentCatalog, publicationOwner);
  }
  await requireBotChannel(client, item.sourceChannel);
  await requireBotChannel(client, item.reviewChannel);
  await validateOriginalReferences(store,client,latest,mention.userId,item,currentCatalog);
  await validateSharedReferences(store,client,latest,item,currentCatalog,audience.refresh());
  let reviewTs = item.reviewTs;
  if (!reviewTs) {
    // 決定的なmetadataで、投稿成功後にDB保存に失敗したケースを再照合する。
    let cursor: string | undefined;
    do {
      const page = await client.conversations.history({ channel: item.reviewChannel, oldest: item.mentionTs, limit: 100, cursor, include_all_metadata: true });
      const existing = page.messages?.find(message => message.app_id === appId && message.metadata?.event_type === metadataEvents.consultation && object(message.metadata.event_payload).request_id === pk);
      if (existing) { reviewTs = string(existing.ts); break; }
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    if (!reviewTs) {
      const permalink = await client.chat.getPermalink({ channel, message_ts: ts });
      const root = await client.chat.postMessage({ channel: item.reviewChannel, ...consultationDisplay(channel, string(permalink.permalink), mention), mrkdwn: false, parse: 'none', link_names: false, metadata: { event_type: metadataEvents.consultation, event_payload: { request_id: pk } }, unfurl_links: false, unfurl_media: false });
      reviewTs = string(root.ts);
    }
    await store.transition(pk, 'generating', { reviewTs });
  }
  const consultationLink = string((await client.chat.getPermalink({ channel, message_ts: ts })).permalink);
  await client.chat.update({ channel: item.reviewChannel, ts: reviewTs, ...consultationDisplay(channel, consultationLink, mention), parse: 'full', link_names: false });
  // 生成案は相談ごとのスレッドへ配置する。再試行時は既存のbot返信を更新する。
  let draftTs: string | undefined;
  let cursor: string | undefined;
  do {
    const replies = await client.conversations.replies({ channel: item.reviewChannel, ts: reviewTs, limit: 100, cursor, include_all_metadata: true });
    const previous = replies.messages?.find(message => message.app_id === appId && message.metadata?.event_type === metadataEvents.draft && object(message.metadata.event_payload).request_id === pk);
    if (previous) { draftTs = string(previous.ts); break; }
    cursor = replies.response_metadata?.next_cursor;
  } while (cursor);
  await validateSharedReferences(store,client,latest,item,currentCatalog,audience.refresh());
  if (draftTs) {
    await client.chat.update({ channel: item.reviewChannel, ts: draftTs, text: escapeSlackText(draft), parse: 'full', link_names: false, blocks: [] });
  } else {
    const response = await client.chat.postMessage({ channel: item.reviewChannel, thread_ts: reviewTs, text: escapeSlackText(draft), mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false, blocks: [], metadata: { event_type: metadataEvents.draft, event_payload: { request_id: pk } } });
    draftTs = string(response.ts);
  }
  if (!await store.transition(pk, 'generating', { status: 'draft', draft, reviewTs, draftTs })) throw new AppError('generation_in_progress');
  await publishDraftControls(store, client, item, config,audience);
  await notifyDraft(store, client, item, config,audience);
  await store.releasePublication(publicationOwner);
}
export async function authorizeAnswer(client: WebClient, workspace: Workspace, item: Consultation, user: string, config: GroupConfig,audience=new ChannelAudience(client,config,[item.sourceChannel,item.reviewChannel])): Promise<void> {
  audience.requireConfig(config);
  if (item.reviewChannel !== config.reviewChannelId) throw new AppError('forbidden');
  requireIntake(config, item.sourceChannel);
  await authorizeReconciliation(client, workspace, item, user, config);
  if(item.knowledgeReferences?.length && !item.requesterId) throw new AppError('draft_boundary_changed');
  const actorAccess=new WikiAccess(client,config,user);
  const requesterAccess=item.requesterId ? new WikiAccess(client,config,item.requesterId):undefined;
  for(const reference of item.knowledgeReferences ?? []) {
    await audience.require(reference);
    await requireWikiViewer(client,config,user,reference,actorAccess);
    if(item.requesterId) await requireWikiViewer(client,config,item.requesterId,reference,requesterAccess);
  }
}
export async function authorizeReconciliation(client: WebClient, workspace: Workspace, item: Consultation, user: string, identity: GroupIdentity): Promise<void> {
  requireIdentity(item as Consultation & GroupIdentity, identity);
  if (item.teamId !== workspace.teamId) throw new AppError('forbidden');
  await requireBotChannel(client, item.sourceChannel);
  await requireBotChannel(client, item.reviewChannel);
  await requireMember(client, item.reviewChannel, user);
}
