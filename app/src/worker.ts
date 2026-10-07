import type { AnswerStore, AnswerClaimStore, ConsultationStateStore } from './consultation-store.js';
import { isDeepStrictEqual } from 'node:util';
import { planParticipation, participate } from './channel-membership.js';
import { decryptAuthorization, type ChannelAuthorization } from './channel-authorization.js';
import { settingsContent } from './groups.js';
import { diagnosticCode } from './diagnostics.js';
import { randomUUID } from 'node:crypto';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import type { WebClient } from '@slack/web-api';
import { AppError, env, object, string, requireInstalledSecrets, type Consultation } from './contracts.js';
import { Storage, requireSettingsExpiry } from './storage.js';
import { authorizeWorkspace } from './security.js';
import { requireIdentity, requireAdmin, requireIntake, validateGroup, validateDraftBoundary, type GroupConfig, type GroupIdentity } from './groups.js';
import { slackClient, publishHome, editView, requireBotIdentity } from './slack.js';
import { requireAnswerEdit, type AnswerEdit } from './answer-edit.js';
import { requireWikiViewer } from './wiki-access.js';
import { sentAnswerDisplay } from './consultation-display.js';
import { createConsultation, approve, reconcile, answerDelivery, authorizeAnswer, authorizeReconciliation, isAnswerInProgress } from './workflow.js';
import type { AnswerDelivery } from './workflow.js';
import { Registrations, registrationBlocks, configurationKey } from './registration.js';
import { BotMaintenance } from './bot-maintenance.js';
import { knowledgeBlocks, applyKnowledge, knowledgeContent, type KnowledgeReceipt, type KnowledgeHead } from './knowledge-ui.js';
import { wikiHomeBlocks, readableManualDocuments } from './wiki-ui.js';
import { enqueueWiki } from './wiki-queue.js';
import { fetchOriginalQuestion } from './answer-question.js';
import { ChannelAudience } from './channel-audience.js';
import { validateOriginalReferences, validateSharedReferences } from './wiki-retrieval.js';
const settingsFailureNotices: Record<string, string> = {
  bot_not_in_channel: '設定を保存できませんでした。相談受付・対応先にはBotが参加する有効なチャンネルを選んでください。アーカイブ済みなら解除するか、有効な別チャンネルを選び、設定を開き直してください。',
  external_channel_not_supported: '設定を保存できませんでした。外部共有中・共有待ちのチャンネルは利用できません。組織内の相談受付・対応先を選び、設定を開き直してください。',
  channel_authorization_required: '設定を保存できませんでした。本人の招待認可が未保存・失効、または必要な権限が不足しています。このBotのHomeで「非公開招待を本人認可」を押し、新しいリンクから今の操作者本人としてgroups:readとgroups:write.invitesを認可してください。同じ承認リンクは再使用せず、その後、設定を開き直して保存してください。',
  settings_confirmation_required: '設定処理が中断し、参加検査の結果を確認できません。この要求は自動適用しません。Botの参加状況と本人認可を確認し、設定を開き直して新しく保存してください。',
  channel_authorization_boundary: '設定を保存できませんでした。本人の招待認可と現在のApp・ワークスペース・操作者の一致を確認できないか、認可操作が競合しました。環境管理者に接続先と認可状態の確認を依頼してください。確認と本人認可を済ませた後、設定を開き直して新しく保存してください。この設定要求を後から自動適用しません。',
  channel_invitation_forbidden: '設定を保存できませんでした。非公開先の所属またはSlackの招待権限・制限を確認してください。本人認可済みでもSlackが招待を許可しない場合は、チャンネル管理者へBotの手動招待を依頼してください。',
  channel_join_scope_required: '設定を保存できませんでした。Botの権限構成が最新仕様の7件と一致しません。環境管理者にManifestとインストールの確認を依頼してください。確認後に新しい設定を開き直してください。',
  channel_join_forbidden: '設定を保存できませんでした。Slackのチャンネル参加制限を環境管理者に確認し、参加可能な公開先を選んで設定を開き直してください。',
  channel_network_restricted: '設定を保存できませんでした。現在の接続ネットワークからSlack APIを呼び出せません。環境管理者にネットワークのアクセス制限を確認し、解消後に設定を開き直してください。',
  channel_admin_restricted: '設定を保存できませんでした。Slack管理者が操作を停止しています。環境管理者に管理設定の確認と解除を依頼し、解消後に設定を開き直してください。',
  channel_enterprise_restricted: '設定を保存できませんでした。このEnterprise構成から対象のSlack APIを呼び出せません。環境管理者に利用可能なワークスペース構成を確認し、設定を開き直してください。',
  channel_mfa_required: '設定を保存できませんでした。Slackが二要素認証の設定を要求しています。操作者の二要素認証と管理ポリシーを確認し、解消後に設定を開き直してください。',
  channel_access_restricted: '設定を保存できませんでした。対象チャンネルまたはワークスペースへのアクセスが制限されています。環境管理者に本人とBotのアクセス範囲・所属を確認し、許可された先を選んで設定を開き直してください。',
  channel_capacity_restricted: '設定を保存できませんでした。チャンネルの所属人数またはゲストの参加数が上限に達しています。環境管理者に上限と所属を確認し、利用可能な先を選んで設定を開き直してください。'
};
const knowledgeFailureNotices: Record<string, string> = {
  settings_conflict: '設定または資料が別の操作で更新されたため保存できませんでした。資料一覧を開き直し、最新の内容で登録・編集・削除してください。',
  intake_channel_not_allowed: '資料を保存できませんでした。相談の公開先を現在の受付チャンネルから選び直してください。',
  review_channel_not_allowed: '資料を保存できませんでした。全文閲覧の公開先を現在の対応チャンネルから選び直してください。',
  invalid_knowledge: '資料を保存できませんでした。資料は12件まで、本文は8192 UTF-8 bytes、全体は120000 bytes以内です。IDと入力内容を確認して資料一覧からやり直してください。',
  wiki_membership_incomplete: '所属確認の上限に達したため、資料は保存していません。未確認は権限なし・不存在を意味しません。資料一覧で閲覧範囲を確認し、所属確認を完了できる範囲で操作をやり直してください。',
  forbidden: '管理権限が変更されたため資料を保存できませんでした。現在の管理者へ依頼してください。'
};
async function prepareAnswerEdit(store: Storage, client: WebClient, workspace: Awaited<ReturnType<Storage['workspace']>>, config: GroupConfig, item: Consultation, payload: Record<string, unknown>, botUserId: string,audience:ChannelAudience): Promise<void> {
  requireSettingsExpiry(payload.expiresAt);
  const receipt: AnswerEdit = { pk: string(payload.receiptId), environmentId: config.environmentId, appId: config.appId, teamId: config.teamId, actorId: string(payload.userId), requestId: item.pk, draftTs: string(item.draftTs), configVersion: config.version, viewId: string(payload.viewId), expiresAt: payload.expiresAt as number };
  if (!/^answer-edit#[a-f0-9]{32}$/.test(receipt.pk)) throw new AppError('forbidden');
  const catalog = await store.knowledge(config);
  validateDraftBoundary(item, config, catalog);
  await validateOriginalReferences(store,client,config,string(payload.userId),item,catalog);
  const owner = randomUUID();
  await store.reservePublication(config, catalog, owner);
  let current: Consultation;
  try {
    const saved = await store.get<Consultation>(item.pk);
    if (!saved || saved.status !== 'draft' || saved.draftTs !== receipt.draftTs) throw new AppError('invalid_status');
    current = saved;
    if (!await store.create({ ...receipt })) {
      const previous = await requireAnswerEdit(store, config, receipt.actorId, receipt.viewId, receipt.pk);
      if (!isDeepStrictEqual(previous, receipt)) throw new AppError('forbidden');
    }
    await requireBotIdentity(client, workspace.teamId, botUserId);
    await authorizeAnswer(client, workspace, current, receipt.actorId, config,audience.refresh());
    const latest = await store.group(config), latestCatalog = await store.knowledge(config);
    if (latest.publicationOwner !== owner || !latest.postingUntil || latest.postingUntil <= Math.floor(Date.now()/1000) || latest.version !== config.version || latestCatalog.version !== catalog.version) throw new AppError('settings_conflict');
    validateDraftBoundary(current, latest, latestCatalog);
    await validateSharedReferences(store,client,latest,current,latestCatalog,audience);
    requireSettingsExpiry(receipt.expiresAt);
  } catch (error) {
    await store.releasePublication(owner);
    throw error;
  }
  try { await client.views.update({ view_id: receipt.viewId, hash: string(payload.viewHash), view: editView(current, receipt.pk) }); }
  catch (error) {
    // 再配送で入力済みの画面を上書きしない。閉じた画面にも再表示しない。
    if (!['slack_hash_conflict','slack_not_found'].includes(diagnosticCode(error))) throw error;
  }
  await store.releasePublication(owner);
}
async function knowledgeNotice(store: Storage, identity: GroupConfig, user: string): Promise<KnowledgeReceipt | undefined> {
  const head = await store.get<KnowledgeHead>(`knowledge-user#${user}`);
  if (!head || head.expiresAt <= Math.floor(Date.now()/1000)) return;
  requireIdentity(head, identity);
  if (head.userId !== user) throw new AppError('forbidden');
  const receipt = await store.get<KnowledgeReceipt>(`knowledge#${head.requestId}`);
  if (!receipt || receipt.expiresAt <= Math.floor(Date.now()/1000)) return;
  requireIdentity(receipt, identity);
  if (receipt.userId !== user || receipt.requestId !== head.requestId) throw new AppError('forbidden');
  return receipt.status === 'saved' || receipt.status === 'failed' ? receipt : undefined;
}
function channelAuthorizationBlock(authorization: ChannelAuthorization | undefined, config: GroupConfig, user: string): Parameters<typeof publishHome>[6] {
  if (!authorization || authorization.environmentId !== config.environmentId || authorization.appId !== config.appId || authorization.teamId !== config.teamId || authorization.userId !== user || authorization.pk !== `channel-user#${user}`) return;
  if (authorization.scopeExcess) return 'scope_excess';
  if (authorization.scopeCheckOwner !== undefined) return 'pending';
}
async function publishKnowledgeResult(store: Storage, client: ReturnType<typeof slackClient>, workspace: Awaited<ReturnType<Storage['workspace']>>, config: GroupConfig, receipt: KnowledgeReceipt, extra: Parameters<typeof publishHome>[5] = []): Promise<void> {
  if (!config.adminIds.includes(receipt.userId)) return;
  const head = await store.get<KnowledgeHead>(`knowledge-user#${receipt.userId}`);
  if (!head || head.requestId !== receipt.requestId || receipt.expiresAt <= Math.floor(Date.now()/1000)) return;
  const status = receipt.status;
  if (status !== 'saved' && status !== 'failed') throw new AppError('invalid_input');
  const message = status === 'saved' ? '専用資料を保存しました。資料を変更・削除した場合、古い回答案は送信できません。' : knowledgeFailureNotices[string(receipt.failureCode)];
  if (!message) throw new AppError('invalid_input');
  const catalog = await store.knowledge(config), owner = randomUUID();
  await store.reserveKnowledgeNotice(config, catalog, receipt, status, owner);
  const {documents,incomplete} = await readableManualDocuments(store,client,config,receipt.userId);
  await publishHome(client, workspace, receipt.userId, message, config, [...wikiHomeBlocks(true),...knowledgeBlocks({...catalog,documents},incomplete), ...extra], channelAuthorizationBlock(await store.get<ChannelAuthorization>(`channel-user#${receipt.userId}`), config, receipt.userId));
  await store.releaseKnowledgeNotice(receipt.userId, owner);
}
async function processJob(raw: string): Promise<void> {
  const job = object(JSON.parse(raw));
  if (job.kind === 'answer') throw new AppError('invalid_input');
  const payload = object(job.payload);
  const workSignal = AbortSignal.timeout(105000);
  const registrations = new Registrations(env('TABLE_NAME'), env('SECRET_ARN'), workSignal);
  if(job.botId!==undefined) {
    const id=string(job.botId),entry=(await registrations.read()).entries.find(item=>item.id===id);
    const reconciliation=job.kind==='reconcile' || job.kind==='review' && payload.action==='reconcile';
    if(!entry || entry.deletion && !reconciliation) {
      const resolved=await new BotMaintenance(registrations,workSignal).browserBot(id);
      requireIdentity(payload as unknown as GroupIdentity,{environmentId:string(resolved.entry.secretArn),appId:string(resolved.entry.appId),teamId:resolved.entry.teamId});
      return;
    }
  }
  const child = job.botId === undefined ? undefined : await registrations.child(string(job.botId), true,job.kind==='reconcile' || job.kind==='review' && payload.action==='reconcile');
  const store = child?.store ?? new Storage(env('TABLE_NAME'), env('SECRET_ARN'), workSignal);
  const workspace = await store.workspace();
  authorizeWorkspace(workspace, string(payload.teamId));
  const secrets = requireInstalledSecrets(await store.readSecrets());
  const identity = { environmentId: child ? string(child.entry.secretArn) : env('SECRET_ARN'), appId: secrets.appId, teamId: workspace.teamId };
  requireIdentity(payload as unknown as typeof identity, identity);
  const client = slackClient(secrets.botToken, workSignal);
  await requireBotIdentity(client, workspace.teamId, secrets.botUserId);
  const rawGroup = await store.get<GroupConfig>('roughmate');
  if (!rawGroup && job.kind === 'home') { await publishHome(client, workspace, string(payload.userId), '既存設定の移行が必要です。管理者は migrate-config を実行してください。'); return; }
  const config = await store.group(identity);
  if(config.lifecycle && job.kind!=='reconcile' && !(job.kind==='review' && payload.action==='reconcile')) return;
  switch (job.kind) {
    case 'mention': {
      requireIntake(config, string(payload.channel));
      if (!string(payload.text).includes(`<@${secrets.botUserId}>`)) throw new AppError('mention_not_for_this_bot');
      await createConsultation(store, client, workspace, string(payload.eventId), string(payload.channel), string(payload.ts), string(payload.threadTs), secrets.appId, config, { text: string(payload.text), botUserId: secrets.botUserId, userId:string(payload.userId) });
      break;
    }
    case 'home': {
      const user = string(payload.userId);
      const extra = [...wikiHomeBlocks(config.adminIds.includes(user))];
      let channelAuthorization: Parameters<typeof publishHome>[6];
      const owner = randomUUID();
      const home = !child && process.env.PROVISION_QUEUE_URL && user === workspace.ownerId ? await registrations.reserveHome(await registrations.read(), owner) : undefined;
      if (home) extra.push(...registrationBlocks(home, (await store.get<{ phase: string }>(configurationKey))?.phase === 'ready'));
      if (config.adminIds.includes(user)) {
        const authorization = await store.get<ChannelAuthorization>(`channel-user#${user}`);
        let connected = false;
        channelAuthorization = channelAuthorizationBlock(authorization, config, user);
        if (authorization) {
          try { decryptAuthorization(secrets, authorization, config, user); connected = true; }
          catch (error) { if (!(error instanceof AppError) || !['channel_authorization_required','group_boundary_mismatch'].includes(error.code)) throw error; }
        }
        extra.push({ type: 'section' as const, text: { type: 'plain_text' as const, text: channelAuthorization === 'scope_excess' ? '本人OAuthに余剰権限があり、同じAppの新しい認可リンクは発行しません。環境管理者が対象の専用Slack Appを削除し、最新Manifestで再作成してください。有効な保存済み認可はこの失敗だけでは解除しません。停止する場合は本人の招待認可を解除してください。' : channelAuthorization === 'pending' ? '新規認可の失敗だけでは保存済み本人認可を解除しません。停止する場合は「本人の招待認可を解除」を操作してください。' : connected ? '非公開招待の本人認可を保存済みです。招待時にSlackへ本人・有効性を再確認します。' : '非公開招待は本人未認可・解除済み・失効状態です。必要なら「非公開招待を本人認可」を開いてください。' } });
        const result = await knowledgeNotice(store, config, user);
        if (result) { await publishKnowledgeResult(store, client, workspace, config, result, extra); if (home) await registrations.releaseHome(home, owner); break; }
        const catalog=await store.knowledge(identity);
        const {documents,incomplete}=await readableManualDocuments(store,client,config,user);
        extra.unshift(...knowledgeBlocks({...catalog,documents},incomplete));
      }
      const intakeNotice = `受付: ${config.intakeChannelIds.map(channel => `<#${channel}>`).join('、') || '未設定（相談受付停止中）'}。${config.intakeChannelIds.length ? `このBotの受付チャンネルで ${config.name} にメンションしてください。` : '受付チャンネルが未選択のため、メンションしても回答案を生成しません。管理者はこのBotのHomeで受付チャンネルを選んで保存してください。'}`;
      await publishHome(client, workspace, user, config.reviewChannelId ? `対応用チャンネル: <#${config.reviewChannelId}>。${intakeNotice}対応チャンネルのメンバーは誰でも採用・編集できます。通知メンション先は任意です。` : `${config.intakeChannelIds.length ? '' : intakeNotice}対応用チャンネルが未設定です。設定担当者が受付・対応先を選んで保存すると公開先へ自動参加します。非公開先はHomeで操作者本人の招待認可を済ませてから保存してください。`, config, extra, channelAuthorization);
      if (home) await registrations.releaseHome(home, owner);
      break;
    }
    case 'knowledge': {
      let accepted = await store.get<KnowledgeReceipt>(`knowledge#${string(payload.requestId)}`);
      const { isDeepStrictEqual } = await import('node:util');
      if (!accepted || !isDeepStrictEqual(payload, knowledgeContent(accepted))) throw new AppError('forbidden');
      requireIdentity(accepted, identity);
      if (accepted.expiresAt <= Math.floor(Date.now()/1000)) return;
      const head = await store.get<KnowledgeHead>(`knowledge-user#${accepted.userId}`);
      if (!head || head.requestId !== accepted.requestId) return;
      requireIdentity(head, identity);
      if (head.userId !== accepted.userId) throw new AppError('forbidden');
      if (!accepted.status || accepted.status === 'pending') {
        try {
          if(accepted.document?.channelIds.some(channel=>!config.intakeChannelIds.includes(channel))) throw new AppError('intake_channel_not_allowed');
          if(accepted.document?.reviewChannelIds.some(channel=>channel!==config.reviewChannelId)) throw new AppError('review_channel_not_allowed');
          const documentId=accepted.document?.id ?? accepted.deleteId;
          const current=(await store.knowledge(config)).documents.find(document=>document.id===documentId);
          if(current) await requireWikiViewer(client,config,accepted.userId,current);
          if(accepted.document) await requireWikiViewer(client,config,accepted.userId,accepted.document);
          await applyKnowledge(store, config, accepted);
        }
        catch (error) {
          if (!(error instanceof AppError) || !Object.hasOwn(knowledgeFailureNotices, error.code)) throw error;
          const latest = await store.group(identity);
          const catalog = await store.knowledge(identity);
          if (error.code === 'settings_conflict' && latest.version === accepted.configVersion && catalog.version === accepted.catalogVersion && latest.adminIds.includes(accepted.userId)) throw error;
          const current = await store.get<KnowledgeReceipt>(`knowledge#${accepted.requestId}`);
          if (!current) throw new AppError('forbidden');
          if (current.status !== 'saved' && current.status !== 'failed') await store.rejectKnowledge(latest, accepted, error.code);
        }
        accepted = await store.get<KnowledgeReceipt>(`knowledge#${accepted.requestId}`);
        if (!accepted) throw new AppError('forbidden');
      }
      const latest = await store.group(identity);
      if(accepted.status==='saved') {
        // 旧receiptも元の版を再配送する。整理状態の欠落は通常利用を保留し、workerで保存してから処理する。
        const keys=accepted.wikiTasks===undefined ? (accepted.document ? [`manual:${accepted.document.id}:${accepted.document.version}`]:[]):accepted.wikiTasks;
        if(!Array.isArray(keys) || keys.length>12 || keys.some(key=>typeof key!=='string' || !/^manual:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:[1-9]\d*$/.test(key))) throw new AppError('invalid_wiki_task');
        for(const key of keys) await enqueueWiki(identity,job.botId,key);
      }
      await publishKnowledgeResult(store, client, await store.workspace(), latest, accepted);
      break;
    }
    case 'settings': {
      const user = string(payload.userId);
      requireSettingsExpiry(payload.expiresAt);
      if (workspace.settingsVersion !== payload.version || workspace.settingsRequestId !== payload.requestId) return;
      const next = validateGroup(payload.config);
      requireIdentity(next, identity);
      if (config.lastRequestId === next.lastRequestId && config.version === next.version) { await publishHome(client, workspace, user, '設定を保存しました。', config, [], channelAuthorizationBlock(await store.get<ChannelAuthorization>(`channel-user#${user}`), config, user)); break; }
      requireAdmin(config, user);
      if (config.version !== payload.previousVersion || next.version !== config.version + 1) throw new AppError('settings_conflict');
      const requestId = string(payload.requestId);
      const receipt = await store.get<{ teamId: string; actorId?: string; version: number; expiresAt: number; config: GroupConfig; failureCode?: string; attemptOwner?: string; attemptUntil?: number; attemptRetryable?: boolean; inviteGeneration?: string }>(`settings#${requestId}`);
      if (!receipt || receipt.teamId !== identity.teamId || receipt.version !== payload.version || receipt.expiresAt !== payload.expiresAt || receipt.actorId !== user || !isDeepStrictEqual(settingsContent(receipt.config), settingsContent(next))) throw new AppError('forbidden');
      let failure = receipt.failureCode;
      let participation: { owner: string; generation?: string } | undefined;
      const attemptOwner = randomUUID();
      let generation = receipt.inviteGeneration;
      if (!failure && receipt.attemptOwner && !receipt.attemptRetryable) {
        if (!receipt.attemptUntil || receipt.attemptUntil > Math.floor(Date.now()/1000)) throw new AppError('settings_conflict');
        await store.rejectSettings(config, user, { id: requestId, version: payload.version as number }, 'settings_confirmation_required');
        failure = (await store.get<{ failureCode?: string }>(`settings#${requestId}`))?.failureCode;
        if (!failure) throw new AppError('settings_conflict');
      }
      if (!failure) {
        try { await store.beginSettingsAttempt(config, user, { id: requestId, version: payload.version as number }, attemptOwner); }
        catch (error) {
          const current = await store.get<{ attemptOwner?: string }>(`settings#${requestId}`);
          if (current?.attemptOwner !== attemptOwner) throw error;
        }
        try {
          if (generation) {
            const authorization = await store.get<ChannelAuthorization>(`channel-user#${user}`);
            if (!authorization || authorization.generation !== generation || !authorization.cipher) throw new AppError('channel_authorization_required');
          }
          const plan = await planParticipation(store, client, config, secrets, user, [...next.intakeChannelIds, string(next.reviewChannelId)]);
          if (plan.length) {
            const plannedGeneration = plan.find(item => item.private)?.generation;
            if (generation && plannedGeneration && generation !== plannedGeneration) throw new AppError('channel_authorization_required');
            generation ??= plannedGeneration;
            participation = { owner: attemptOwner, generation };
            await store.reserveSettingsChannels(config, user, { id: requestId, version: payload.version as number }, participation.owner, participation.generation);
            const guard = async () => {
              requireSettingsExpiry(payload.expiresAt);
              const latest = await store.group(identity);
              const currentWorkspace = await store.workspace();
              if (latest.version !== config.version || !latest.adminIds.includes(user) || latest.publicationOwner !== participation!.owner || !latest.postingUntil || latest.postingUntil <= Math.floor(Date.now()/1000)+3 || currentWorkspace.settingsNoticeOwner !== participation!.owner || currentWorkspace.settingsVersion !== payload.version || currentWorkspace.settingsRequestId !== requestId) throw new AppError('settings_conflict');
              if (participation!.generation) {
                const authorization = await store.get<ChannelAuthorization>(`channel-user#${user}`);
                if (!authorization || authorization.generation !== participation!.generation) throw new AppError('channel_authorization_required');
              }
            };
            const startInvite = async (channel: string, inviteGeneration: string) => {
              try { await store.startChannelInvite(config, user, { id: requestId, version: payload.version as number }, participation!.owner, inviteGeneration, channel); }
              catch (error) {
                if (error instanceof AppError && error.code === 'settings_conflict') {
                  const current = await store.get<ChannelAuthorization>(`channel-user#${user}`);
                  if (!current || current.generation !== inviteGeneration || !current.cipher) throw new AppError('channel_authorization_required');
                }
                throw error;
              }
            };
            await participate(client, secrets, config, plan, guard, startInvite);
          }
        } catch (error) {
          if (!(error instanceof AppError) || !Object.hasOwn(settingsFailureNotices, error.code)) {
            await store.retrySettingsAttempt(user, { id: requestId, version: payload.version as number }, attemptOwner);
            throw error;
          }
          try { await store.rejectSettings(config, user, { id: requestId, version: payload.version as number }, error.code); }
          catch (writeError) {
            failure = (await store.get<{ failureCode?: string }>(`settings#${requestId}`))?.failureCode;
            if (!failure) throw writeError;
          }
          failure = (await store.get<{ failureCode?: string }>(`settings#${requestId}`))?.failureCode;
          if (!failure) throw new AppError('settings_conflict');
        }
      }
      if (failure) {
        if (!Object.hasOwn(settingsFailureNotices, failure)) throw new AppError('invalid_input');
        const cleanupOwner = participation?.owner ?? receipt.attemptOwner;
        const protectedWorkspace = await store.workspace(), protectedGroup = await store.group(identity);
        if (cleanupOwner && protectedWorkspace.settingsNoticeOwner === cleanupOwner && protectedGroup.publicationOwner === cleanupOwner) {
          await store.releaseSettingsNotice(cleanupOwner);
          const authorization = await store.get<ChannelAuthorization>(`channel-user#${user}`);
          if ((authorization as ChannelAuthorization & { inviteOwner?: string } | undefined)?.inviteOwner === cleanupOwner) await store.releaseChannelInvite(user, cleanupOwner);
        }
        const latestWorkspace = await store.workspace();
        authorizeWorkspace(latestWorkspace, identity.teamId);
        const latest = await store.group(identity);
        requireSettingsExpiry(payload.expiresAt);
        if (latestWorkspace.settingsVersion !== payload.version || latestWorkspace.settingsRequestId !== requestId || latest.version !== config.version || !latest.adminIds.includes(user)) return;
        const owner = randomUUID();
        await store.reserveSettingsNotice(latest, user, { id: requestId, version: payload.version as number }, owner);
        await publishHome(client, latestWorkspace, user, settingsFailureNotices[failure], latest, [], channelAuthorizationBlock(await store.get<ChannelAuthorization>(`channel-user#${user}`), latest, user));
        await store.releaseSettingsNotice(owner);
        break;
      }
      try { await store.saveGroup(config, next, user, { id: requestId, version: payload.version as number, owner: attemptOwner, generation }, participation); }
      catch (error) {
        const latest = await store.group(identity);
        if (latest.lastRequestId !== next.lastRequestId || latest.version !== next.version) await store.retrySettingsAttempt(user, { id: requestId, version: payload.version as number }, attemptOwner);
        throw error;
      }
      await publishHome(client, workspace, user, '受付・対応先・任意通知の設定を保存しました。', next, [], channelAuthorizationBlock(await store.get<ChannelAuthorization>(`channel-user#${user}`), next, user));
      break;
    }
    case 'review':
    case 'reconcile': {
      let saved = await store.get<Consultation>(string(payload.requestId));
      if (!saved) throw new AppError('missing_request');
      if (saved.answerCancellation) {
        requireIdentity(saved as Consultation & GroupIdentity, identity);
        if (job.kind === 'review' && payload.draftTs !== saved.draftTs) throw new AppError('forbidden');
        await store.recoverAnswerCancellation(saved);
        saved = await store.get<Consultation>(saved.pk);
        if (!saved) throw new AppError('missing_request');
      }
      const item = saved;
      const audience=new ChannelAudience(client,config,[item.sourceChannel,item.reviewChannel]);
      const readOnly = job.kind === 'reconcile' || payload.action === 'reconcile' || item.status === 'posting' || item.status === 'uncertain' || item.status === 'sent';
      if (job.kind === 'review') {
        if (!['adopt','edit','reconcile','answer'].includes(string(payload.action)) || payload.draftTs !== item.draftTs || !readOnly && payload.configVersion !== config.version) throw new AppError('forbidden');
        if (!readOnly && payload.action === 'answer') {
          const receipt = await requireAnswerEdit(store, config, string(payload.userId), string(payload.viewId), string(payload.receiptId));
          if (receipt.requestId !== item.pk || receipt.draftTs !== item.draftTs) throw new AppError('forbidden');
        }
      }
      await authorizeReconciliation(client, workspace, item, string(payload.userId), identity);
      if(!readOnly) {
        try { validateDraftBoundary(item,config,await store.knowledge(identity)); }
        catch(error) {
          if(error instanceof AppError && ['knowledge_changed','draft_boundary_changed','intake_channel_not_allowed'].includes(error.code)) await client.chat.update({channel:item.reviewChannel,ts:string(item.draftTs),text:'資料の版・公開先または相談設定が変わったため、この案は送信できません。現在の受付チャンネルで新しく相談してください。',blocks:[]});
          throw error;
        }
        await authorizeAnswer(client,workspace,item,string(payload.userId),config,audience);
      }
      if (item.status === 'generating') throw new AppError('generation_in_progress');
      if (!item.draftTs) throw new AppError('missing_request');
      if (!readOnly && job.kind === 'review' && payload.action === 'edit') {
        if (item.status !== 'draft') throw new AppError('invalid_status');
        await prepareAnswerEdit(store, client, workspace, config, item, payload, secrets.botUserId,audience);
        break;
      }
      const consultationState: ConsultationStateStore = store;
      const delivery = answerDelivery(client, secrets.appId, config.lifecycle==='stopping');
      if (!item.question && item.status!=='sent') {
        try {
          const original=await fetchOriginalQuestion(client,item);
          if(original && await consultationState.transition(item.pk,item.status,{question:original.text,questionCapture:original},{kind:'question_missing'})) {
            item.question=original.text;item.questionCapture=original;
          }
        } catch(error) {
          if(!readOnly) throw error;
          // 原質問の失敗で、Slackで確認できる送信を未確定のままにしない。
        }
      }
      if (readOnly) {
        const missing=await reconcile(consultationState, delivery, item);
        if(missing && config.lifecycle==='stopping' && config.publicationKind==='answer' && !await store.wiki.finishStoppedUncertain({...item,status:'uncertain'},config,missing)) throw new AppError('answer_state_conflict');
      }
      else if (item.status === 'draft') {
        const catalog = await store.knowledge(identity);
        validateDraftBoundary(item,config,catalog);
        const answerStore: AnswerClaimStore = store;
        const guardedStore: AnswerStore = { get: (pk: string) => answerStore.get(pk), cancelAnswerClaim: current => answerStore.cancelAnswerClaim(current), transition: (pk, from, patch, condition) => from === 'draft' && patch.status === 'posting' ? answerStore.claimAnswer(item, patch, config, catalog) : answerStore.transition(pk, from, patch, condition) };
        const verifiedDelivery: AnswerDelivery = {
          ...delivery,
          async validate(current) {
            const latest = await store.group(identity), latestCatalog = await store.knowledge(latest);
            if (latest.version !== config.version || latestCatalog.version !== catalog.version) throw new AppError('settings_conflict');
            validateDraftBoundary(current, latest, latestCatalog);
            await validateOriginalReferences(store,client,latest,string(payload.userId),current,latestCatalog);
            if(current.status==='posting') await store.wiki.preflightSent(current);
            if (job.kind === 'review' && payload.action === 'answer') await requireAnswerEdit(store, latest, string(payload.userId), string(payload.viewId), string(payload.receiptId));
            await requireBotIdentity(client, workspace.teamId, secrets.botUserId);
            await authorizeAnswer(client, workspace, current, string(payload.userId), latest,audience.refresh());
            await validateSharedReferences(store,client,latest,current,latestCatalog,audience);
          }
        };
        await approve(guardedStore, verifiedDelivery, item, typeof payload.answer === 'string' ? payload.answer : string(item.draft), string(payload.userId));
      }
      if(config.lifecycle) break;
      const current = await store.get<Consultation>(item.pk);
      if (!current?.draftTs) throw new AppError('missing_request');
      if (current.status === 'draft' || isAnswerInProgress(current)) break;
      if(current.status==='sent') {
        try {
          if(current.answer) {
            await validateSharedReferences(store,client,await store.group(identity),current,await store.knowledge(identity),audience.refresh());
            await client.chat.update({channel:current.reviewChannel,ts:current.draftTs,parse:'full',link_names:false,...sentAnswerDisplay(current)});
          }
        } finally {
          // 表示の認可失敗でも、確定回答の学習待ちを取り残さない。
          if(current.wikiAnswerId) await enqueueWiki(identity,job.botId,current.wikiAnswerId);
        }
      } else await client.chat.update({ channel: current.reviewChannel, ts: current.draftTs, parse: 'full', link_names: false, text: '送信状態が不明です。元スレッドを確認してください。自動再送は行いません。', blocks: [{ type: 'section' as const, text: { type: 'plain_text' as const, text: '送信状態が不明です。元スレッドを確認し、再照合してください。自動再送は行いません。' } }, { type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'reconcile', text: { type: 'plain_text' as const, text: '送信結果を再照合' }, value: current.pk }] }] });
      break;
    }
    default: throw new AppError('invalid_input');
  }
}
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try { await processJob(record.body); }
    catch (error) { process.stderr.write(JSON.stringify({ event: 'roughmate_worker_failed', code: diagnosticCode(error), messageId: record.messageId }) + '\n'); failures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures: failures };
}
