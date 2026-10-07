import { wikiContentHash } from './wiki-content.js';
import { isDeepStrictEqual } from 'node:util';
import type { WebClient } from '@slack/web-api';
import { AppError } from './contracts.js';
import { requireAdmin, requireIdentity, type GroupConfig, type GroupIdentity, type KnowledgeCatalog, type KnowledgeDocument } from './groups.js';
import { requireBotChannel } from './slack.js';
import { requireWikiPages, pageAdopted, answerCitation, answerKey, answerRetained, currentAnswer, hashText, historicalScopeRetained, requireManualSource, scopeKey, sourceConsultable, withheldManualIds, wikiLimits, type AnswerRecord, type Citation, type Scope, type SourceRecord, type WikiPage, type WikiRoot, type ManualHistory } from './wiki-model.js';
import type { ConsultationEvidenceStore } from './consultation-store.js';
import { answerDependencies } from './answer-evidence.js';
import { answerQuestion } from './answer-question.js';

export class WikiHistoryAccess {
  private pages=new WeakMap<WikiPage,{scope:Scope;consultable:boolean}>();
  private records=new Map<string,unknown>();
  private bytes=0;
  private checks=0;
  constructor(private store:Pick<ConsultationEvidenceStore,'wiki'>,private config:GroupConfig,private root:WikiRoot,private catalog:KnowledgeCatalog,private access:Pick<WikiAccess,'require'>,private recordLimit:number=wikiLimits.evidence) {}
  private async record<T>(pk:string):Promise<T|undefined> {
    if(this.records.has(pk)) return this.records.get(pk) as T|undefined;
    if(this.records.size>=this.recordLimit || this.bytes>=wikiLimits.historyPage*wikiLimits.answerBytes) throw new AppError('wiki_history_incomplete');
    const record=await this.store.wiki.get<T>(pk);
    this.bytes+=Buffer.byteLength(JSON.stringify(record ?? null));
    if(this.bytes>wikiLimits.historyPage*wikiLimits.answerBytes) throw new AppError('wiki_history_incomplete');
    this.records.set(pk,record);
    return record;
  }
  async comparison(citation:Citation,rawAnswers=true):Promise<Scope> {
    return this.citation(citation,0,[],rawAnswers,true);
  }
  async pageComparison(page:WikiPage):Promise<void> {
    if(page.status!=='ready' || !pageAdopted(page)) throw new AppError('wiki_target_review');
    // 正式Wiki本文を使う検査では原QAを再入力しない。現在の出典保留と保存版・全祖先は検査する。
    await this.page(page,true);
  }
  async citation(citation:Citation,depth=0,references:KnowledgeDocument[]=[],rawAnswers=false,consultable=false):Promise<Scope> {
    if(++this.checks>wikiLimits.dependencies*wikiLimits.proofDepth) throw new AppError('wiki_history_incomplete');
    if(depth>wikiLimits.proofDepth || !Number.isSafeInteger(citation.version) || citation.version<1 || !/^[a-f0-9]{64}$/.test(citation.hash)) throw new AppError('forbidden');
    if(/^wiki-answer#[a-f0-9]{64}$/.test(citation.id)) {
      const answer=await this.record<AnswerRecord>(citation.id);
      if(!answer || !Array.isArray(answer.references) || answer.dependencies!==undefined && !Array.isArray(answer.dependencies)) throw new AppError('forbidden');
      requireIdentity(answer,this.config);
      try {answerDependencies(answer.references);answerQuestion(answer);}
      catch(error) {if(error instanceof AppError) throw new AppError('forbidden');throw error;}
      const actual=answerCitation(answer),summary=this.root.answers.find(item=>item.id===answer.id);
      if(rawAnswers && (!currentAnswer(answer,this.root,Date.now()) || answer.questionState==='unavailable' && !answer.questionRecoveryHash)) throw new AppError('forbidden');
      if(answer.pk!==citation.id || answer.id!==citation.id || answerKey(answer.requestId)!==citation.id || answer.hash!==hashText(JSON.stringify([answer.question,answer.answer])) || answer.version!==citation.version || answer.hash!==citation.hash || !answerRetained(answer,this.root,Date.now()) || scopeKey(answer)!==scopeKey({channelIds:[answer.sourceChannel],reviewChannelIds:[answer.reviewChannel]}) || citation.answerProof && !isDeepStrictEqual(citation.answerProof,actual.answerProof) || summary && !isDeepStrictEqual(answerCitation(summary),actual) || (answer.dependencies?.length ?? 0)>wikiLimits.dependencies || answer.references.length>wikiLimits.dependencies) throw new AppError('forbidden');
      await this.access.require(answer);
      for(const dependency of answer.dependencies ?? []) {
        const scope=await this.citation(dependency,depth+1,answer.references,rawAnswers,consultable);
        if(!scope.channelIds.includes(answer.sourceChannel) || !scope.reviewChannelIds.includes(answer.reviewChannel)) throw new AppError('forbidden');
      }
      for(const reference of answer.references) {
        await this.access.require(reference);
        if(reference.origins) {
          if(reference.origins.length>wikiLimits.dependencies) throw new AppError('forbidden');
          for(const origin of reference.origins) await this.citation(origin,depth+1,answer.references,rawAnswers,consultable);
        } else await this.citation({id:`manual:${reference.id}`,version:reference.version,hash:hashText(reference.body)},depth+1,answer.references,rawAnswers,consultable);
      }
      return answer;
    }
    const manual=this.catalog.documents.find(document=>`manual:${document.id}`===citation.id);
    if(manual) {
      if(consultable && withheldManualIds(this.root,this.catalog).includes(manual.id)) throw new AppError('forbidden');
      if(citation.version>manual.version) throw new AppError('forbidden');
      const pk=`wiki-manual#${manual.id}#${citation.version}`;
      const original=await this.record<SourceRecord & {source:string}>(pk);
      // 別原文レコード作成前の確定回答は、同じ不変回答内の完全な手入力資料を原文にする。
      const saved=original ? undefined:manual.version===citation.version && hashText(manual.body)===citation.hash ? manual:references.find(reference=>(reference.kind===undefined || reference.kind==='manual') && !reference.origins && reference.id===manual.id && reference.version===citation.version && hashText(reference.body)===citation.hash);
      if(original) {
        if(typeof original.source!=='string' || typeof original.title!=='string') throw new AppError('forbidden');
        requireManualSource(original,{...manual,title:original.title,body:original.raw,source:original.source,version:citation.version,channelIds:original.channelIds,reviewChannelIds:original.reviewChannelIds},this.config);
        if(original.hash!==citation.hash || !historicalScopeRetained(original,manual)) throw new AppError('forbidden');
        await this.access.require(original);
      } else if(!saved || !historicalScopeRetained(saved,manual)) throw new AppError('forbidden');
      else await this.access.require(saved);
      await this.access.require(manual);
      return original ?? saved!;
    }
    const match=/^url:([a-zA-Z0-9_-]+):([a-f0-9]{24})$/.exec(citation.id);
    const current=match && this.root.sources.find(source=>source.id===match[1]);
    if(!match || !current) throw new AppError('forbidden');
    if(consultable && !sourceConsultable(current)) throw new AppError('forbidden');
    const pk=`wiki-source#${match[1]}#${match[2]}#${citation.version}`;
    const original=await this.record<SourceRecord & Partial<GroupIdentity>>(pk);
    if(!original || original.pk!==pk || original.id!==citation.id || original.version!==citation.version || original.hash!==citation.hash || original.hash!==hashText(original.raw) || original.kind!=='document' || !Number.isFinite(Date.parse(original.fetchedAt)) || !original.url || !historicalScopeRetained(original,current)) throw new AppError('forbidden');
    if(original.environmentId!==undefined || original.appId!==undefined || original.teamId!==undefined) requireIdentity(original as SourceRecord & GroupIdentity,this.config);
    await this.access.require(original);await this.access.require(current);
    return original;
  }
  async answer(citation:Citation):Promise<AnswerRecord> {
    const answer=await this.record<AnswerRecord>(citation.id);
    if(!answer || answer.purged || !answerRetained(answer,this.root,Date.now())) throw new AppError('missing_wiki_answer');
    await this.citation(citation);
    return answer;
  }
  async page(page:WikiPage,consultable=false):Promise<Scope> {
    const cached=this.pages.get(page);if(cached && (!consultable || cached.consultable)) return cached.scope;
    if(!page.citations.length || page.citations.length>8) throw new AppError('forbidden');
    let scope:Scope|undefined;
    for(const citation of page.citations) {
      const original=await this.citation(citation,0,[],false,consultable);
      if(page.human ? scopeKey(page.human.scope)!==page.scope || page.human.scope.channelIds.some(id=>!original.channelIds.includes(id)) || page.human.scope.reviewChannelIds.some(id=>!original.reviewChannelIds.includes(id)) : scopeKey(original)!==page.scope) throw new AppError('forbidden');
      scope=original;
    }
    if(page.human) {await this.access.require(page.human.scope);scope=page.human.scope;}
    this.pages.set(page,{scope:scope!,consultable});return scope!;
  }
  async manualHistory(id:string,version?:number):Promise<ManualHistory|undefined> {
    return this.record(`wiki-manual-history#${id}${version===undefined ? '':'#'+version}`);
  }
  async manualOriginal(id:string,version:number):Promise<SourceRecord|undefined> {
    return this.record(`wiki-manual#${id}#${version}`);
  }
  async urlOriginal(id:string,revision:string,version:number):Promise<SourceRecord|undefined> {
    return this.record(`wiki-source#${id}#${revision}#${version}`);
  }
  async snapshot(version:number):Promise<(GroupIdentity & {previousVersion?:number} & ({verified:true;pages:WikiPage[]}|{verified:false}))|undefined> {
    if(!Number.isSafeInteger(version) || version<1) throw new AppError('invalid_input');
    const snapshot=await this.record<GroupIdentity & {pk:string;version:number;pages:WikiPage[];previousVersion?:number;pagesHash?:string}>(`wiki-version#${version}`);
    if(!snapshot) return undefined;
    requireIdentity(snapshot,this.config);
    if(snapshot.pk!==`wiki-version#${version}` || snapshot.version!==undefined && snapshot.version!==version || snapshot.previousVersion!==undefined && (!Number.isSafeInteger(snapshot.previousVersion) || snapshot.previousVersion<0 || snapshot.previousVersion>=version)) throw new AppError('invalid_wiki');
    if(typeof snapshot.pagesHash!=='string' || snapshot.pagesHash!==wikiContentHash(snapshot.pages)) return {environmentId:snapshot.environmentId,appId:snapshot.appId,teamId:snapshot.teamId,verified:false,...(snapshot.previousVersion!==undefined ? {previousVersion:snapshot.previousVersion}:{})};
    requireWikiPages(snapshot.pages);
    return {...snapshot,verified:true};
  }
  async archived(pk:string):Promise<AnswerRecord|undefined> {
    return this.record(pk);
  }
}

