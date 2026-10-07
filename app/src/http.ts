import { proposalActions, acceptProposalSubmission } from './wiki-proposal-slack.js';
import { wikiWeb } from './wiki-web.js';
import { BotMaintenance } from './bot-maintenance.js';
import { protectWikiView, resolveWikiViewValue } from './wiki-view-state.js';
import { ErrorCode, type View } from '@slack/web-api';
import { randomBytes } from 'node:crypto';
import { beginChannelAuthorization, completeChannelAuthorization } from './channel-authorization.js';
import { RequestDeadline, SLACK_REQUEST_BUDGET_MS } from './deadline.js';
import { diagnosticCode } from './diagnostics.js';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { AppError, env, object, string, requireInstalledSecrets, type QueueJob, type Consultation } from './contracts.js';
import { verifySignature, stateKey, authorizeOwner, authorizeWorkspace } from './security.js';
import { Storage, requireSettingsExpiry } from './storage.js';
import { requireAdmin, requireIntake, requireIdentity, validateGroup, validateSetupSeed, settingsContent, type GroupConfig } from './groups.js';
import { botScopes, slackClient, settingsView, preparingEditView, requireBotIdentity } from './slack.js';
import { requireAnswerEdit } from './answer-edit.js';
import { Registrations, registrationView, configurationKey } from './registration.js';
import { beginInstall, installChild, OAUTH_CALLBACK_BUDGET_MS } from './provisioner.js';
import { knowledgeView, requestKnowledge, submittedDocument, knowledgeContent, type KnowledgeReceipt } from './knowledge-ui.js';
import { wikiPreparingView, submittedWikiCommand, acceptWikiCommand } from './wiki-ui.js';
import type { WikiCommand } from './wiki-worker.js';
const queue = new SQSClient({ maxAttempts: 1, requestHandler: { requestTimeout: 900, throwOnRequestTimeout: true, connectionTimeout: 500 } });
async function enqueue(job: QueueJob, abortSignal?: AbortSignal): Promise<void> {
  await queue.send(new SendMessageCommand({ QueueUrl: env(['wiki','wiki_ui','wiki_command','wiki_adoption'].includes(job.kind) ? 'WIKI_QUEUE_URL':'QUEUE_URL'), MessageBody: JSON.stringify(job) }), { abortSignal });
}
async function oauthCallback(event: APIGatewayProxyEventV2, deadline: RequestDeadline): Promise<APIGatewayProxyStructuredResultV2> {
  const store = new Storage(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal);
  const secrets = await deadline.step(() => store.readSecrets());
  const rawSeed = await deadline.step(() => store.get('roughmate#setup'));
  const seed = rawSeed ? validateSetupSeed(rawSeed) : undefined;
  if (seed && seed.appId !== secrets.appId) throw new AppError('group_boundary_mismatch');
  const progress = await deadline.step(() => store.get<{ appId: string; phase: string; scopeExcess?: boolean }>('setup#slack'));
  if (progress && (progress.appId !== secrets.appId || progress.phase !== 'created')) throw new AppError('group_boundary_mismatch');
  const state = string(event.queryStringParameters?.state);
  const parameters = event.queryStringParameters;
  if (secrets.botToken !== undefined) {
    const expected = await deadline.step(() => store.get<{ teamId?: string; ownerId?: string; expiresAt: number; consumed?: boolean }>(stateKey(state)));
    const workspace = await deadline.step(() => store.workspace());
    if (!expected || expected.consumed || expected.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('invalid_state');
    if (expected.teamId !== workspace.teamId || expected.ownerId !== workspace.ownerId) throw new AppError('forbidden');
    const currentGroup = await deadline.step(() => store.get('roughmate'));
    if (currentGroup) requireIdentity(validateGroup(currentGroup), { environmentId: env('SECRET_ARN'), appId: secrets.appId, teamId: workspace.teamId });
    if (parameters?.error !== undefined && (parameters.error !== 'access_denied' || parameters.code !== undefined)) throw new AppError('invalid_input');
    if (parameters?.error === undefined) string(parameters?.code);
    const installed = requireInstalledSecrets(secrets);
    await deadline.step(() => requireBotIdentity(slackClient(installed.botToken, deadline.signal), workspace.teamId, installed.botUserId));
  }
  if (progress?.scopeExcess) {
    await deadline.step(() => store.consumeState(stateKey(state), Math.floor(Date.now()/1000)));
    throw new AppError('root_oauth_scope_excess');
  }
  if (parameters?.error !== undefined) {
    await deadline.step(() => store.consumeState(stateKey(state), Math.floor(Date.now()/1000)));
    if (parameters.error !== 'access_denied' || parameters.code !== undefined) throw new AppError('invalid_input');
    throw new AppError('root_oauth_denied');
  }
  const code = string(parameters?.code);
  const attempt = stateKey(state);
  const expected = await deadline.step(() => store.beginRootOAuth(secrets.appId, attempt, Math.floor(Date.now()/1000)));
  let result;
  try { result = await deadline.step(() => slackClient(undefined, deadline.signal).oauth.v2.access({ client_id: secrets.clientId, client_secret: secrets.clientSecret, code, redirect_uri: env('PUBLIC_URL') + '/oauth/callback' })); }
  catch (error) {
    const value = error as { code?: string; data?: Record<string,unknown> };
    const user = value?.data?.authed_user as { access_token?: unknown; refresh_token?: unknown } | undefined;
    if (value?.code === ErrorCode.PlatformError && value.data?.ok === false && value.data.access_token === undefined && value.data.refresh_token === undefined && value.data.app_id === undefined && value.data.bot_user_id === undefined && user?.access_token === undefined && user?.refresh_token === undefined && ['invalid_code','bad_client_secret','bad_redirect_uri','invalid_client_id','invalid_code_verifier','invalid_grant_type'].includes(String(value.data.error))) {
      await deadline.step(() => store.finishRootOAuth(secrets.appId, attempt));
      throw new AppError(`root_oauth_${value.data.error}`);
    }
    throw error;
  }
  if (result.ok !== true || 'error' in result) throw new AppError('root_oauth_unknown');
  if (result.is_enterprise_install !== undefined && typeof result.is_enterprise_install !== 'boolean') throw new AppError('root_oauth_unknown');
  if (typeof result.app_id !== 'string' || !result.app_id.trim() || typeof result.team?.id !== 'string' || !result.team.id.trim() || typeof result.authed_user?.id !== 'string' || !result.authed_user.id.trim()) throw new AppError('root_oauth_unknown');
  const appId = result.app_id;
  const installed = { teamId: string(result.team?.id), ownerId: string(result.authed_user?.id) };
  if (typeof result.access_token !== 'string' || !result.access_token.trim() || typeof result.bot_user_id !== 'string' || !result.bot_user_id.trim()) throw new AppError('root_oauth_unknown');
  const token = string(result.access_token), botUserId = string(result.bot_user_id);
  if (result.expires_in !== undefined && (!Number.isSafeInteger(result.expires_in) || result.expires_in <= 0)) throw new AppError('root_oauth_unknown');
  if (typeof result.scope !== 'string' || !result.scope.trim()) throw new AppError('root_oauth_unknown');
  const grantedScopes = result.scope.split(',');
  const excess = grantedScopes.some(scope => !botScopes.some(expected => expected === scope));
  const current = await deadline.step(() => store.get<{ teamId: string; ownerId: string }>('workspace'));
  if (appId !== secrets.appId || result.is_enterprise_install || expected.teamId !== undefined && (installed.teamId !== expected.teamId || installed.ownerId !== expected.ownerId) || current && (current.teamId !== installed.teamId || current.ownerId !== installed.ownerId)) {
    if (excess) throw new AppError('root_oauth_unknown');
    await deadline.step(() => store.finishRootOAuth(secrets.appId, attempt));
    throw new AppError('forbidden');
  }
  if (secrets.botToken !== undefined && botUserId !== secrets.botUserId) throw new AppError('group_boundary_mismatch');
  if (excess) { await deadline.step(() => store.rejectRootScopes(secrets.appId)); throw new AppError('root_oauth_scope_excess'); }
  if (botScopes.some(scope => !grantedScopes.includes(scope))) {
    await deadline.step(() => store.finishRootOAuth(secrets.appId, attempt));
    throw new AppError('root_oauth_scope_mismatch');
  }
  const initialGroup = seed && !await deadline.step(() => store.get('roughmate')) ? validateGroup({ pk: 'roughmate', environmentId: env('SECRET_ARN'), appId: secrets.appId, teamId: installed.teamId, version: 1, name: seed.name, description: seed.description, adminIds: [installed.ownerId], notifyUserIds: [], intakeChannelIds: [] }) : undefined;
  const installedSecrets = { ...secrets, botUserId, botToken: token, botScopes: grantedScopes, rootOAuth: { requestId: attempt, ...installed } };
  await deadline.step(() => store.install(installed));
  await deadline.step(() => store.saveSecrets(installedSecrets));
  if (initialGroup) await deadline.step(() => store.initializeGroup(initialGroup));
  await deadline.step(() => store.finishRootOAuth(secrets.appId, attempt));
  await deadline.step(() => enqueue({ kind: 'home', payload: { environmentId: env('SECRET_ARN'), appId: secrets.appId, teamId: installed.teamId, userId: installed.ownerId } }, deadline.signal));
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Roughmate</title><p>インストールしました。専用知識を登録し、Slack の Roughmate アプリのホームから相談受付チャンネル・対応先・管理者・任意通知を設定してください。初回承認者を管理者として登録しています。</p></html>' };
}
interface RegistrationResponse { submitted?: boolean; deletionSubmitted?:boolean; deletionConfirmation?:boolean; proposalSubmitted?:boolean; }
function modalNavigationTarget(payload: Record<string, unknown>, appId: string, teamId: string): { view_id: string; hash: string } | undefined {
  const container = object(payload.container);
  if (container.type === 'message') {
    if (payload.view !== undefined) throw new AppError('invalid_input');
    return undefined;
  }
  if (container.type !== 'view') throw new AppError('invalid_input');
  const view = object(payload.view);
  if (view.type !== 'home' && view.type !== 'modal') throw new AppError('invalid_input');
  const viewId = string(view.id);
  if (string(container.view_id) !== viewId || view.app_id !== appId || view.team_id !== undefined && view.team_id !== teamId) throw new AppError('forbidden');
  return view.type === 'modal' ? { view_id: viewId, hash: string(view.hash) } : undefined;
}
function isDeletionConfirmation(event:APIGatewayProxyEventV2):boolean {
  if(event.requestContext.http.method!=='POST' || !/^(?:\/bots\/[a-f0-9]{32})?\/slack\/interactive$/.test(event.rawPath)) return false;
  try {
    const body=event.isBase64Encoded ? Buffer.from(string(event.body),'base64').toString('utf8'):string(event.body);
    const payload=object(JSON.parse(event.headers['content-type']?.includes('application/x-www-form-urlencoded') ? string(new URLSearchParams(body).get('payload')):body));
    return payload.type==='block_actions' && Array.isArray(payload.actions) && object(payload.actions[0]).action_id==='delete_bot';
  } catch {return false;}
}
function registrationResponse(text: string): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_action: 'update', view: { type: 'modal', title: { type: 'plain_text', text: 'Bot登録の結果' }, close: { type: 'plain_text', text: '閉じる' }, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] } }) };
}
function wikiAdoptionResponse(accepted:boolean):APIGatewayProxyStructuredResultV2 {
  const text=accepted ? '採用・見送りの指示を受け付けました。検査・更新待ちです。権限検査とWiki反映はまだ完了していません。本人認証済みHome / Wikiで処理結果を確認してください。':'指示の受付・保存・配送結果を確認できません。再採用せず、本人認証済みHome / Wikiで状態を確認してください。受け付けた同じ指示はHomeの「今すぐ同期」で再開できます。受付記録がない場合は最新の提案を開き直してください。';
  return {statusCode:200,headers:{'content-type':'application/json'},body:JSON.stringify({response_action:'update',view:{type:'modal',title:{type:'plain_text',text:'Wiki更新指示の受付'},close:{type:'plain_text',text:'閉じる'},blocks:[{type:'section',text:{type:'plain_text',text}}]}})};
}
function registrationFailure(error: unknown): APIGatewayProxyStructuredResultV2 {
  const messages: Record<string, [string, string]> = {
    invalid_input: ['name', '入力項目を確認してください。'],
    invalid_name: ['name', 'アプリ名は35文字以内で入力してください。'],
    invalid_group_name: ['name', 'アプリ名は35文字以内で、改行や < > を含めず入力してください。'],
    invalid_bot_name: ['botName', '先頭は小文字英字、以後は小文字英数字と . _ - で35文字以内にしてください。'],
    invalid_group_config: ['description', '所属・説明は500文字以内にしてください。'],
    registration_name_in_use: ['botName', 'このBotメンション名は登録済みです。Homeの登録一覧を確認するか、別の名前を入力してください。'],
    registration_limit: ['name', 'Botの登録上限に達しています。Homeの登録一覧を確認してください。'],
    invalid_state: ['name', '登録画面の期限が切れたか、操作者が一致しません。Homeから新しい登録画面を開いてください。'],
    forbidden: ['name', 'この登録要求は変更できません。登録した本人のHomeで結果を確認してください。'],
    configuration_not_connected: ['name', '登録サービスが未接続または確認待ちです。環境管理者に接続状態の確認を依頼してください。'],
    registration_removal_pending: ['name', '削除処理中のため登録できません。環境管理者に確認してください。']
  };
  const field = error instanceof AppError ? messages[error.code] : undefined;
  if (field) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response_action: 'errors', errors: { [field[0]]: field[1] } }) };
  return registrationResponse('登録の保存・送信結果を確認できません。未保存と判断して別のBotを作らず、登録窓口のHomeを開き直し、登録一覧と「処理・保存結果を再確認」を確認してください。受理済みの要求は自動で再開します。一覧にない場合は環境管理者に確認してください。');
}
async function receiveSlack(event: APIGatewayProxyEventV2, deadline: RequestDeadline, response: RegistrationResponse): Promise<APIGatewayProxyStructuredResultV2> {
  const childRoute = /^\/bots\/([a-f0-9]{32})(\/slack\/(?:events|interactive))$/.exec(event.rawPath);
  if (event.requestContext.http.method !== 'POST' || !childRoute && !['/slack/events','/slack/interactive'].includes(event.rawPath)) return { statusCode: 404, body: '' };
  const registrations = new Registrations(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal);
  const child = childRoute ? await deadline.step(() => registrations.child(childRoute[1], false,true)) : undefined;
  const store = child?.store ?? new Storage(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal);
  const send = (job: QueueJob) => deadline.step(() => enqueue({ ...job, ...(child ? { botId: child.entry.id } : {}) }, deadline.signal));
  const path = childRoute ? childRoute[2] : event.rawPath;
  if (event.requestContext.http.method !== 'POST' || !['/slack/events','/slack/interactive'].includes(path)) return { statusCode: 404, body: '' };
  const body = event.isBase64Encoded ? Buffer.from(string(event.body), 'base64').toString('utf8') : string(event.body);
  const content = event.headers['content-type'];
  let payload: Record<string, unknown>;
  let registration: boolean;
  try {
    payload = object(JSON.parse(content?.includes('application/x-www-form-urlencoded') ? string(new URLSearchParams(body).get('payload')) : body));
    registration = !child && path === '/slack/interactive' && (payload.type === 'view_submission' && object(payload.view).callback_id === 'register_bot' || payload.type === 'block_actions' && Array.isArray(payload.actions) && object(payload.actions[0]).action_id === 'register_bot');
  }
  catch (error) {
    const secrets = await deadline.step(() => store.readSecrets());
    verifySignature(body, string(event.headers['x-slack-request-timestamp']), string(event.headers['x-slack-signature']), secrets.signingSecret, Math.floor(Date.now()/1000));
    throw error;
  }
  const readSecrets = async () => {
    const current = await store.readSecrets();
    verifySignature(body, string(event.headers['x-slack-request-timestamp']), string(event.headers['x-slack-signature']), current.signingSecret, Math.floor(Date.now()/1000));
    if(path==='/slack/interactive' && payload.api_app_id===current.appId && payload.type==='block_actions' && Array.isArray(payload.actions) && object(payload.actions[0]).action_id==='delete_bot') response.deletionConfirmation=true;
    if (registration && payload.type === 'view_submission' && payload.api_app_id === current.appId) response.submitted = true;
    if(path==='/slack/interactive' && payload.api_app_id===current.appId && payload.type==='view_submission' && object(payload.view).callback_id==='wiki_proposal_submit') response.proposalSubmitted=true;
    return current;
  };
  // 並列読取の失敗より署名確認を優先し、認証済みの登録送信には未確認結果を返す。
  const [secrets, registrationReads] = registration
    ? await deadline.step(() => Promise.all([readSecrets(), Promise.allSettled([store.workspace(), store.get<{ phase: string }>(configurationKey)])]))
    : [await deadline.step(readSecrets), undefined];
  if (payload.type === 'url_verification') return { statusCode: 200, body: JSON.stringify({ challenge: string(payload.challenge) }), headers: { 'content-type': 'application/json' } };
  const installed = requireInstalledSecrets(secrets);
  if (child && child.entry.phase !== 'available') throw new AppError('not_installed');
  if (payload.api_app_id !== secrets.appId) throw new AppError('forbidden');
  if (registrationReads?.[0].status === 'rejected') throw registrationReads[0].reason;
  if (registrationReads?.[1].status === 'rejected') throw registrationReads[1].reason;
  const registrationWorkspace = registrationReads?.[0].value, connection = registrationReads?.[1].value;
  const workspace = registrationWorkspace ?? await deadline.step(() => store.workspace());
  const team = typeof payload.team_id === 'string' ? payload.team_id : string(object(payload.team).id);
  authorizeWorkspace(workspace, team);
  const identity = { environmentId: child ? string(child.entry.secretArn) : env('SECRET_ARN'), appId: secrets.appId, teamId: team };
  const rawGroup = registration ? undefined : await deadline.step(() => store.get<GroupConfig>('roughmate'));
  const config = rawGroup ? validateGroup(rawGroup) : undefined;
  if (config) requireIdentity(config, identity);
  if(config?.lifecycle && !(payload.type==='block_actions' && Array.isArray(payload.actions) && ['reconcile','check_bot_delete','open_wiki_web'].includes(String(object(payload.actions[0]).action_id)))) throw new AppError('bot_stopped');
  const client = slackClient(installed.botToken, deadline.signal);
  const verifyBot = () => deadline.step(() => requireBotIdentity(client, workspace.teamId, installed.botUserId));
  if (payload.type === 'event_callback') {
    const slackEvent = object(payload.event);
    if (slackEvent.type === 'app_mention') {
      if (!config) throw new AppError('group_not_configured');
      if(slackEvent.bot_id!==undefined || slackEvent.subtype!==undefined || !/^[UW][A-Z0-9]+$/.test(string(slackEvent.user)) || slackEvent.user===installed.botUserId) throw new AppError('forbidden');
      requireIntake(config, string(slackEvent.channel));
      await send({ kind: 'mention', payload: { ...identity, userId:string(slackEvent.user), text: string(slackEvent.text), eventId: string(payload.event_id), teamId: team, channel: string(slackEvent.channel), ts: string(slackEvent.ts), threadTs: typeof slackEvent.thread_ts === 'string' ? slackEvent.thread_ts : string(slackEvent.ts) } });
    }
    if (slackEvent.type === 'app_home_opened') await send({ kind: 'home', payload: { ...identity, teamId: team, userId: string(slackEvent.user) } });
  } else if (payload.type === 'block_actions') {
    const user = string(object(payload.user).id);
    if (!Array.isArray(payload.actions)) throw new AppError('invalid_input');
    const action = object(payload.actions[0]);
    const actionId = string(action.action_id);
    const navigateView = (view: View) => {
      const target = modalNavigationTarget(payload, secrets.appId, team);
      return deadline.step(() => target
        ? client.views.update({ ...target, view })
        : client.views.open({ trigger_id: string(payload.trigger_id), view }));
    };
    if(['open_wiki_web','open_wiki_archives'].includes(actionId)) return {statusCode:200,body:''};
    if(actionId==='delete_bot' || actionId==='check_bot_delete') {
      const maintenance=new BotMaintenance(registrations,deadline.signal),botId=string(action.value);
      if(child && child.entry.id!==botId) throw new AppError('forbidden');
      if(actionId==='delete_bot') {
        const view=await deadline.step(()=>maintenance.confirmation(botId,user,secrets.appId));
        deadline.requireRemaining(300);
        await deadline.step(() => client.views.open({ trigger_id: string(payload.trigger_id), view }));
      }
      else {
        const entry=await deadline.step(()=>maintenance.checkRequest(botId,user,team,secrets.appId));
        await deadline.step(()=>queue.send(new SendMessageCommand({QueueUrl:env('PROVISION_QUEUE_URL'),MessageBody:JSON.stringify({kind:'delete_bot',id:entry.id,actor:user,teamId:team,appId:entry.parentAppId})}),{abortSignal:deadline.signal}));
      }
    } else if (['wiki_delete','wiki_retry','wiki_do_sync'].includes(actionId)) {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config,user);
      const selected = object(JSON.parse(await deadline.step(() => resolveWikiViewValue(store,config,user,actionId,string(action.value)))));
      const command: WikiCommand = { requestId:string(payload.trigger_id), actorId:user, configVersion:Number(selected.configVersion), wikiVersion:Number(selected.wikiVersion), operation:actionId==='wiki_delete' ? 'delete':actionId==='wiki_retry' ? 'retry':'sync', ...(actionId==='wiki_do_sync' ? {}:{id:string(selected.id)}) };
      await verifyBot();
      await deadline.step(() => acceptWikiCommand(store,config,command));
      await send({kind:'wiki_command',payload:{...identity,userId:user,requestId:command.requestId}});
    } else if (proposalActions.includes(actionId as typeof proposalActions[number])) {
      if(!config) throw new AppError('group_not_configured');
      requireAdmin(config,user);
      await verifyBot();
      const origin=object(payload.container);
      if(origin.type!=='message' || object(payload.channel).id!==config.reviewChannelId || origin.channel_id!==config.reviewChannelId) throw new AppError('forbidden');
      const selected=object(JSON.parse(string(action.value)));
      if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(string(selected.key)) || !/^[a-f0-9]{64}$/.test(string(selected.hash))) throw new AppError('forbidden');
      const opened=await navigateView(wikiPreparingView());
      await send({kind:'wiki_ui',payload:{...identity,userId:user,action:actionId,value:string(action.value),channelId:config.reviewChannelId,messageTs:string(origin.message_ts),viewId:string(opened.view?.id),viewHash:string(opened.view?.hash)}});
    } else if (actionId.startsWith('wiki_') || actionId === 'knowledge_edit') {
      if(actionId.startsWith('wiki_') && typeof action.value==='string' && action.value && !action.value.startsWith('wiki-view#')) throw new AppError('forbidden');
      if (!config) throw new AppError('group_not_configured');
      if (['knowledge_edit','wiki_manual_edit','wiki_add','wiki_edit_source','wiki_sync','wiki_retention'].includes(actionId)) requireAdmin(config,user);
      await verifyBot();
      const opened = await navigateView(wikiPreparingView());
      await send({kind:'wiki_ui',payload:{...identity,userId:user,action:actionId==='knowledge_edit' ? 'wiki_manual_edit':actionId,value:typeof action.value==='string' ? action.value:'',viewId:string(opened.view?.id),viewHash:string(opened.view?.hash)}});
    } else if (actionId === 'register_bot') {
      if (child || !process.env.PROVISION_QUEUE_URL) throw new AppError('forbidden');
      authorizeOwner(workspace, team, user);
      if (connection?.phase !== 'ready') throw new AppError('configuration_not_connected');
      await verifyBot();
      const nonce = await deadline.step(() => registrations.modal(workspace, secrets.appId, user));
      await navigateView(registrationView(nonce));
    } else if (actionId === 'install_bot' || actionId === 'retry_bot') {
      if (child || !process.env.PROVISION_QUEUE_URL) throw new AppError('forbidden');
      authorizeOwner(workspace, team, user);
      const id = string(action.value);
      if (actionId === 'retry_bot') {
        const registry = await deadline.step(() => registrations.read());
        const entry = registry.entries.find(item => item.id === id);
        if (!entry || entry.actor !== user || entry.teamId !== team || entry.parentAppId !== secrets.appId) throw new AppError('forbidden');
        await deadline.step(() => queue.send(new SendMessageCommand({ QueueUrl: env('PROVISION_QUEUE_URL'), MessageBody: JSON.stringify({ kind: 'provision', id, actor: user, teamId: team, appId: secrets.appId }) }), { abortSignal: deadline.signal }));
      } else {
        const url = await deadline.step(() => beginInstall(registrations, id, user, deadline));
        await navigateView({ type: 'modal', title: { type: 'plain_text', text: 'Slackへの追加' }, close: { type: 'plain_text', text: '閉じる' }, blocks: [{ type: 'section', text: { type: 'plain_text', text: '次のボタンを開き、Slackで許可してください。このリンクは15分・一回限りです。追加後に子BotのHomeから資料と受付先を設定します。' } }, { type: 'actions', elements: [{ type: 'button', action_id: 'oauth_link', text: { type: 'plain_text', text: 'Slackに追加・許可' }, url }] }] });
      }
    } else if (['knowledge_add','knowledge_edit','knowledge_delete'].includes(actionId)) {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
      const catalog = await deadline.step(() => store.knowledge(identity));
      const document = actionId === 'knowledge_add' ? undefined : catalog.documents.find(item => item.id === action.value);
      if (actionId !== 'knowledge_add' && !document) throw new AppError('invalid_knowledge');
      await verifyBot();
      if (actionId === 'knowledge_delete') {
        const request = await deadline.step(() => requestKnowledge(store, config, user, string(payload.trigger_id), catalog, undefined, string(document?.id)));
        await send({ kind: 'knowledge', payload: { ...identity, ...request } });
      } else await navigateView(await deadline.step(() => protectWikiView(store,config,user,knowledgeView(config,catalog,document))));
    } else if (actionId === 'oauth_link') {
      if (child) throw new AppError('forbidden');
      authorizeOwner(workspace, team, user);
    } else if (actionId === 'authorize_channels' || actionId === 'disconnect_channels') {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
      await verifyBot();
      if (actionId === 'disconnect_channels') {
        await deadline.step(() => store.disconnectChannelAuthorization(config, user, randomBytes(16).toString('hex')));
        await send({ kind: 'home', payload: { ...identity, userId: user } });
      } else {
        const url = await deadline.step(() => beginChannelAuthorization(store, config, secrets, user, env('PUBLIC_URL')+(child ? `/bots/${child.entry.id}` : '')));
        await navigateView({ type: 'modal', title: { type: 'plain_text', text: '本人の非公開招待権限' }, close: { type: 'plain_text', text: '閉じる' }, blocks: [{ type: 'section', text: { type: 'plain_text', text: '今操作している本人のSlackアカウントで認可してください。このBotの設定保存時だけ、あなたが所属し招待できる非公開チャンネルへBotを招待します。会話本文を読む権限は要求しません。リンクは15分・一回限りです。' } }, { type: 'actions', elements: [{ type: 'button', action_id: 'channel_oauth_link', text: { type: 'plain_text', text: '本人としてSlackで認可' }, url }] }] });
      }
    } else if (actionId === 'channel_oauth_link') {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
    } else if (actionId === 'configure') {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
      await verifyBot();
      await navigateView(settingsView(config));
    } else {
      const id = string(action.value);
      const item = await deadline.step(() => store.get<Consultation>(id));
      if (!item || !config || item.appId !== identity.appId || item.environmentId !== identity.environmentId || item.teamId !== team || object(payload.channel).id !== item.reviewChannel) throw new AppError('forbidden');
      const container = object(payload.container);
      if (container.type !== 'message' || container.channel_id !== item.reviewChannel || !item.draftTs || container.message_ts !== item.draftTs) throw new AppError('forbidden');
      if (!['edit','adopt','reconcile'].includes(actionId)) throw new AppError('invalid_input');
      if (actionId !== 'reconcile') {
        requireIntake(config, item.sourceChannel);
        if (item.reviewChannel !== config.reviewChannelId) throw new AppError('forbidden');
      }
      const pending = { ...identity, userId: user, requestId: id, action: actionId, draftTs: item.draftTs, configVersion: config.version };
      if (actionId === 'edit') {
        if (item.status !== 'draft' && !item.answerCancellation) throw new AppError('invalid_status');
        const receiptId = `answer-edit#${randomBytes(16).toString('hex')}`;
        await verifyBot();
        const opened = await navigateView(preparingEditView());
        await send({ kind: 'review', payload: { ...pending, receiptId, viewId: string(opened.view?.id), viewHash: string(opened.view?.hash), expiresAt: Math.floor(Date.now()/1000) + 900 } });
      } else await send({ kind: 'review', payload: pending });
    }
  } else if (payload.type === 'view_submission') {
    const user = string(object(payload.user).id);
    const view = object(payload.view);
    const values = object(object(view.state).values);
    if(view.callback_id==='delete_bot') {
      response.deletionSubmitted=true;
      const entry=await deadline.step(()=>new BotMaintenance(registrations,deadline.signal).accept(string(view.private_metadata),user,team,secrets.appId));
      await deadline.step(()=>queue.send(new SendMessageCommand({QueueUrl:env('PROVISION_QUEUE_URL'),MessageBody:JSON.stringify({kind:'delete_bot',id:entry.id,actor:user,teamId:team,appId:entry.parentAppId}),DelaySeconds:150}),{abortSignal:deadline.signal}));
      return registrationResponse('Botを停止し、専用Slack Appの削除を受け付けました。登録窓口のHomeで処理状況を確認してください。Wikiと確定回答はアーカイブに残ります。');
    } else if (view.callback_id === 'wiki_proposal_submit') {
      if(!config) throw new AppError('group_not_configured');
      requireAdmin(config,user);
      const key=await deadline.step(()=>acceptProposalSubmission(store,config,user,string(view.id),string(view.private_metadata),values));
      await send({kind:'wiki_adoption',payload:{...identity,userId:user,key}});
      return wikiAdoptionResponse(true);
    } else if (view.callback_id === 'wiki_source' || view.callback_id === 'wiki_retention') {
      if (!config) throw new AppError('group_not_configured');
      const command=submittedWikiCommand(config,user,string(view.id),view.callback_id,object(JSON.parse(await deadline.step(() => resolveWikiViewValue(store,config,user,string(view.callback_id),string(view.private_metadata))))),values);
      await verifyBot();
      await deadline.step(() => acceptWikiCommand(store,config,command));
      await send({kind:'wiki_command',payload:{...identity,userId:user,requestId:command.requestId}});
    } else if (view.callback_id === 'register_bot') {
      if (child || !process.env.PROVISION_QUEUE_URL) throw new AppError('forbidden');
      authorizeOwner(workspace, team, user);
      if (connection?.phase !== 'ready') throw new AppError('configuration_not_connected');
      const input = { name: object(object(values.name).text).value, botName: object(object(values.botName).text).value, description: object(object(values.description).text).value ?? '' };
      const entry = await deadline.step(() => registrations.register(workspace, secrets.appId, user, string(view.private_metadata), input, deadline));
      await deadline.step(() => queue.send(new SendMessageCommand({ QueueUrl: env('PROVISION_QUEUE_URL'), MessageBody: JSON.stringify({ kind: 'provision', id: entry.id, actor: user, teamId: team, appId: secrets.appId }) }), { abortSignal: deadline.signal }));
      return registrationResponse('作成依頼を保存し、処理を受け付けました。登録窓口のHomeを開き直してください。準備が終わったら、登録一覧の「Slackに追加」から本人として許可してください。');
    } else if (view.callback_id === 'knowledge') {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
      const metadata = object(JSON.parse(await deadline.step(() => resolveWikiViewValue(store,config,user,'knowledge',string(view.private_metadata)))));
      const accepted = await deadline.step(() => store.get<KnowledgeReceipt>(`knowledge#${string(view.id)}`));
      if (accepted) {
        requireIdentity(accepted, identity);
        requireSettingsExpiry(accepted.expiresAt);
        if (accepted.userId !== user || accepted.requestId !== view.id || accepted.configVersion !== metadata.groupVersion || accepted.catalogVersion !== metadata.catalogVersion || accepted.deleteId || !accepted.document || metadata.id !== undefined && metadata.id !== accepted.document.id) throw new AppError('forbidden');
        const { isDeepStrictEqual } = await import('node:util');
        if (!isDeepStrictEqual(submittedDocument(values, metadata.id === undefined ? undefined : accepted.document, accepted.catalogVersion), accepted.document)) throw new AppError('forbidden');
        await send({ kind: 'knowledge', payload: { ...knowledgeContent(accepted) } });
        return { statusCode: 200, body: '' };
      }
      const catalog = await deadline.step(() => store.knowledge(identity));
      if (metadata.groupVersion !== config.version || metadata.catalogVersion !== catalog.version) throw new AppError('settings_conflict');
      const previous = metadata.id === undefined ? undefined : catalog.documents.find(item => item.id === metadata.id);
      if (metadata.id !== undefined && !previous) throw new AppError('invalid_knowledge');
      const document = submittedDocument(values, previous, catalog.version);
      await verifyBot();
      const request = await deadline.step(() => requestKnowledge(store, config, user, string(view.id), catalog, document, undefined));
      await send({ kind: 'knowledge', payload: { ...identity, ...request } });
    } else if (view.callback_id === 'settings') {
      if (!config) throw new AppError('group_not_configured');
      requireAdmin(config, user);
      const version = Number(view.private_metadata);
      if (version !== config.version) throw new AppError('settings_conflict');
      const next = validateGroup({ ...settingsContent(config), version: version + 1, lastRequestId: string(view.id),
        name: string(object(object(values.name).text).value), description: object(object(values.description).text).value ?? '',
        adminIds: object(object(values.admins).select).selected_users, notifyUserIds: values.notifyUsers === undefined ? [] : object(object(values.notifyUsers).select).selected_users,
        intakeChannelIds: object(object(values.intake).select).selected_conversations, reviewChannelId: string(object(object(values.channel).select).selected_conversation) });
      const requestId = string(view.id);
      await verifyBot();
      const receipt = await deadline.step(() => store.requestSettings(workspace, requestId, string(next.reviewChannelId), next, user));
      await send({ kind: 'settings', payload: { ...identity, userId: user, config: next, previousVersion: version, requestId, ...receipt } });
    } else if (view.callback_id === 'answer') {
      if (!config) throw new AppError('group_not_configured');
      const receiptId = string(view.private_metadata);
      const viewId = string(view.id);
      const receipt = await deadline.step(() => requireAnswerEdit(store, config, user, viewId, receiptId));
      const item = await deadline.step(() => store.get<Consultation>(receipt.requestId));
      if (!item || item.draftTs !== receipt.draftTs) throw new AppError('forbidden');
      requireIdentity(item as Consultation & { environmentId: string; appId: string }, identity);
      requireIntake(config, item.sourceChannel);
      if (item.reviewChannel !== config.reviewChannelId) throw new AppError('forbidden');
      await send({ kind: 'review', payload: { ...identity, userId: user, requestId: item.pk, action: 'answer', receiptId, viewId, draftTs: receipt.draftTs, configVersion: receipt.configVersion, answer: string(object(object(values.answer).text).value) } });
    }
    else throw new AppError('invalid_input');
  }
  return { statusCode: 200, body: '' };
}
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  if(event.rawPath.startsWith('/wiki/')) return wikiWeb(event);
  const authorizationRoute = /^(?:\/bots\/([a-f0-9]{32}))?\/channel-authorization\/callback$/.exec(event.rawPath);
  const registration: RegistrationResponse = {};
  try {
    if (authorizationRoute && event.requestContext.http.method === 'GET') {
      if (!Number.isFinite(event.requestContext.timeEpoch)) throw new AppError('invalid_input');
      const deadline = new RequestDeadline(event.requestContext.timeEpoch + OAUTH_CALLBACK_BUDGET_MS);
      return await deadline.run(async () => {
        const registrations = new Registrations(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal);
        const child = authorizationRoute[1] ? await deadline.step(() => registrations.child(authorizationRoute[1], true)) : undefined;
        const target = child?.store ?? new Storage(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal);
        const secrets = await deadline.step(() => target.readSecrets());
        const workspace = await deadline.step(() => target.workspace());
        const identity = { environmentId: child ? string(child.entry.secretArn) : env('SECRET_ARN'), appId: secrets.appId, teamId: workspace.teamId };
        const config = await deadline.step(() => target.group(identity));
        const parameters = event.queryStringParameters;
        const user = await completeChannelAuthorization(target, config, secrets, string(parameters?.state), { code: parameters?.code, error: parameters?.error }, env('PUBLIC_URL')+(child ? `/bots/${child.entry.id}` : ''), deadline);
        await deadline.step(() => enqueue({ kind: 'home', ...(child ? { botId: child.entry.id } : {}), payload: { ...identity, userId: user } }, deadline.signal));
        return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>本人認可を保存しました</title><p>非公開チャンネルへの招待を本人として認可しました。BotのHomeへ戻り、受付・対応先の設定を開き直して保存してください。</p></html>' };
      });
    }
    if (event.rawPath === '/oauth/callback' && event.requestContext.http.method === 'GET') {
      if (!Number.isFinite(event.requestContext.timeEpoch)) throw new AppError('invalid_input');
      const deadline = new RequestDeadline(event.requestContext.timeEpoch + OAUTH_CALLBACK_BUDGET_MS);
      return await deadline.run(() => oauthCallback(event, deadline));
    }
    const childCallback = /^\/bots\/([a-f0-9]{32})\/oauth\/callback$/.exec(event.rawPath);
    if (childCallback && event.requestContext.http.method === 'GET') {
      if (!Number.isFinite(event.requestContext.timeEpoch)) throw new AppError('invalid_input');
      const parameters = event.queryStringParameters;
      if (parameters?.error !== undefined && (parameters.error !== 'access_denied' || parameters.code !== undefined)) throw new AppError('invalid_input');
      const state = string(parameters?.state), response = parameters?.error === 'access_denied' ? { error: 'access_denied' as const } : string(parameters?.code);
      const deadline = new RequestDeadline(event.requestContext.timeEpoch + OAUTH_CALLBACK_BUDGET_MS);
      await installChild(new Registrations(env('TABLE_NAME'), env('SECRET_ARN'), deadline.signal), childCallback[1], state, response, deadline);
      return { statusCode: 202, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Roughmate追加を確認中</title><p>Slack承認の結果を保存しました。Botの検証と初期設定を処理中です。登録窓口のRoughmateのHomeで「利用可能」になるまでお待ちください。「処理・保存結果を再確認」から進捗を確認できます。同じ承認リンクは再使用しないでください。新規Botは利用可能になったら子Homeで資料・受付先・任意通知を設定してください。</p></html>' };

    }
    if (!Number.isFinite(event.requestContext.timeEpoch)) throw new AppError('invalid_input');
    const deadline = new RequestDeadline(event.requestContext.timeEpoch + SLACK_REQUEST_BUDGET_MS);
    const receive=() => receiveSlack(event, deadline, registration);
    return await (isDeletionConfirmation(event) ? deadline.runAwaited(receive):deadline.run(receive));
  }
  catch (error) {
    process.stderr.write(JSON.stringify({ event: 'roughmate_http_failed', code: diagnosticCode(error) }) + '\n');
    if(registration.deletionConfirmation) return {statusCode:200,body:''};
    if(registration.deletionSubmitted) return registrationResponse('削除の受付・保存結果を確認できません。登録窓口のHomeを開き直し、対象Botの削除結果を確認してください。確認するまで新たな削除を実行しないでください。');
    if(registration.proposalSubmitted) return wikiAdoptionResponse(false);
    if (registration.submitted) return registrationFailure(error);
    if (authorizationRoute && event.requestContext.http.method === 'GET' || error instanceof AppError && error.code === 'channel_authorization_scope_excess') return channelAuthorizationFailure(error);
    if (event.rawPath === '/oauth/callback' && event.requestContext.http.method === 'GET' && !(error instanceof AppError && ['root_oauth_scope_excess','root_oauth_scope_mismatch'].includes(error.code))) return rootOAuthFailure(error);
    if (error instanceof AppError && ['root_oauth_scope_excess','oauth_scope_excess'].includes(error.code)) return { statusCode: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>余剰権限のため停止しました</title><p>SlackのOAuth権限に余剰があります。同じAppの再承認では権限を減らせません。環境管理者が対象の専用Slack Appを削除し、最新Manifestで再作成する必要があります。自動削除は行いません。同じ承認リンクは再使用しないでください。</p></html>' };
    if (error instanceof AppError && error.code === 'root_oauth_scope_mismatch') return { statusCode: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Roughmate権限が不足しています</title><p>登録窓口BotのOAuth権限が要求より不足しています。保存済みの資格情報・資料・設定は変更していません。環境管理者は最新ManifestのBot権限7件を確認し、setup-slackで新しい承認リンクを発行してください。このリンクのstateは消費済みです。同じ承認リンクは再使用しないでください。</p></html>' };
    if (error instanceof AppError && error.code === 'oauth_rejected') return { statusCode: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Roughmate追加できませんでした</title><p>Slackへの追加は拒否されました。登録窓口のRoughmateのHomeを開き直し、表示された原因を確認して、新しい「Slackに追加」リンクから再承認してください。待機時刻が表示されている場合は、その時刻を過ぎてから操作してください。同じ承認リンクは再使用しないでください。</p></html>' };
    if (/^\/bots\/[a-f0-9]{32}\/oauth\/callback$/.test(event.rawPath) && event.requestContext.http.method === 'GET' && (!(error instanceof AppError) || ['oauth_install_unknown','request_deadline','registration_conflict'].includes(error.code))) return { statusCode: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: '<!doctype html><html lang="ja"><meta charset="utf-8"><title>Slack追加の結果を確認できません</title><p>認可交換・保存・受付の結果を確認できません。登録窓口のRoughmateのHomeを開き直し、「処理・保存結果を再確認」から保存状態を確認してください。同じ承認リンク・OAuth codeは再交換しません。未保存と仮定して保護を解除したり、Appを再作成したりしないでください。</p><p>再確認しても結果が分からない場合は、環境管理者が対象Appと保存済み版を照合し、既存のrecover-registration手順で復旧してください。新しいOAuthリンクは、未保存と確認され管理者が安全に復旧した場合だけ発行できます。</p></html>' };
    return { statusCode: error instanceof AppError ? (['request_deadline','settings_conflict','registration_conflict'].includes(error.code) ? 503 : ['forbidden','invalid_signature','invalid_state'].includes(error.code) ? 403 : 400) : 503, body: '処理できませんでした。再実行してください。' };
  }
}
function channelAuthorizationFailure(error: unknown): APIGatewayProxyStructuredResultV2 {
  const code = error instanceof AppError ? error.code : undefined;
  let reason = 'Slackとの認可交換・本人確認、保存または通知の結果を確認できません。BotのHomeで保存状態を確認してください。';
  if (code === 'channel_authorization_denied') reason = '本人による非公開招待の認可がSlackで拒否されました。';
  else if (code === 'channel_authorization_scope_excess') reason = '本人の招待権限に余剰があります。同じAppの再承認では権限を減らせません。環境管理者が対象の専用Slack Appを削除し、最新Manifestで再作成する必要があります。自動削除は行いません。有効な既存の本人認可は変更していません。';
  else if (code === 'channel_authorization_pending') reason = '同じAppの本人認可交換・権限確認が未完了です。結果不明を未保存と扱わず、新しい認可交換を停止しています。';
  else if (code === 'channel_authorization_scope_mismatch') reason = '本人の招待権限が要求と一致しません。必要な権限はgroups:readとgroups:write.invitesの2件です。';
  else if (code === 'forbidden' || code === 'group_boundary_mismatch') reason = 'Slackの本人・Bot・ワークスペース、または現在の管理権限が一致しません。設定を操作する本人のアカウントを確認してください。';
  else if (code === 'invalid_state' || code === 'settings_conflict') reason = '認可リンクが使用済み・期限切れ、または新しい認可・解除・設定操作と競合しました。';
  else if (code === 'invalid_input') reason = 'Slackの認可応答が正しい形式ではありません。';
  else if (code === 'channel_oauth_invalid_code') reason = 'Slackが本人認可のOAuth codeを無効として拒否しました。';
  else if (code === 'channel_oauth_bad_client_secret' || code === 'channel_oauth_invalid_client_id') reason = 'SlackがAppのclient資格情報を不正として認可交換を拒否しました。環境管理者が対象Appの資格情報を確認してください。';
  else if (code === 'channel_oauth_bad_redirect_uri') reason = 'Slackが本人認可callback URLの不一致で交換を拒否しました。環境管理者がManifestと接続先を確認してください。';
  else if (code === 'channel_oauth_invalid_code_verifier' || code === 'channel_oauth_invalid_grant_type') reason = 'Slackが認可交換パラメーターを不正として拒否しました。環境管理者が認可設定を確認してください。';
  const statusCode = error instanceof AppError ? (['request_deadline','settings_conflict','registration_conflict','channel_authorization_pending'].includes(error.code) ? 503 : ['forbidden','invalid_signature','invalid_state','channel_authorization_scope_mismatch','channel_authorization_scope_excess'].includes(error.code) ? 403 : 400) : 503;
  const recovery = code === 'channel_authorization_pending' ? '同じOAuth codeは再交換しません。BotのHomeで保存状態を確認し、進行中の交換が完了するまで待ってください。未確認状態が残る場合は環境管理者に確認を依頼してください。未保存と仮定して保護を解除せず、確認できない場合は対象専用Appの削除・再作成が必要です。本人認可の解除は直ちに反映します。' : code === 'channel_authorization_scope_excess' ? '同じAppの新しい認可リンクは発行しません。同じ承認リンク・OAuth codeは再使用しないでください。既存の本人認可を停止する場合はHomeの「本人の招待認可を解除」を操作してください。' : '認可をやり直す場合は、このBotのHomeを開き直して「非公開招待を本人認可」から新しいリンクを発行してください。同じ承認リンク・OAuth codeは再使用しないでください。既存の認可を停止するにはHomeの「本人の招待認可を解除」を操作してください。';
  return { statusCode, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: `<!doctype html><html lang="ja"><meta charset="utf-8"><title>本人認可を完了できませんでした</title><p>${reason}</p><p>${recovery}</p></html>` };
}

function rootOAuthFailure(error: unknown): APIGatewayProxyStructuredResultV2 {
  const code = error instanceof AppError ? error.code : undefined;
  const reasons: Record<string,string> = {
    root_oauth_denied: '登録窓口Botの認可がSlackで拒否されました。',
    root_oauth_invalid_code: 'Slackが登録窓口BotのOAuth codeを無効として拒否しました。',
    root_oauth_bad_client_secret: 'SlackがAppのclient資格情報を不正として交換を拒否しました。管理者が対象Appの資格情報を確認してください。',
    root_oauth_invalid_client_id: 'SlackがAppのclient IDを不正として交換を拒否しました。管理者が対象Appの資格情報を確認してください。',
    root_oauth_bad_redirect_uri: 'Slackがcallback URLの不一致で交換を拒否しました。管理者がManifestと接続先を確認してください。',
    root_oauth_invalid_code_verifier: 'Slackが認可交換パラメーターを不正として拒否しました。管理者が認可設定を確認してください。',
    root_oauth_invalid_grant_type: 'Slackが認可交換方式を不正として拒否しました。管理者が認可設定を確認してください。',
    invalid_state: '認可リンクが使用済み、期限切れ、または別の操作と競合しました。',
    forbidden: '承認したSlackアカウント・App・ワークスペースが登録先と一致しません。',
    group_boundary_mismatch: '現在のApp・Bot・設定の境界が一致しません。管理者が接続先を確認してください。',
    invalid_input: 'Slackの認可応答が完全な形式ではありません。'
  };
  const known = code !== undefined && Object.hasOwn(reasons, code);
  const reason = known ? reasons[code!] : 'Slackとの交換・保存・通知の結果を確認できません。管理者が保存状態を確認してください。';
  const statusCode = error instanceof AppError ? ['root_oauth_unknown','settings_conflict','request_deadline'].includes(error.code) ? 503 : ['invalid_state','forbidden'].includes(error.code) ? 403 : 400 : 503;
  return { statusCode, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: `<!doctype html><html lang="ja"><meta charset="utf-8"><title>登録窓口Botの認可を完了できませんでした</title><p>${reason}</p><p>認可をやり直す場合は、環境管理者がsetup-slack --reinstallを実行して新しい承認リンクを発行してください。同じ承認リンク・OAuth codeは再使用しないでください。結果不明の場合は、先に既存の保存状態を確認してください。</p></html>` };
}
