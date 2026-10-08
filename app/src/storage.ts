import type { SecretStore } from './runtime-ports.js';
import { c, type DocumentStore, type DocumentOperation } from './document-store.js';
import { runtime } from './runtime.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, object, string, validateSecrets, type Secrets, type Workspace, type Consultation, type AnswerCancellation } from './contracts.js';
import type { ChannelAuthorization, ChannelAuthorizationState } from './channel-authorization.js';
import type { KnowledgeRequest, KnowledgeHead } from './knowledge-ui.js';
import { WikiStorage } from './wiki-storage.js';
import { wikiDocuments, wikiContentVersion, originalDocuments, withheldManualIds, manualSource, requireManualSource, wikiLimits, type SourceRecord, type ManualHistory } from './wiki-model.js';
import { validateGroup, validateCatalog, requireIdentity, requireAdmin, requireIntake, settingsContent, type GroupIdentity, type GroupConfig, type KnowledgeCatalog } from './groups.js';
import type { ConsultationCondition, ConsultationStore, AnswerClaimStore, DraftPublicationStore } from './consultation-store.js';
import { documentConsultationCondition } from './consultation-condition.js';
import { encryptRootOAuthResult, decryptRootOAuthResult, type RootOAuthResult } from './root-oauth-result.js';
export const settingsRetentionSeconds = 21 * 24 * 60 * 60;
export interface SettingsReceipt { version: number; expiresAt: number; }
export function requireSettingsExpiry(expiresAt: unknown): number {
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= Math.floor(Date.now() / 1000)) throw new AppError('settings_request_expired');
  return expiresAt as number;
}
export class Storage implements ConsultationStore, AnswerClaimStore, DraftPublicationStore {
  private db: DocumentStore;
  private secrets: SecretStore;
  readonly wiki: WikiStorage;
  constructor(private table: string, private secretId: string, private abortSignal?: AbortSignal, region?: string, private secretVersion?: string) {
    this.db = runtime().documents(region);
    this.wiki = new WikiStorage(this.db, table, abortSignal);
    this.secrets = runtime().secrets(region);
  }
  async get<T>(pk: string): Promise<T | undefined> {
    const result = await this.db.get({ namespace: this.table, key: { pk }, consistent: true }, { abortSignal: this.abortSignal });
    return result.item as T | undefined;
  }
  async create(item: Record<string, unknown>): Promise<boolean> {
    try { await this.db.put({ namespace: this.table, item: item, condition: c.absent("pk") }, { abortSignal: this.abortSignal }); return true; }
    catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  async createConsultation(config: GroupConfig, item: Consultation): Promise<boolean> {
    requireIntake(config, item.sourceChannel);
    requireIdentity(item as Consultation & GroupIdentity, config);
    if(item.configVersion!==config.version || item.reviewChannel!==config.reviewChannelId) throw new AppError('draft_boundary_changed');
    try {
      await this.db.transaction({ operations: [
        { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } },
        { put: { namespace: this.table, item: item, condition: c.absent("pk") } }
      ] }, { abortSignal: this.abortSignal });
      return true;
    } catch(error) {
      if(!(error instanceof Error) || error.name!=='TransactionCanceledException') throw error;
      const reasons=(error as Error & {CancellationReasons?:{Code?:string}[]}).CancellationReasons;
      if(reasons?.length===2 && reasons[0].Code==='None' && reasons[1].Code==='ConditionalCheckFailed') return false;
      throw new AppError('settings_conflict');
    }
  }
  async workspace(): Promise<Workspace> {
    const config = await this.get<Workspace>('workspace');
    if (!config) throw new AppError('not_installed');
    return config;
  }
  async group(identity: GroupIdentity): Promise<GroupConfig> {
    const raw = await this.get('roughmate');
    if (!raw) throw new AppError('group_not_configured');
    const config = validateGroup(raw);
    requireIdentity(config, identity);
    return config;
  }
  async manualKnowledge(identity: GroupIdentity): Promise<KnowledgeCatalog> {
    const raw = await this.get('knowledge');
    if (!raw) throw new AppError('knowledge_not_initialized');
    return validateCatalog(raw, identity);
  }
  async knowledge(identity: GroupIdentity): Promise<KnowledgeCatalog> {
    const catalog = await this.manualKnowledge(identity);
    const root = await this.wiki.root(identity);
    const config = await this.group(identity);
    return { ...catalog, withheldManualIds:withheldManualIds(root,catalog), wikiVersion: wikiContentVersion(root), wikiDocuments: wikiDocuments(root, catalog, config), originalDocuments: originalDocuments(root,catalog,config) };
  }
  async initializeGroup(config: GroupConfig): Promise<void> {
    validateGroup(config);
    const catalog: KnowledgeCatalog = { pk: 'knowledge', environmentId: config.environmentId, appId: config.appId, teamId: config.teamId, version: 1, documents: [] };
    try {
      await this.db.transaction({ operations: [config, catalog].map(item => ({ put: { namespace: this.table, item, condition: c.absent("pk") } })) }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async saveGroup(previous: GroupConfig, next: GroupConfig, actor: string, request?: { id: string; version: number; owner?: string; generation?: string }, participation?: { owner: string; generation?: string }): Promise<void> {
    requireAdmin(previous, actor);
    requireIdentity(next, previous);
    validateGroup(next);
    if (next.version !== previous.version + 1) throw new AppError('invalid_group_config');
    const item = { ...next, postingUntil: 0 };
    delete item.publicationOwner;delete item.publicationKind;
    try {
      const put = { namespace: this.table, item,
        condition: c.all(c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")),(participation ? c.all(c.compare("publicationOwner","=",":owner"),c.compare("postingUntil",">",":now")) : c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now"))))),
        fields: { '#version': 'version' }, parameters: { ':version': previous.version, ':environment': previous.environmentId, ':app': previous.appId, ':team': previous.teamId, ':now': Math.floor(Date.now()/1000), ...(participation ? { ':owner': participation.owner } : {}) } };
      if (request) await this.db.transaction({ operations: [
        { ...(participation ? { update: { namespace: this.table, key: { pk: 'workspace' }, changes: [c.set("settingsNoticeUntil",":zero"),c.remove("settingsNoticeOwner")], condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.compare("settingsNoticeOwner","=",":owner"),c.compare("settingsNoticeUntil",">",":now")), parameters: { ':team': previous.teamId, ':version': request.version, ':request': request.id, ':owner': participation.owner, ':now': Math.floor(Date.now()/1000), ':zero': 0 } } } : { check: { namespace: this.table, key: { pk: 'workspace' }, condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.group(c.any(c.absent("settingsNoticeUntil"),c.compare("settingsNoticeUntil","<=",":now")))), parameters: { ':team': previous.teamId, ':version': request.version, ':request': request.id, ':now': Math.floor(Date.now()/1000) } } }) }, { put: put },
        { check: { namespace: this.table, key: { pk: `settings#${request.id}` }, condition: c.all(c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("expiresAt",">",":now"),c.absent("failureCode")),(request.owner ? c.compare("attemptOwner","=",":owner") : undefined)), fields: { '#version': 'version' }, parameters: { ':team': previous.teamId, ':version': request.version, ':now': Math.floor(Date.now()/1000), ...(request.owner ? { ':owner': request.owner } : {}) } } },
        ...(!participation?.generation && request.generation ? [{ check: { namespace: this.table, key: { pk: `channel-user#${actor}` }, condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("generation","=",":generation"),c.exists("cipher")), parameters: { ':environment': previous.environmentId, ':app': previous.appId, ':team': previous.teamId, ':actor': actor, ':generation': request.generation } } }] : []),
        ...(participation?.generation ? [{ update: { namespace: this.table, key: { pk: `channel-user#${actor}` }, changes: [c.remove("inviteUntil"),c.remove("inviteOwner"),c.remove("inviteStartedChannel")], condition: c.all(c.compare("generation","=",":generation"),c.compare("inviteOwner","=",":owner")), parameters: { ':generation': participation.generation, ':owner': participation.owner } } }] : [])
      ] }, { abortSignal: this.abortSignal });
      else await this.db.put(put, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && ['ConditionalCheckFailedException','TransactionCanceledException'].includes(error.name)) throw new AppError('settings_conflict'); throw error; }
  }
  async saveKnowledge(config: GroupConfig, previous: KnowledgeCatalog, next: KnowledgeCatalog, actor: string, request?: KnowledgeRequest): Promise<string[]> {
    requireAdmin(config, actor);
    const prior = validateCatalog(previous, config);
    const item = validateCatalog(next, config);
    delete item.wikiVersion;
    delete item.wikiDocuments;
    delete item.withheldManualIds;
    if (next.version !== previous.version + 1) throw new AppError('invalid_knowledge');
    const historyWrites = await this.manualHistoryWrites(config, prior, item);
    const manualChange = await this.wiki.manualKnowledgeChange(config, prior, item);
    try {
      await this.db.transaction({ operations: [
        { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor, ':now': Math.floor(Date.now()/1000) } } },
        ...(request ? [
          { check: { namespace: this.table, key: { pk: `knowledge-user#${actor}` }, ...this.knowledgeRequestCondition(config, request), condition: c.all(this.knowledgeRequestCondition(config, request).condition,c.group(c.any(c.absent("noticeUntil"),c.compare("noticeUntil","<=",":now")))) } },
          { update: { namespace: this.table, key: { pk: `knowledge#${request.requestId}` }, ...this.knowledgeRequestCondition(config, request), changes: [c.set("#result",":saved"),c.set("wikiTasks",":tasks")], condition: c.all(this.knowledgeRequestCondition(config, request).condition,c.group(c.any(c.absent("#result"),c.compare("#result","=",":pending")))), fields: { '#result': 'status' }, parameters: { ...this.knowledgeRequestCondition(config, request).parameters, ':saved': 'saved', ':pending': 'pending', ':tasks': manualChange.tasks } } }
        ] : []),
        { put: { namespace: this.table, item, condition: c.all(c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': previous.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } },
        ...historyWrites, manualChange.write
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
    return manualChange.tasks;
  }
  private async manualHistoryWrites(config:GroupConfig,previous:KnowledgeCatalog,next:KnowledgeCatalog):Promise<DocumentOperation[]> {
    const writes:DocumentOperation[]=[];
    for(const document of previous.documents) {
      const current=next.documents.find(item=>item.id===document.id);
      if(current && isDeepStrictEqual(current,document)) continue;
      if(current && (current.version!==next.version || current.version<=document.version)) throw new AppError('invalid_knowledge');
      const original=manualSource(document,config),existing=await this.get<SourceRecord>(original.pk);
      if(existing) {
        requireManualSource(existing,document,config);
        const fields=['id','version','title','source','kind','raw','text','hash','channelIds','reviewChannelIds','fetchedAt','environmentId','appId','teamId','accessScopes'];
        const names:Record<string,string>={},values:Record<string,unknown>={};
        const clauses=fields.map((field,index)=>{
          names[`#f${index}`]=field;
          const value=(existing as unknown as Record<string,unknown>)[field];
          if(value===undefined) return c.absent(`#f${index}`);
          values[`:f${index}`]=value;return c.compare(`#f${index}`, '=', `:f${index}`);
        });
        writes.push({check:{namespace:this.table,key:{pk:original.pk},condition:c.all(...clauses),fields:names,parameters:values}});
      } else writes.push({put:{namespace:this.table,item:original,condition: c.absent("pk")}});
      const headKey=`wiki-manual-history#${document.id}`,head=await this.get<ManualHistory>(headKey);
      if(head) {
        requireIdentity(head,config);
        if(!Number.isSafeInteger(head.version) || head.version<1 || head.version>=document.version) throw new AppError('settings_conflict');
      }
      const node:ManualHistory={pk:`${headKey}#${document.version}`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,version:document.version,...(head ? {previousVersion:head.version}: {})};
      if(Buffer.byteLength(JSON.stringify(original))>wikiLimits.itemBytes) throw new AppError('invalid_knowledge');
      writes.push({put:{namespace:this.table,item:node,condition: c.absent("pk")}},
        {put:{namespace:this.table,item:{...node,pk:headKey},condition: (head ? c.all(c.compare("#v","=",":v"),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")) : c.absent("pk")),...(head ? {fields:{'#v':'version'},parameters:{':v':head.version,':env':config.environmentId,':app':config.appId,':team':config.teamId}}: {})}});
    }
    for(const document of next.documents) {
      const prior=previous.documents.find(item=>item.id===document.id);
      if(prior && isDeepStrictEqual(prior,document)) continue;
      if(document.version!==next.version) throw new AppError('invalid_knowledge');
      const original=manualSource(document,config);
      if(Buffer.byteLength(JSON.stringify(original))>wikiLimits.itemBytes) throw new AppError('invalid_knowledge');
      writes.push({put:{namespace:this.table,item:original,condition: c.absent("pk")}});
    }
    if(writes.length>48 || Buffer.byteLength(JSON.stringify(writes))>1000000) throw new AppError('invalid_knowledge');
    return writes;
  }
  private knowledgeRequestCondition(identity: GroupIdentity, request: KnowledgeRequest) {
    return { condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("requestId","=",":request"),c.compare("expiresAt",">",":now")),
      parameters: { ':environment': identity.environmentId, ':app': identity.appId, ':team': identity.teamId, ':actor': request.userId, ':request': request.requestId, ':now': Math.floor(Date.now()/1000) } };
  }
  async requestKnowledge(config: GroupConfig, request: KnowledgeRequest): Promise<void> {
    requireAdmin(config, request.userId);
    requireIdentity(request, config);
    requireSettingsExpiry(request.expiresAt);
    const key = `knowledge-user#${request.userId}`;
    const previous = await this.get<KnowledgeHead>(key);
    if (previous) requireIdentity(previous, config);
    try {
      await this.db.transaction({ operations: [
        { put: { namespace: this.table, item: { pk: `knowledge#${request.requestId}`, ...request, status: 'pending' }, condition: c.absent("pk") } },
        { put: { namespace: this.table, item: { pk: key, environmentId: config.environmentId, appId: config.appId, teamId: config.teamId, requestId: request.requestId, userId: request.userId, expiresAt: request.expiresAt },
          condition: (previous ? c.all(c.compare("requestId","=",":previous"),c.group(c.any(c.absent("noticeUntil"),c.compare("noticeUntil","<=",":now")))) : c.absent("pk")),
          ...(previous ? { parameters: { ':previous': previous.requestId, ':now': Math.floor(Date.now()/1000) } } : {}) } },
        { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': request.userId, ':now': Math.floor(Date.now()/1000) } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async rejectKnowledge(config: GroupConfig, request: KnowledgeRequest, failureCode: string): Promise<void> {
    requireIdentity(request, config);
    const condition = this.knowledgeRequestCondition(config, request);
    try {
      await this.db.transaction({ operations: [
        { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } },
        { update: { namespace: this.table, key: { pk: `knowledge#${request.requestId}` }, ...condition, changes: [c.set("#result",":failed"),c.set("failureCode",":code")], condition: c.all(condition.condition,c.group(c.any(c.absent("#result"),c.compare("#result","=",":pending")))), fields: { '#result': 'status' }, parameters: { ...condition.parameters, ':failed': 'failed', ':pending': 'pending', ':code': failureCode } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async reserveKnowledgeNotice(config: GroupConfig, catalog: KnowledgeCatalog, request: KnowledgeRequest, status: 'saved' | 'failed', owner: string): Promise<void> {
    requireAdmin(config, request.userId);
    const condition = this.knowledgeRequestCondition(config, request), now = Math.floor(Date.now()/1000);
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: `knowledge-user#${request.userId}` }, ...condition, changes: [c.set("noticeUntil",":until"),c.set("noticeOwner",":owner")], condition: c.all(condition.condition,c.group(c.any(c.absent("noticeUntil"),c.compare("noticeUntil","<=",":now")))), parameters: { ...condition.parameters, ':until': now+150, ':owner': owner } } },
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":until"),c.set("publicationOwner",":owner"),c.set("publicationKind",":kind")], condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': request.userId, ':now': now, ':until': now+150, ':kind':'knowledge', ':owner': owner } } },
        { check: { namespace: this.table, key: { pk: `knowledge#${request.requestId}` }, ...condition, condition: c.all(condition.condition,c.compare("#result","=",":result")), fields: { '#result': 'status' }, parameters: { ...condition.parameters, ':result': status } } },
        { check: { namespace: this.table, key: { pk: 'knowledge' }, condition: c.all(c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': catalog.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async releaseKnowledgeNotice(actor: string, owner: string): Promise<void> {
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: `knowledge-user#${actor}` }, changes: [c.set("noticeUntil",":zero"),c.remove("noticeOwner")], condition: c.compare("noticeOwner","=",":owner"), parameters: { ':zero': 0, ':owner': owner } } },
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":zero"),c.remove("publicationOwner"),c.remove("publicationKind")], condition: c.compare("publicationOwner","=",":owner"), parameters: { ':zero': 0, ':owner': owner } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async reservePublication(config: GroupConfig, catalog: KnowledgeCatalog, owner: string): Promise<void> {
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":until"),c.set("publicationOwner",":owner"),c.set("publicationKind",":kind")], condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':until': Math.floor(Date.now()/1000) + 150, ':kind':'draft', ':owner': owner, ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':now': Math.floor(Date.now()/1000) } } },
        { check: { namespace: this.table, key: { pk: 'knowledge' }, condition: c.all(c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': catalog.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } },
        ...this.wikiBoundary(catalog)
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async releasePublication(owner: string): Promise<void> {
    try {
      await this.db.update({ namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":zero"),c.remove("publicationOwner"),c.remove("publicationKind")], condition: c.compare("publicationOwner","=",":owner"), parameters: { ':zero': 0, ':owner': owner } }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('settings_conflict'); throw error; }
  }
  async claimAnswer(item: Consultation, patch: Partial<Consultation>, config: GroupConfig, catalog: KnowledgeCatalog): Promise<boolean> {
    const entries = Object.entries(patch);
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: item.pk }, changes: [...entries.map((_, i) => c.set(`#p${i}`, `:p${i}`)), c.remove('answerCancellation')], condition: c.all(c.compare("#status","=",":draft"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("configVersion","=",":version"),c.compare("draftTs","=",":draftTs")), fields: { ...Object.fromEntries(entries.map(([key], i) => [`#p${i}`, key])), '#status': 'status' }, parameters: { ...Object.fromEntries(entries.map(([, value], i) => [`:p${i}`, value])), ':draft': 'draft', ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':version': config.version, ':draftTs': string(item.draftTs) } } },
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":until"),c.set("publicationOwner",":owner"),c.set("publicationKind",":kind")], condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':until': patch.postingUntil, ':kind':'answer', ':owner': string(patch.postingOwner), ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':now': Math.floor(Date.now()/1000) } } },
        { check: { namespace: this.table, key: { pk: 'knowledge' }, condition: c.all(c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), fields: { '#version': 'version' }, parameters: { ':version': catalog.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } },
        ...this.wikiBoundary(catalog)
      ] }, { abortSignal: this.abortSignal });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const current = await this.get<Consultation>(item.pk);
      if (current && current.status !== 'draft') return false;
      throw new AppError('settings_conflict');
    }
  }
  async cancelAnswerClaim(item: Consultation): Promise<boolean> {
    const postingUntil = item.postingUntil, configVersion = item.configVersion;
    if (typeof postingUntil !== 'number' || !Number.isSafeInteger(postingUntil) || typeof configVersion !== 'number' || !Number.isSafeInteger(configVersion)) throw new AppError('invalid_input');
    const cancellation: AnswerCancellation = { postingOwner: string(item.postingOwner), actorId: string(item.actorId), environmentId: string(item.environmentId), appId: string(item.appId), teamId: item.teamId, configVersion, draftTs: string(item.draftTs), postingUntil };
    const condition = this.answerCancellationCondition(cancellation);
    // 投稿前の失敗という証跡を先に残す。停止後の再配送も、投稿結果不明との区別を維持する。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.db.update({ namespace: this.table, key: { pk: item.pk }, ...condition, changes: [c.set("answerCancellation",":cancellation")],
          condition: c.all(condition.condition,c.all(c.group(c.any(c.compare("#status","=",":posting"),c.compare("#status","=",":uncertain"))),c.compare("postingOwner","=",":owner"),c.compare("actorId","=",":actor"),c.compare("postingUntil","=",":until"),c.absent("answerTs"),c.group(c.any(c.absent("answerCancellation"),c.compare("answerCancellation","=",":cancellation"))))),
          fields: { '#status': 'status' }, parameters: { ...condition.parameters, ':owner': cancellation.postingOwner, ':actor': cancellation.actorId, ':until': cancellation.postingUntil, ':posting': 'posting', ':uncertain': 'uncertain' } }, { abortSignal: this.abortSignal });
        break;
      } catch (error) {
        const current = await this.get<Consultation>(item.pk);
        if (isDeepStrictEqual(current?.answerCancellation, cancellation)) break;
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
        if (attempt === 1) throw error;
      }
    }
    return this.recoverAnswerCancellation({ ...item, answerCancellation: cancellation });
  }
  private answerCancellationCondition(cancellation: AnswerCancellation) {
    return { condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("configVersion","=",":version"),c.compare("draftTs","=",":draftTs")),
      parameters: { ':environment': cancellation.environmentId, ':app': cancellation.appId, ':team': cancellation.teamId, ':version': cancellation.configVersion, ':draftTs': cancellation.draftTs, ':cancellation': cancellation } };
  }
  async recoverAnswerCancellation(item: Consultation): Promise<boolean> {
    const cancellation = item.answerCancellation;
    if (!cancellation) return false;
    const condition = this.answerCancellationCondition(cancellation);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.get<Consultation>(item.pk);
      if (!current || !isDeepStrictEqual(current.answerCancellation, cancellation) || current.environmentId !== cancellation.environmentId || current.appId !== cancellation.appId || current.teamId !== cancellation.teamId || current.configVersion !== cancellation.configVersion || current.draftTs !== cancellation.draftTs || current.answerTs) return false;
      if (current.status !== 'draft' && ((current.status !== 'posting' && current.status !== 'uncertain') || current.postingOwner !== cancellation.postingOwner || current.actorId !== cancellation.actorId || current.postingUntil !== cancellation.postingUntil)) return false;
      try {
        if (current.status !== 'draft') await this.db.update({ namespace: this.table, key: { pk: item.pk }, ...condition, changes: [c.set("#status",":draft"),c.remove("answer"),c.remove("actorId"),c.remove("postingOwner"),c.remove("postingUntil")],
          condition: c.all(condition.condition,c.all(c.compare("answerCancellation","=",":cancellation"),c.group(c.any(c.compare("#status","=",":posting"),c.compare("#status","=",":uncertain"))),c.compare("postingOwner","=",":owner"),c.compare("actorId","=",":actor"),c.compare("postingUntil","=",":until"),c.absent("answerTs"))),
          fields: { '#status': 'status' }, parameters: { ...condition.parameters, ':owner': cancellation.postingOwner, ':actor': cancellation.actorId, ':until': cancellation.postingUntil, ':draft': 'draft', ':posting': 'posting', ':uncertain': 'uncertain' } }, { abortSignal: this.abortSignal });
        // 案が同じ取消済み世代にあることもDB内で検証し、後続claimや別所有者の保護を解除しない。
        await this.db.transaction({ operations: [
          { check: { namespace: this.table, key: { pk: item.pk }, ...condition, condition: c.all(condition.condition,c.all(c.compare("answerCancellation","=",":cancellation"),c.compare("#status","=",":draft"),c.absent("postingOwner"),c.absent("answerTs"))), fields: { '#status': 'status' }, parameters: { ...condition.parameters, ':draft': 'draft' } } },
          { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":zero"),c.remove("publicationOwner"),c.remove("publicationKind")],
            condition: c.all(c.compare("publicationOwner","=",":owner"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("postingUntil","=",":until")),
            fields: { '#version': 'version' }, parameters: { ':zero': 0, ':owner': cancellation.postingOwner, ':version': cancellation.configVersion, ':environment': cancellation.environmentId, ':app': cancellation.appId, ':team': cancellation.teamId, ':until': cancellation.postingUntil } } }
        ] }, { abortSignal: this.abortSignal });
        return true;
      } catch (error) {
        const saved = await this.get<Consultation>(item.pk), config = await this.get<GroupConfig>('roughmate');
        if (!isDeepStrictEqual(saved?.answerCancellation, cancellation)) return false;
        if (saved?.status === 'draft' && (config?.publicationOwner !== cancellation.postingOwner || config.postingUntil !== cancellation.postingUntil || config.version !== cancellation.configVersion || config.environmentId !== cancellation.environmentId || config.appId !== cancellation.appId || config.teamId !== cancellation.teamId)) return true;
        if (attempt === 1) throw error;
      }
    }
    throw new AppError('answer_state_conflict');
  }
  async requestSettings(workspace: Workspace, requestId: string, channelId: string, config: GroupConfig, actor: string): Promise<SettingsReceipt> {
    const content = settingsContent(config);
    const pk = `settings#${requestId}`;
    const previous = await this.get<{ teamId: string; userId: string; channelId: string; version: number; expiresAt?: number; actorId?: string; config?: GroupConfig }>(pk);
    this.abortSignal?.throwIfAborted();
    if (previous) {
      const expiresAt = requireSettingsExpiry(previous.expiresAt);
      if (previous.teamId !== workspace.teamId || previous.userId !== workspace.ownerId || previous.actorId !== actor || previous.channelId !== channelId || !previous.config || !isDeepStrictEqual(settingsContent(previous.config), content)) throw new AppError('forbidden');
      return { version: previous.version, expiresAt };
    }
    const version = (workspace.settingsVersion ?? 0) + 1;
    const expiresAt = Math.floor(Date.now() / 1000) + settingsRetentionSeconds;
    if (!Number.isSafeInteger(version) || version < 1) throw new AppError('invalid_input');
    try {
      await this.db.transaction({ operations: [
        { put: { namespace: this.table, item: { pk, teamId: workspace.teamId, userId: workspace.ownerId, channelId, version, expiresAt, config: content, actorId: actor }, condition: c.absent("pk") } },
        { update: { namespace: this.table, key: { pk: 'workspace' }, changes: [c.set("settingsVersion",":version"),c.set("settingsRequestId",":request")],
          condition: c.all(c.all(c.compare("teamId","=",":team"),c.compare("ownerId","=",":owner"),c.group(c.any(c.absent("settingsNoticeUntil"),c.compare("settingsNoticeUntil","<=",":now")))),(workspace.settingsVersion === undefined ? c.absent("settingsVersion") : c.compare("settingsVersion","=",":previous"))),
          parameters: { ':version': version, ':request': requestId, ':team': workspace.teamId, ':owner': workspace.ownerId, ':now': Math.floor(Date.now()/1000), ...(workspace.settingsVersion === undefined ? {} : { ':previous': workspace.settingsVersion }) } } }
      ] }, { abortSignal: this.abortSignal });
      this.abortSignal?.throwIfAborted();
      return { version, expiresAt };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      this.abortSignal?.throwIfAborted();
      const accepted = await this.get<{ teamId: string; userId: string; channelId: string; version: number; expiresAt?: number; actorId?: string; config?: GroupConfig }>(pk);
      this.abortSignal?.throwIfAborted();
      if (accepted && accepted.teamId === workspace.teamId && accepted.userId === workspace.ownerId && accepted.actorId === actor && accepted.channelId === channelId && accepted.config && isDeepStrictEqual(settingsContent(accepted.config), content)) return { version: accepted.version, expiresAt: requireSettingsExpiry(accepted.expiresAt) };
      // 並行した別要求が先に確定した場合は、Slack再試行で最新workspaceから登録する。
      throw new AppError('settings_conflict');
    }
  }
  async rejectSettings(config: GroupConfig, actor: string, request: { id: string; version: number }, failureCode: string): Promise<void> {
    requireAdmin(config, actor);
    try {
      await this.db.transaction({ operations: [
        { check: { namespace: this.table, key: { pk: 'workspace' }, condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request")), parameters: { ':team': config.teamId, ':version': request.version, ':request': request.id } } },
        { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor")), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor } } },
        { update: { namespace: this.table, key: { pk: `settings#${request.id}` }, changes: [c.setAbsent("failureCode",":code")], condition: c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("expiresAt",">",":now")), fields: { '#version': 'version' }, parameters: { ':team': config.teamId, ':version': request.version, ':now': Math.floor(Date.now()/1000), ':code': failureCode } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async beginSettingsAttempt(config: GroupConfig, actor: string, request: { id: string; version: number }, owner: string): Promise<void> {
    requireAdmin(config, actor);
    const now = Math.floor(Date.now()/1000);
    await this.channelTransaction([
      { check: { namespace: this.table, key: { pk: 'workspace' }, condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.group(c.any(c.absent("settingsNoticeUntil"),c.compare("settingsNoticeUntil","<=",":now")))), parameters: { ':team': config.teamId, ':version': request.version, ':request': request.id, ':now': now } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, actor) } },
      { update: { namespace: this.table, key: { pk: `settings#${request.id}` }, changes: [c.set("attemptOwner",":owner"),c.set("attemptUntil",":until"),c.remove("attemptRetryable")], condition: c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("actorId","=",":actor"),c.compare("expiresAt",">",":now"),c.absent("failureCode"),c.group(c.any(c.absent("attemptOwner"),c.group(c.all(c.compare("attemptUntil","<=",":now"),c.compare("attemptRetryable","=",":true")))))), fields: { '#version': 'version' }, parameters: { ':team': config.teamId, ':version': request.version, ':actor': actor, ':now': now, ':owner': owner, ':until': now+150, ':true': true } } }
    ]);
  }
  async retrySettingsAttempt(actor: string, request: { id: string; version: number }, owner: string): Promise<void> {
    await this.db.update({ namespace: this.table, key: { pk: `settings#${request.id}` }, changes: [c.set("attemptRetryable",":true")], condition: c.all(c.compare("#version","=",":version"),c.compare("actorId","=",":actor"),c.compare("attemptOwner","=",":owner"),c.absent("failureCode"),c.compare("expiresAt",">",":now")), fields: { '#version': 'version' }, parameters: { ':version': request.version, ':actor': actor, ':owner': owner, ':true': true, ':now': Math.floor(Date.now()/1000) } }, { abortSignal: this.abortSignal });
  }
  async reserveSettingsNotice(config: GroupConfig, actor: string, request: { id: string; version: number }, owner: string): Promise<void> {
    requireAdmin(config, actor);
    const now = Math.floor(Date.now()/1000), until = now + 150;
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: 'workspace' }, changes: [c.set("settingsNoticeUntil",":until"),c.set("settingsNoticeOwner",":owner")], condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.group(c.any(c.absent("settingsNoticeUntil"),c.compare("settingsNoticeUntil","<=",":now")))), parameters: { ':team': config.teamId, ':version': request.version, ':request': request.id, ':now': now, ':until': until, ':owner': owner } } },
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":until"),c.set("publicationOwner",":owner"),c.set("publicationKind",":kind")], condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor, ':now': now, ':until': until, ':kind':'settings', ':owner': owner } } },
        { check: { namespace: this.table, key: { pk: `settings#${request.id}` }, condition: c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("expiresAt",">",":now"),c.exists("failureCode")), fields: { '#version': 'version' }, parameters: { ':team': config.teamId, ':version': request.version, ':now': now } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async releaseSettingsNotice(owner: string): Promise<void> {
    try {
      await this.db.transaction({ operations: [
        { update: { namespace: this.table, key: { pk: 'workspace' }, changes: [c.set("settingsNoticeUntil",":zero"),c.remove("settingsNoticeOwner")], condition: c.compare("settingsNoticeOwner","=",":owner"), parameters: { ':zero': 0, ':owner': owner } } },
        { update: { namespace: this.table, key: { pk: 'roughmate' }, changes: [c.set("postingUntil",":zero"),c.remove("publicationOwner"),c.remove("publicationKind")], condition: c.compare("publicationOwner","=",":owner"), parameters: { ':zero': 0, ':owner': owner } } }
      ] }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  private channelGroupCondition(config: GroupConfig, user: string) {
    return { condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("postingUntil"),c.compare("postingUntil","<=",":now")))), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': user, ':now': Math.floor(Date.now()/1000) } };
  }
  async prepareChannelAuthorization(config: GroupConfig, user: string): Promise<ChannelAuthorization | undefined> {
    requireAdmin(config, user);
    const previous = await this.get<ChannelAuthorization>(`channel-user#${user}`);
    if (!previous) return;
    if (previous.environmentId !== config.environmentId || previous.teamId !== config.teamId || previous.userId !== user || previous.pk !== `channel-user#${user}`) throw new AppError('group_boundary_mismatch');
    if (previous.appId === config.appId) return previous;
    const progress = await this.get<{ phase: string; appId: string; retiredAppId?: string }>('setup#slack');
    if (progress?.phase !== 'created' || progress.appId !== config.appId || progress.retiredAppId !== previous.appId) throw new AppError('group_boundary_mismatch');
    const current: ChannelAuthorization = { pk: previous.pk, environmentId: config.environmentId, appId: config.appId, teamId: config.teamId, userId: user, generation: randomBytes(16).toString('hex') };
    await this.channelTransaction([
      { put: { namespace: this.table, item: current, condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":retired"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("generation","=",":generation")), parameters: { ':environment': config.environmentId, ':retired': previous.appId, ':team': config.teamId, ':actor': user, ':generation': string(previous.generation) } } },
      { check: { namespace: this.table, key: { pk: 'setup#slack' }, condition: c.all(c.compare("#phase","=",":created"),c.compare("appId","=",":app"),c.compare("retiredAppId","=",":retired")), fields: { '#phase': 'phase' }, parameters: { ':created': 'created', ':app': config.appId, ':retired': previous.appId } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, user) } }
    ]);
    return current;
  }
  async beginChannelAuthorization(config: GroupConfig, state: ChannelAuthorizationState): Promise<void> {
    requireAdmin(config, state.userId); requireIdentity(state, config);
    await this.channelTransaction([
      { put: { namespace: this.table, item: state, condition: c.absent("pk") } },
      { update: { namespace: this.table, key: { pk: `channel-user#${state.userId}` }, changes: [c.set("environmentId",":environment"),c.set("appId",":app"),c.set("teamId",":team"),c.set("userId",":user"),c.setAbsent("generation",":generation"),c.set("pendingGeneration",":generation"),c.set("pending",":state")], condition: c.all(c.group(c.any(c.absent("pk"),c.group(c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":user"))))),c.absent("scopeExcess"),c.absent("scopeCheckOwner"),c.group(c.any(c.absent("inviteUntil"),c.compare("inviteUntil","<=",":now")))), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':user': state.userId, ':generation': state.generation, ':state': state.pk, ':now': Math.floor(Date.now()/1000) } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, state.userId) } }
    ]);
  }
  async consumeChannelAuthorization(config: GroupConfig, state: ChannelAuthorizationState): Promise<void> {
    requireAdmin(config, state.userId); requireIdentity(state, config);
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: state.pk }, changes: [c.set("#consumed",":true")], condition: c.all(c.compare("generation","=",":generation"),c.compare("userId","=",":user"),c.compare("expiresAt",">",":now"),c.absent("#consumed")), fields: { '#consumed': 'consumed' }, parameters: { ':true': true, ':generation': state.generation, ':user': state.userId, ':now': Math.floor(Date.now()/1000) } } },
      { update: { namespace: this.table, key: { pk: `channel-user#${state.userId}` }, changes: [c.set("scopeCheckOwner",":state")], condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("pendingGeneration","=",":generation"),c.compare("pending","=",":state"),c.absent("scopeExcess"),c.absent("scopeCheckOwner")), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': state.userId, ':generation': state.generation, ':state': state.pk } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, state.userId) } }
    ]);
  }
  async finishChannelScopeCheck(config: GroupConfig, state: ChannelAuthorizationState): Promise<void> {
    await this.db.update({ namespace: this.table, key: { pk: `channel-user#${state.userId}` }, changes: [c.remove("scopeCheckOwner")], condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("scopeCheckOwner","=",":state"),c.absent("scopeExcess")), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': state.userId, ':state': state.pk } }, { abortSignal: this.abortSignal });
  }
  async saveChannelAuthorization(config: GroupConfig, state: ChannelAuthorizationState, value: ChannelAuthorization): Promise<void> {
    requireIdentity(value, config); requireAdmin(config, value.userId);
    if (value.userId !== state.userId || value.generation !== state.generation) throw new AppError('forbidden');
    await this.channelTransaction([
      { put: { namespace: this.table, item: value, condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("pendingGeneration","=",":generation"),c.compare("pending","=",":state"),c.absent("scopeExcess"),c.group(c.any(c.absent("inviteUntil"),c.compare("inviteUntil","<=",":now")))), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': state.userId, ':generation': state.generation, ':state': state.pk, ':now': Math.floor(Date.now()/1000) } } },
      { check: { namespace: this.table, key: { pk: state.pk }, condition: c.all(c.compare("generation","=",":generation"),c.compare("#consumed","=",":true"),c.compare("expiresAt",">",":now")), fields: { '#consumed': 'consumed' }, parameters: { ':generation': state.generation, ':true': true, ':now': Math.floor(Date.now()/1000) } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, state.userId) } }
    ]);
  }
  async rejectChannelAuthorizationScopes(config: GroupConfig, state: ChannelAuthorizationState): Promise<void> {
    requireAdmin(config, state.userId); requireIdentity(state, config);
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: `channel-user#${state.userId}` }, changes: [c.set("scopeExcess",":true")], condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor")), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': state.userId, ':true': true } } },
      { check: { namespace: this.table, key: { pk: state.pk }, condition: c.all(c.compare("generation","=",":generation"),c.compare("#consumed","=",":true"),c.compare("expiresAt",">",":now")), fields: { '#consumed': 'consumed' }, parameters: { ':generation': state.generation, ':true': true, ':now': Math.floor(Date.now()/1000) } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId } } }
    ]);
  }
  async disconnectChannelAuthorization(config: GroupConfig, user: string, generation: string): Promise<void> {
    requireAdmin(config, user);
    await this.prepareChannelAuthorization(config, user);
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: `channel-user#${user}` }, changes: [c.set("environmentId",":environment"),c.set("appId",":app"),c.set("teamId",":team"),c.set("userId",":actor"),c.set("generation",":generation"),c.remove("cipher"),c.remove("iv"),c.remove("tag"),c.remove("tokenExpiresAt"),c.remove("pending"),c.remove("pendingGeneration")], condition: c.any(c.absent("pk"),c.group(c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor")))), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': user, ':generation': generation } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor")), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': user } } }
    ]);
  }
  async reserveSettingsChannels(config: GroupConfig, actor: string, request: { id: string; version: number }, owner: string, generation?: string): Promise<void> {
    requireAdmin(config, actor);
    const now = Math.floor(Date.now()/1000);
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: 'workspace' }, changes: [c.set("settingsNoticeUntil",":until"),c.set("settingsNoticeOwner",":owner")], condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.group(c.any(c.absent("settingsNoticeUntil"),c.compare("settingsNoticeUntil","<=",":now")))), parameters: { ':team': config.teamId, ':version': request.version, ':request': request.id, ':now': now, ':until': now+150, ':owner': owner } } },
      { update: { namespace: this.table, key: { pk: 'roughmate' }, ...this.channelGroupCondition(config, actor), changes: [c.set("postingUntil",":until"),c.set("publicationOwner",":owner"),c.set("publicationKind",":kind")], parameters: { ...this.channelGroupCondition(config, actor).parameters, ':until': now+150, ':owner': owner, ':kind':'settings' } } },
      { update: { namespace: this.table, key: { pk: `settings#${request.id}` }, changes: [...[c.set("attemptOwner",":owner")],...(generation ? [c.setAbsent("inviteGeneration",":generation")] : [])], condition: c.all(c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("actorId","=",":actor"),c.compare("attemptOwner","=",":owner"),c.compare("expiresAt",">",":now"),c.absent("failureCode")),(generation ? c.group(c.any(c.absent("inviteGeneration"),c.compare("inviteGeneration","=",":generation"))) : undefined)), fields: { '#version': 'version' }, parameters: { ':team': config.teamId, ':version': request.version, ':actor': actor, ':now': now, ':owner': owner, ...(generation ? { ':generation': generation } : {}) } } },
      ...(generation ? [{ update: { namespace: this.table, key: { pk: `channel-user#${actor}` }, changes: [c.set("inviteUntil",":until"),c.set("inviteOwner",":owner")], condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("generation","=",":generation"),c.exists("cipher"),c.group(c.any(c.absent("inviteUntil"),c.compare("inviteUntil","<=",":now")))), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor, ':generation': generation, ':until': now+150, ':now': now, ':owner': owner } } }] : [])
    ]);
  }
  async releaseChannelInvite(user: string, owner: string): Promise<void> {
    await this.db.update({ namespace: this.table, key: { pk: `channel-user#${user}` }, changes: [c.remove("inviteUntil"),c.remove("inviteOwner"),c.remove("inviteStartedChannel")], condition: c.compare("inviteOwner","=",":owner"), parameters: { ':owner': owner } }, { abortSignal: this.abortSignal });
  }
  async startChannelInvite(config: GroupConfig, actor: string, request: { id: string; version: number }, owner: string, generation: string, channel: string): Promise<void> {
    requireAdmin(config, actor);
    const now = Math.floor(Date.now()/1000)+3;
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: `channel-user#${actor}` }, changes: [c.set("inviteStartedChannel",":channel")], condition: c.all(c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.compare("userId","=",":actor"),c.compare("generation","=",":generation"),c.exists("cipher"),c.compare("inviteOwner","=",":owner"),c.compare("inviteUntil",">",":now")), parameters: { ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor, ':generation': generation, ':owner': owner, ':now': now, ':channel': channel } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.all(c.absent("lifecycle"),c.compare("#version","=",":version"),c.compare("environmentId","=",":environment"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.compare("publicationOwner","=",":owner"),c.compare("postingUntil",">",":now")), fields: { '#version': 'version' }, parameters: { ':version': config.version, ':environment': config.environmentId, ':app': config.appId, ':team': config.teamId, ':actor': actor, ':owner': owner, ':now': now } } },
      { check: { namespace: this.table, key: { pk: 'workspace' }, condition: c.all(c.compare("teamId","=",":team"),c.compare("settingsVersion","=",":version"),c.compare("settingsRequestId","=",":request"),c.compare("settingsNoticeOwner","=",":owner"),c.compare("settingsNoticeUntil",">",":now")), parameters: { ':team': config.teamId, ':version': request.version, ':request': request.id, ':owner': owner, ':now': now } } },
      { check: { namespace: this.table, key: { pk: `settings#${request.id}` }, condition: c.all(c.compare("teamId","=",":team"),c.compare("#version","=",":version"),c.compare("actorId","=",":actor"),c.compare("attemptOwner","=",":owner"),c.compare("attemptUntil",">",":now"),c.compare("inviteGeneration","=",":generation"),c.compare("expiresAt",">",":now"),c.absent("failureCode")), fields: { '#version': 'version' }, parameters: { ':team': config.teamId, ':version': request.version, ':actor': actor, ':owner': owner, ':now': now, ':generation': generation } } }
    ]);
  }
  private async channelTransaction(items: DocumentOperation[]): Promise<void> {
    try { await this.db.transaction({ operations: items }, { abortSignal: this.abortSignal }); }
    catch (error) { if (error instanceof Error && error.name === 'TransactionCanceledException') throw new AppError('settings_conflict'); throw error; }
  }
  async readSecrets(): Promise<Secrets> {
    const result = await this.secrets.read({ id: this.secretId, ...(this.secretVersion ? { version: this.secretVersion } : {}) }, { abortSignal: this.abortSignal });
    return validateSecrets(JSON.parse(string(result)));
  }
  async saveSecrets(value: Secrets, operationId: string = randomUUID()): Promise<void> {
    await this.secrets.write({ id: this.secretId, operationId, value: JSON.stringify(validateSecrets(value)) }, { abortSignal: this.abortSignal });
  }
  async stageRootOAuthSecrets(base: Secrets, value: Secrets, attempt: string): Promise<void> {
    const progress = await this.get<{ appId: string; phase: string; oauthAttempt: string; oauthVersion: string; oauthExpiresAt: number; oauthResult?: RootOAuthResult; scopeExcess?: boolean }>('setup#slack');
    if (!progress || progress.appId !== base.appId || progress.phase !== 'created' || progress.scopeExcess || progress.oauthAttempt !== attempt || progress.oauthResult) throw new AppError('root_oauth_pending');
    const receipt = value.rootOAuth;
    if (!receipt) throw new AppError('root_oauth_pending');
    const result = encryptRootOAuthResult(base, value, { environmentId: this.secretId, appId: base.appId, requestId: attempt, operationId: progress.oauthVersion, teamId: receipt.teamId, ownerId: receipt.ownerId, expiresAt: progress.oauthExpiresAt });
    await this.channelTransaction([
      { check: { namespace: this.table, key: { pk: 'workspace' }, condition: c.any(c.absent('pk'), c.group(c.all(c.compare('teamId', '=', ':team'), c.compare('ownerId', '=', ':owner')))), parameters: { ':team': receipt.teamId, ':owner': receipt.ownerId } } },
      { update: { namespace: this.table, key: { pk: 'setup#slack' }, changes: [c.set('oauthResult', ':result')], condition: c.all(c.compare('appId', '=', ':app'), c.compare('phase', '=', ':created'), c.compare('oauthAttempt', '=', ':attempt'), c.compare('oauthVersion', '=', ':version'), c.compare('oauthExpiresAt', '=', ':expires'), c.absent('oauthResult'), c.absent('scopeExcess')), parameters: { ':app': base.appId, ':created': 'created', ':attempt': attempt, ':version': progress.oauthVersion, ':expires': progress.oauthExpiresAt, ':result': result } } }
    ]);
  }
  async resumeRootOAuthSecrets(base: Secrets, attempt: string): Promise<Secrets> {
    const progress = await this.get<{ appId: string; phase: string; oauthAttempt: string; oauthVersion: string; oauthExpiresAt: number; oauthResult?: RootOAuthResult; scopeExcess?: boolean }>('setup#slack');
    if (!progress || progress.appId !== base.appId || progress.phase !== 'created' || progress.scopeExcess || progress.oauthAttempt !== attempt || !progress.oauthResult) throw new AppError('root_oauth_pending');
    const value = decryptRootOAuthResult(base, progress.oauthResult, { environmentId: this.secretId, requestId: attempt, operationId: progress.oauthVersion, expiresAt: progress.oauthExpiresAt });
    const group = await this.get('roughmate');
    if (group) { const config = validateGroup(group); requireIdentity(config, { environmentId: this.secretId, appId: base.appId, teamId: progress.oauthResult.teamId }); if (config.lifecycle) throw new AppError('root_oauth_pending'); }
    await this.channelTransaction([{ check: { namespace: this.table, key: { pk: 'setup#slack' }, condition: c.all(c.compare('appId', '=', ':app'), c.compare('phase', '=', ':created'), c.compare('oauthAttempt', '=', ':attempt'), c.compare('oauthVersion', '=', ':version'), c.compare('oauthExpiresAt', '=', ':expires'), c.compare('oauthExpiresAt', '>', ':now'), c.compare('oauthResult', '=', ':result'), c.absent('scopeExcess')), parameters: { ':app': base.appId, ':created': 'created', ':attempt': attempt, ':version': progress.oauthVersion, ':expires': progress.oauthExpiresAt, ':now': Math.floor(Date.now() / 1000), ':result': progress.oauthResult } } },
      { check: { namespace: this.table, key: { pk: 'roughmate' }, condition: c.any(c.absent('pk'), c.group(c.all(c.compare('environmentId', '=', ':env'), c.compare('appId', '=', ':app'), c.compare('teamId', '=', ':team'), c.absent('lifecycle')))), parameters: { ':env': this.secretId, ':app': base.appId, ':team': progress.oauthResult.teamId } } }
    ]);
    await this.install({ teamId: progress.oauthResult.teamId, ownerId: progress.oauthResult.ownerId });
    await this.saveSecrets(value, progress.oauthVersion);
    return value;
  }
  async rejectRootScopes(appId: string): Promise<void> {
    try {
      await this.db.update({ namespace: this.table, key: { pk: 'setup#slack' }, changes: [c.set("scopeExcess",":true")], condition: c.all(c.compare("appId","=",":app"),c.compare("#phase","=",":created")), fields: { '#phase': 'phase' }, parameters: { ':app': appId, ':created': 'created', ':true': true } }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('settings_conflict'); throw error; }
  }
  async beginRootOAuth(appId: string, pk: string, now: number): Promise<{ teamId?: string; ownerId?: string }> {
    const expected = await this.get<{ teamId?: string; ownerId?: string; expiresAt: number }>(pk);
    if (!expected || expected.expiresAt <= now) throw new AppError('invalid_state');
    await this.channelTransaction([
      { update: { namespace: this.table, key: { pk: 'setup#slack' }, changes: [c.set("oauthAttempt",":attempt"),c.set("oauthVersion",":version"),c.set("oauthExpiresAt",":expires")], condition: c.all(c.compare("appId","=",":app"),c.compare("#phase","=",":created"),c.absent("scopeExcess"),c.absent("oauthAttempt"),c.absent("oauthResult")), fields: { '#phase': 'phase' }, parameters: { ':app': appId, ':created': 'created', ':attempt': pk, ':version': randomUUID(), ':expires': expected.expiresAt } } },
      { delete: { namespace: this.table, key: { pk }, condition: c.compare("expiresAt",">",":now"), parameters: { ':now': now } } }
    ]);
    if (expected.teamId === undefined && expected.ownerId === undefined) return {};
    return { teamId: string(expected.teamId), ownerId: string(expected.ownerId) };
  }
  async finishRootOAuth(appId: string, attempt: string): Promise<void> {
    await this.db.update({ namespace: this.table, key: { pk: 'setup#slack' }, changes: [c.remove("oauthAttempt"),c.remove("oauthVersion"),c.remove("oauthExpiresAt"),c.remove("oauthResult")], condition: c.all(c.compare("appId","=",":app"),c.compare("#phase","=",":created"),c.compare("oauthAttempt","=",":attempt"),c.absent("scopeExcess")), fields: { '#phase': 'phase' }, parameters: { ':app': appId, ':created': 'created', ':attempt': attempt } }, { abortSignal: this.abortSignal });
  }
  async consumeState(pk: string, now: number): Promise<{ teamId?: string; ownerId?: string }> {
    try {
      const result = await this.db.delete({ namespace: this.table, key: { pk }, condition: c.compare("expiresAt",">",":now"), parameters: { ':now': now }, returnPrevious: 'ALL_OLD' }, { abortSignal: this.abortSignal });
      const value = object(result.previous);
      if (value.teamId === undefined && value.ownerId === undefined) return {};
      return { teamId: string(value.teamId), ownerId: string(value.ownerId) };
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('invalid_state'); throw error; }
  }
  async install(workspace: Workspace): Promise<void> {
    try {
      await this.db.update({ namespace: this.table, key: { pk: 'workspace' },
        changes: [c.set("teamId",":team"),c.set("ownerId",":owner")],
        condition: c.any(c.absent("pk"),c.group(c.all(c.compare("teamId","=",":team"),c.compare("ownerId","=",":owner")))),
        parameters: { ':team': workspace.teamId, ':owner': workspace.ownerId } }, { abortSignal: this.abortSignal });
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('forbidden'); throw error; }
  }
  async transition(pk: string, from: Consultation['status'], patch: Partial<Consultation>, condition?: ConsultationCondition): Promise<boolean> {
    if (patch.status === 'sent') {
      const item = await this.get<Consultation>(pk);
      if (!item || item.status !== from) return false;
      return this.wiki.confirmSent(item, string(patch.answerTs), condition);
    }
    if(patch.knowledgeReferences!==undefined) {
      const item=await this.get<Consultation>(pk);
      if(!item || item.status!==from) return false;
      return this.wiki.transitionReferences(item,from,patch,condition);
    }
    const extra = documentConsultationCondition(condition);
    const entries = Object.entries(patch);
    const names = Object.fromEntries(entries.map(([key], i) => [`#p${i}`, key]));
    const values = Object.fromEntries(entries.map(([, value], i) => [`:p${i}`, value]));
    try {
      await this.db.update({ namespace: this.table, key: { pk },
        changes: entries.map((_, i) => c.set(`#p${i}`, `:p${i}`)),
        condition: c.all(c.compare('#status', '=', ':from'), patch.draft!==undefined || patch.answer!==undefined ? c.absent('wikiErasedAt') : undefined, extra?.condition),
        fields: { ...names, '#status': 'status' }, parameters: { ...values, ':from': from, ...extra?.values } }, { abortSignal: this.abortSignal }); return true;
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  private wikiBoundary(catalog: KnowledgeCatalog): DocumentOperation[] {
    if (catalog.wikiVersion === undefined) return [];
    return [{ check: { namespace: this.table, key: { pk: 'wiki' }, condition: (catalog.wikiVersion === 0 ? c.absent("pk") : c.all(c.group(c.any(c.compare("contentVersion","=",":v"),c.group(c.all(c.absent("contentVersion"),c.compare("#v","=",":v"))))),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"))), ...(catalog.wikiVersion ? { fields: { '#v': 'version' }, parameters: { ':v': catalog.wikiVersion, ':env': catalog.environmentId, ':app': catalog.appId, ':team': catalog.teamId } } : {}) } }];
  }
}