export const wikiAccessLimit=16;
export class WikiAccess {
  private remaining=wikiAccessLimit;
  private members=new Map<string,Promise<void>>();
  private bots=new Map<string,Promise<void>>();
  constructor(private client:WebClient,private config:GroupConfig,private user:string) {}
  private spend():void {
    if(this.remaining<=0) throw new AppError('wiki_membership_incomplete');
    this.remaining--;
  }
  async member(channel:string):Promise<void> {
    let pending=this.members.get(channel);
    if(!pending) {
      pending=requireWikiMember(this.client,channel,this.user,()=>this.spend());
      this.members.set(channel,pending);
    }
    await pending;
  }
  async require(scope:Scope):Promise<void> {
    if(!/^[UW][A-Z0-9]+$/.test(this.user)) throw new AppError('forbidden');
    if(!scope.channelIds.length || !scope.reviewChannelIds.length) requireAdmin(this.config,this.user);
    const scopes=[scope,...scope.accessScopes ?? []];
    if(scopes.length>65 || scopes.some(item=>item.channelIds.some(channel=>!this.config.intakeChannelIds.includes(channel)) || item.reviewChannelIds.some(channel=>channel!==this.config.reviewChannelId))) throw new AppError('forbidden');
    for(const channel of new Set(scopes.flatMap(item=>[...item.channelIds,...item.reviewChannelIds]))) {
      await this.member(channel);
      let pending=this.bots.get(channel);
      if(!pending) {
        this.spend();pending=requireBotChannel(this.client,channel);this.bots.set(channel,pending);
      }
      await pending;
    }
  }
}
export async function requireWikiViewer(client:WebClient,config:GroupConfig,user:string,scope:Scope,access?:WikiAccess):Promise<void> {
  await (access ?? new WikiAccess(client,config,user)).require(scope);
}
export function viewerKey(scope:Scope):string {
  return scope.accessScopes?.length ? JSON.stringify([scopeKey(scope),...scope.accessScopes.map(scopeKey).sort()]):scopeKey(scope);
}
export interface VisibleScopes { visible:Set<string>; incomplete:boolean; }
export async function visibleScopes(client:WebClient,config:GroupConfig,user:string,scopes:Scope[],access=new WikiAccess(client,config,user)):Promise<VisibleScopes> {
  const visible=new Set<string>();
  let incomplete=false;
  for(const [key,scope] of new Map(scopes.map(scope=>[viewerKey(scope),scope]))) {
    try { await requireWikiViewer(client,config,user,scope,access); visible.add(key); }
    catch(error) {
      if(error instanceof AppError && error.code==='wiki_membership_incomplete') incomplete=true;
      else if(!(error instanceof AppError) || !['forbidden','bot_not_in_channel','external_channel_not_supported'].includes(error.code)) throw error;
    }
  }
  return {visible,incomplete};
}

export async function requireWikiMember(client:WebClient,channel:string,user:string,spend?:()=>void):Promise<void> {
  let cursor:string|undefined;
  const cursors=new Set<string>();
  for(let page=0;page<wikiAccessLimit;page++) {
    spend?.();
    const members=await client.conversations.members({channel,limit:200,cursor});
    if(members.members?.includes(user)) return;
    cursor=members.response_metadata?.next_cursor;
    if(!cursor) throw new AppError('forbidden');
    if(cursors.has(cursor)) throw new AppError('wiki_membership_incomplete');
    cursors.add(cursor);
  }
  throw new AppError('wiki_membership_incomplete');
}
