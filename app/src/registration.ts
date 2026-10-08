import { c, type DocumentStore } from './document-store.js';
import { runtime } from './runtime.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { KnownBlock, View } from '@slack/web-api';
import { AppError, object, string, requireInstalledSecrets, type Workspace, type Secrets } from './contracts.js';
import { Storage } from './storage.js';
import { authorizeOwner } from './security.js';
import { validateName, validateDescription } from './groups.js';
import { slackClient, requireBotIdentity, botDeletionConfirmationNotice } from './slack.js';
import type { RequestDeadline } from './deadline.js';

export const registrationKey = 'registrations';
export const configurationKey = 'registration#configuration';
export const registrationLimit = 8;
export type RegistrationPhase = 'queued' | 'resources' | 'creating' | 'created' | 'install_wait' | 'available' | 'failed';
export interface Registration {
  id: string; name: string; botName: string; description: string; actor: string; teamId: string; parentAppId: string;
  phase: RegistrationPhase; expiresAt: number; appId?: string; secretArn?: string; failureCode?: string;
  deletion?:import('./bot-maintenance.js').BotDeletion; createOwner?: string; createRetryAt?: number; oauthState?: string; oauthExpiresAt?: number; installOwner?: string; oauthRetryAt?: number; credentialVersion?: string; homeNotificationPending?: boolean;
}
export interface Registry { pk: typeof registrationKey; version: number; parentSecret: string; entries: Registration[]; archiveHead?:string; archiveRetentionCursor?:string; deleteNextAt?:number; deleting?: boolean; removingAppId?: string; homeNoticeOwner?: string; homeNoticeUntil?: number; }
export interface BotResources { tableName: string; secretName: string; secretPrefix: string; }
export function childResources(parentTable: string, parentSecret: string, id: string): BotResources {
  return runtime().children.names(parentTable, parentSecret, id);
}
export function validateRegistrationInput(value: unknown): Pick<Registration, 'name' | 'botName' | 'description'> {
  const raw = object(value);
  const name = validateName(string(raw.name)), description = validateDescription(raw.description);
  if (Array.from(name).length > 35) throw new AppError('invalid_name');
  const botName = string(raw.botName);
  if (!/^[a-z][a-z0-9._-]{0,34}$/.test(botName)) throw new AppError('invalid_bot_name');
  return { name, description, botName };
}
export class Registrations {
  private db: DocumentStore;
  readonly root: Storage;
  constructor(readonly parentTable: string, readonly parentSecret: string, private signal?: AbortSignal, private region?: string) {
    this.root = new Storage(parentTable, parentSecret, signal, region);
    this.db = runtime().documents(region);
  }
  async read(): Promise<Registry> {
    const raw = await this.root.get<Registry>(registrationKey);
    if (!raw) return { pk: registrationKey, version: 0, parentSecret: this.parentSecret, entries: [] };
    if (raw.pk !== registrationKey || raw.parentSecret !== this.parentSecret || !Number.isSafeInteger(raw.version) || raw.version < 1 || !Array.isArray(raw.entries) || raw.entries.length > registrationLimit) throw new AppError('registration_boundary');
    if(raw.archiveRetentionCursor!==undefined && !/^bot-archive#[a-f0-9]{32}$/.test(raw.archiveRetentionCursor)) throw new AppError('registration_boundary');
    if(raw.archiveHead!==undefined && !/^bot-archive#[a-f0-9]{32}$/.test(raw.archiveHead) || raw.deleteNextAt!==undefined && (!Number.isSafeInteger(raw.deleteNextAt) || raw.deleteNextAt<0)) throw new AppError('registration_boundary');
    if (raw.homeNoticeUntil !== undefined && (!Number.isSafeInteger(raw.homeNoticeUntil) || raw.homeNoticeUntil < 0 || typeof raw.homeNoticeOwner !== 'string')) throw new AppError('registration_boundary');
    const seen = new Set<string>(), apps = new Set<string>();
    for (const entry of raw.entries) {
      const resources = childResources(this.parentTable, this.parentSecret, entry.id);
      validateRegistrationInput(entry);
      if (seen.has(entry.id) || !['queued','resources','creating','created','install_wait','available','failed'].includes(entry.phase) || !Number.isSafeInteger(entry.expiresAt) || !/^[UW][A-Z0-9]+$/.test(entry.actor) || !/^T[A-Z0-9]+$/.test(entry.teamId) || !/^A[A-Z0-9]+$/.test(entry.parentAppId)) throw new AppError('registration_boundary');
      if(entry.deletion && (!/^[a-f0-9]{32}$/.test(entry.deletion.id) || entry.deletion.actor!==entry.actor || !['queued','unknown','failed'].includes(entry.deletion.status) || !Number.isSafeInteger(entry.deletion.requestedAt) || !Number.isSafeInteger(entry.deletion.notBefore))) throw new AppError('registration_boundary');
      seen.add(entry.id);
      if (entry.secretArn && (!runtime().children.validSecret(resources, entry.secretArn))) throw new AppError('registration_boundary');
      if (entry.appId && (!/^A[A-Z0-9]+$/.test(entry.appId) || entry.appId === entry.parentAppId || apps.has(entry.appId))) throw new AppError('registration_boundary');
      if (entry.appId) apps.add(entry.appId);
      if ([entry.createRetryAt,entry.oauthRetryAt].some(time => time !== undefined && (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(new Date(time*1000).getTime())))) throw new AppError('registration_boundary');
      if (entry.homeNotificationPending !== undefined && typeof entry.homeNotificationPending !== 'boolean') throw new AppError('registration_boundary');
      if (entry.credentialVersion !== undefined && (typeof entry.credentialVersion !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.credentialVersion))) throw new AppError('registration_boundary');
    }
    return raw;
  }
  async child(id: string, installed: boolean, allowStopped=false): Promise<{ entry: Registration; store: Storage }> {
    childResources(this.parentTable, this.parentSecret, id);
    const registry = await this.read();
    const entry = registry.entries.find(item => item.id === id);
    const workspace = await this.root.workspace(), rootSecrets = await this.root.readSecrets();
    if (!entry || entry.deletion && !allowStopped || entry.teamId !== workspace.teamId || entry.actor !== workspace.ownerId || entry.parentAppId !== rootSecrets.appId || !entry.appId || !entry.secretArn || (installed ? entry.phase !== 'available' : !['created','install_wait','available'].includes(entry.phase))) throw new AppError('registration_boundary');
    const store = new Storage(childResources(this.parentTable, this.parentSecret, id).tableName, entry.secretArn, this.signal, this.region, entry.credentialVersion);
    const secrets = await store.readSecrets();
    if (secrets.appId !== entry.appId) throw new AppError('registration_boundary');
    if (installed) requireInstalledSecrets(secrets);
    return { entry, store };
  }
  async save(previous: Registry, entries: Registration[], archiveProgress?:{archiveRetentionCursor?:string}): Promise<Registry> {
    const next = { ...previous, version: previous.version + 1, entries, ...archiveProgress };
    if(archiveProgress && archiveProgress.archiveRetentionCursor===undefined) delete next.archiveRetentionCursor;
    if (entries.length > registrationLimit) throw new AppError('registration_limit');
    return this.put(previous, next);
  }
  async reserveHome(previous: Registry, owner: string): Promise<Registry> {
    if (previous.deleting) throw new AppError('registration_removal_pending');
    return this.put(previous, { ...previous, version: previous.version + 1, homeNoticeOwner: owner, homeNoticeUntil: Math.floor(Date.now()/1000)+150 });
  }
  async releaseHome(previous: Registry, owner: string): Promise<void> {
    if (previous.homeNoticeOwner !== owner) throw new AppError('registration_conflict');
    const next = { ...previous, version: previous.version + 1 };
    delete next.homeNoticeOwner; delete next.homeNoticeUntil;
    await this.put(previous, next, owner);
  }
  private async put(previous: Registry, next: Registry, owner?: string): Promise<Registry> {
    try {
      await this.db.put({ namespace: this.parentTable, item: next,
        condition: (previous.version === 0 ? c.absent("pk") : c.all(c.all(c.compare("#version","=",":version"),c.compare("parentSecret","=",":parent")),(owner ? c.compare("homeNoticeOwner","=",":noticeOwner") : c.group(c.any(c.absent("homeNoticeUntil"),c.compare("homeNoticeUntil","<=",":now")))))),
        ...(previous.version ? { fields: { '#version': 'version' }, parameters: { ':version': previous.version, ':parent': this.parentSecret, ...(owner ? { ':noticeOwner': owner } : { ':now': Math.floor(Date.now()/1000) }) } } : {}) }, { abortSignal: this.signal });
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('registration_conflict'); throw error; }
    return next;
  }
  async requireRootBotIdentity(workspace: Workspace, appId: string, secrets: Secrets, deadline?: RequestDeadline): Promise<void> {
    const installed = requireInstalledSecrets(secrets);
    if (installed.appId !== appId) throw new AppError('registration_boundary');
    const verify = () => requireBotIdentity(slackClient(installed.botToken, this.signal), workspace.teamId, installed.botUserId);
    if (deadline) await deadline.step(verify);
    else await verify();
    this.signal?.throwIfAborted();
  }
  async modal(workspace: Workspace, appId: string, actor: string): Promise<string> {
    authorizeOwner(workspace, workspace.teamId, actor);
    const id = randomBytes(16).toString('hex');
    if (!await this.root.create({ pk: `registration#${id}`, actor, teamId: workspace.teamId, appId, expiresAt: Math.floor(Date.now()/1000) + 900 })) throw new AppError('registration_conflict');
    return id;
  }
  async register(workspace: Workspace, appId: string, actor: string, id: string, input: unknown, deadline?: RequestDeadline): Promise<Registration> {
    authorizeOwner(workspace, workspace.teamId, actor);
    childResources(this.parentTable, this.parentSecret, id);
    const values = validateRegistrationInput(input);
    const [nonce, registry, secrets] = await Promise.all([
      this.root.get<{ actor: string; teamId: string; appId: string; expiresAt: number }>(`registration#${id}`),
      this.read(),
      this.root.readSecrets()
    ]);
    if (!nonce || nonce.actor !== actor || nonce.teamId !== workspace.teamId || nonce.appId !== appId || nonce.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('invalid_state');
    if (registry.deleting) throw new AppError('registration_removal_pending');
    const accepted = registry.entries.find(entry => entry.id === id);
    if (accepted) {
      if (accepted.actor !== actor || accepted.parentAppId !== appId || accepted.teamId !== workspace.teamId || !isDeepStrictEqual(values, { name: accepted.name, botName: accepted.botName, description: accepted.description })) throw new AppError('forbidden');
      return accepted;
    }
    if (registry.entries.length >= registrationLimit) throw new AppError('registration_limit');
    if (registry.entries.some(entry => entry.botName === values.botName)) throw new AppError('registration_name_in_use');
    const entry: Registration = { id, ...values, actor, teamId: workspace.teamId, parentAppId: appId, phase: 'queued', expiresAt: Math.floor(Date.now()/1000) + 21*86400 };
    await this.requireRootBotIdentity(workspace, appId, secrets, deadline);
    try {
      await this.db.transaction({ operations: [
        { check: { namespace: this.parentTable, key: { pk: 'workspace' }, condition: c.all(c.compare("teamId","=",":team"),c.compare("ownerId","=",":actor")), parameters: { ':team': workspace.teamId, ':actor': actor } } },
        { check: { namespace: this.parentTable, key: { pk: `registration#${id}` }, condition: c.all(c.compare("actor","=",":actor"),c.compare("teamId","=",":team"),c.compare("appId","=",":app"),c.compare("expiresAt",">",":now")), parameters: { ':actor': actor, ':team': workspace.teamId, ':app': appId, ':now': Math.floor(Date.now()/1000) } } },
        { put: { namespace: this.parentTable, item: { ...registry, version: registry.version+1, entries: [...registry.entries, entry] }, condition: (registry.version === 0 ? c.absent("pk") : c.all(c.compare("#version","=",":version"),c.compare("parentSecret","=",":parent"),c.group(c.any(c.absent("homeNoticeUntil"),c.compare("homeNoticeUntil","<=",":now"))))), ...(registry.version ? { fields: { '#version': 'version' }, parameters: { ':version': registry.version, ':parent': this.parentSecret, ':now': Math.floor(Date.now()/1000) } } : {}) } }
      ] }, { abortSignal: this.signal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('registration_conflict'); throw error; }
    return entry;
  }
}
export function registrationView(id: string): View {
  return { type: 'modal', callback_id: 'register_bot', private_metadata: id, title: { type: 'plain_text', text: '新しいRoughmate' }, submit: { type: 'plain_text', text: '作成を依頼' }, blocks: [
    { type: 'section', text: { type: 'plain_text', text: '別のSlackアプリと専用Botを作成します。作成後に「Slackに追加」を開いて許可してください。既存Botの名前変更ではありません。' } },
    { type: 'input', block_id: 'name', label: { type: 'plain_text', text: 'アプリ名（例 RoughmateB・経理窓口）' }, element: { type: 'plain_text_input', action_id: 'text', max_length: 35 } },
    { type: 'input', block_id: 'botName', label: { type: 'plain_text', text: 'Botメンション名（例 roughmateb）' }, hint: { type: 'plain_text', text: '小文字英数字と . _ -、先頭は英字。Slackでこの名前を選んでメンションします。' }, element: { type: 'plain_text_input', action_id: 'text', max_length: 35 } },
    { type: 'input', block_id: 'description', optional: true, label: { type: 'plain_text', text: '所属・説明' }, hint: { type: 'plain_text', text: '500文字まで保存します。Slackアプリの短い説明は先頭からUTF-8で140バイト以内に省略します。' }, element: { type: 'plain_text_input', action_id: 'text', max_length: 500, multiline: true } }
  ] };
}
export function registrationBlocks(registry: Registry, connected: boolean): KnownBlock[] {
  const labels: Record<RegistrationPhase, string> = { queued: '作成待ち', resources: '作成中', creating: '作成結果の確認が必要（自動再作成しません）', created: 'Slack接続準備中', install_wait: 'Slack追加待ち', available: '利用可能', failed: '作成に失敗しました。管理者が接続・運用状態を確認してください' };
  const oauthFailures: Record<string,string> = {
    oauth_scope_excess: '。OAuth権限に余剰があります。同じAppの再承認では減らせません。環境管理者が対象の専用Slack Appを削除し、最新Manifestで再作成してください。追加リンクの発行を停止しています。',
    oauth_scope_mismatch: '。OAuth権限が不足しています。登録設定の権限を確認し、新しいSlack追加リンクを開いてください。同じ承認リンクは再使用できません。',
    oauth_actor_mismatch: '。承認したSlackアカウントが登録操作者と一致しません。登録した本人のアカウントで新しいSlack追加リンクを開いてください。同じ承認リンクは再使用できません。',
    oauth_workspace_mismatch: '。承認したワークスペースまたはインストール方式が登録先と一致しません。登録先のワークスペースで新しいSlack追加リンクを開いてください。組織全体インストールには対応していません。同じ承認リンクは再使用できません。',
    oauth_app_mismatch: '。OAuth応答のAppが登録したBotと一致しません。環境管理者に接続先を確認し、新しいSlack追加リンクを開いてください。同じ承認リンクは再使用できません。'
  };
  return [{ type: 'divider' }, { type: 'header', text: { type: 'plain_text', text: '新しいBotの登録' } },
    { type: 'section', text: { type: 'plain_text', text: botDeletionConfirmationNotice } },
    { type: 'section', text: { type: 'plain_text', text: connected ? '別Botを登録し、最後にSlackへの追加を許可してください。' : '登録サービスは未接続、または更新結果の確認待ちです。環境管理者が初回接続・更新状態を確認してください。' } },
    ...(connected && !registry.deleting && registry.entries.length < registrationLimit ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'register_bot', text: { type: 'plain_text' as const, text: '新しいRoughmateを作る' }, value: 'register_bot' }] }] : []),
    ...registry.entries.flatMap(entry => [{ type: 'section' as const, text: { type: 'plain_text' as const, text: `${entry.name} (@${entry.botName}): ${entry.deletion ? entry.deletion.status==='queued' ? entry.deletion.failureCode==='answer_reconciliation_required' ? '停止済み・送信結果の再照合待ち。停止から150秒後、対応先の回答案にある「送信結果を再照合」を実行し、削除結果を再確認してください。照合に失敗した場合は送信保護を保持します。' : '停止済み・削除処理中。' : entry.deletion.status==='unknown' ? '停止済み・削除の結果確認待ち。' : '停止済み・削除できませんでした。結果を確認して再操作してください。' : ''}${entry.phase !== 'available' && entry.expiresAt <= Math.floor(Date.now()/1000) ? '期限切れ・管理者の確認が必要。' : ''}${entry.phase === 'creating' && entry.createRetryAt ? `Slackのレート制限で待機中（${new Date(entry.createRetryAt*1000).toISOString()}以降に再確認）` : entry.phase === 'install_wait' && entry.installOwner ? 'Slack追加の確認・設定中（コードを再交換しません）' : entry.phase === 'install_wait' && entry.oauthRetryAt && entry.oauthRetryAt > Math.floor(Date.now()/1000) ? `Slack追加のレート制限で待機中（${new Date(entry.oauthRetryAt*1000).toISOString()}以降に再承認）` : labels[entry.phase]}${entry.failureCode ? oauthFailures[entry.failureCode] ?? ` [${entry.failureCode}]` : ''}` } },
      ...(!entry.deletion && entry.expiresAt > Math.floor(Date.now()/1000) && entry.phase === 'install_wait' && entry.failureCode !== 'oauth_scope_excess' && !entry.installOwner && (!entry.oauthRetryAt || entry.oauthRetryAt <= Math.floor(Date.now()/1000)) ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'install_bot', text: { type: 'plain_text' as const, text: `${entry.name}をSlackに追加` }, value: entry.id }] }] : []),
      ...(!entry.deletion && entry.expiresAt > Math.floor(Date.now()/1000) && (['queued','resources','creating','created'].includes(entry.phase) || entry.phase === 'install_wait' && entry.installOwner) ? [{ type: 'actions' as const, elements: [{ type: 'button' as const, action_id: 'retry_bot', text: { type: 'plain_text' as const, text: '処理・保存結果を再確認' }, value: entry.id }] }] : []),
      ...(entry.phase==='available' && process.env.PUBLIC_URL ? [{type:'actions' as const,elements:[{type:'button' as const,action_id:'open_wiki_web',text:{type:'plain_text' as const,text:'このBotのWikiを開く'},url:process.env.PUBLIC_URL+'/wiki/bots/'+entry.id}]}]:[]),
      ...(entry.appId && entry.secretArn && entry.phase!=='creating' && (!entry.installOwner || entry.phase==='available') ? [{type:'actions' as const,elements:[{type:'button' as const,action_id:entry.deletion && entry.deletion.status!=='failed' ? 'check_bot_delete':'delete_bot',text:{type:'plain_text' as const,text:entry.deletion && entry.deletion.status!=='failed' ? '削除結果を確認':'Botを削除'},value:entry.id}]}]:[])])];
}
