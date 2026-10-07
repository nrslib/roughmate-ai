import { hashText, wikiLimits } from './wiki-contract.js';
export { answerKey, hashText, wikiLimits } from './wiki-contract.js';
import { AppError, object, string } from './contracts.js';
import { requireIdentity, type GroupIdentity, type GroupConfig, type KnowledgeCatalog, type KnowledgeDocument } from './groups.js';


export interface Scope { channelIds:string[]; reviewChannelIds:string[]; accessScopes?:Scope[]; }
export interface QuestionEvidence { text:string; actorId:string; messageTs:string; channelId:string; threadTs:string; retrievedAt:string; hash:string; }
export interface AnswerProof extends Scope { sentAt:string; dependencies:Citation[]; questionState?:'captured'|'unavailable'; questionRecoveryHash?:string; }
export interface Citation { id:string; version:number; hash:string; answerProof?:AnswerProof; }
export interface Evidence extends Scope { id:string; version:number; hash:string; title:string; text:string; kind:'document'|'answer'; answerProof?:AnswerProof; }
export type WikiReviewReason='comparison_incomplete'|'comparison_unverified'|'formal_replacement';
export interface WikiComparison { target:string; relation:'consistent'|'conflict'|'unresolved'; }
export interface WikiProposal { pages:WikiPage[]; comparisons?:WikiComparison[]; }
export interface WikiUpdateTarget { id:string; title:string; scope:string; isNew:boolean; mergeVersion?:number; headingPath:string[]; before:string; knowledge:string; policy:string; rationale:string; citations:Citation[]; }
export interface WikiAnswerApproval { schema:2; configVersion:number; baseVersion:number; boundary:string; comparisonPages:WikiPage[]; comparisonCitations:Citation[]; }
export interface WikiCheckpoint extends WikiProposal, GroupIdentity { pk:string; previousProposalKey?:string; pagesHash?:string; inputId?:string; approval?:WikiAnswerApproval; targets?:WikiUpdateTarget[]; }
export interface WikiProposalDelivery { status:'not_sent'|'posting'|'sent'|'blocked'; hash:string; owner:string; until:number; ts?:string; }
export interface WikiPage { id:string; title:string; kind:'faq'|'procedure'|'term'|'example'|'case'; body:string; scope:string; mergeVersion?:number; citations:Citation[]; relatedIds:string[]; status:'ready'|'review'; comparisons?:WikiComparison[]; reviewReason?:WikiReviewReason; human?:import('./wiki-maintenance.js').WikiHumanChange; }
export interface WorkState { proposalHash?:string; adoptionKey?:string; delivery?:WikiProposalDelivery; humanDecision?:{actorId:string;at:string;operation:'confirm'|'reject';wikiVersion:number;proposalKey:string;boundary:string}; status:'pending'|'processing'|'ready'|'failed'|'review'; attempts:number; owner?:string; until?:number; refreshSource?:boolean; refreshBoundary?:string; proposal?:WikiPage[]; proposalKey?:string; proposalBoundary?:string; organized?:{version:number;hash:string;scope:string;status?:'ready'|'review';proposalKey?:string;comparisonBoundary?:string;readyBoundary?:string}; failureCode?:string; reviewReason?:WikiReviewReason; }
export interface UrlSource extends Scope { id:string; title:string; url:string; revision:string; version:number; hash?:string; fetchedAt?:string; contentType?:string; work:WorkState; }
export interface AnswerSummary extends Scope { id:string; version:number; hash:string; sentAt:string; dependencies?:Citation[]; questionState?:'captured'|'unavailable'; questionRecoveryHash?:string; }
export interface ArchiveRetention { step:number; cursor?:string; owner?:string; until?:number; nextRunAt?:number; retentionDays?:number; }
export interface WikiRoot extends GroupIdentity { pk:'wiki'; version:number; contentVersion?:number; purgedBefore?:number; sources:UrlSource[]; pages:WikiPage[]; answers:AnswerSummary[]; manualJobs?:{id:string;version:number;hash:string;work:WorkState}[]; proposalHead?:string; historyHead?:string; pendingIndexVersion?:1; pendingHead?:string; pendingSequence?:number; legacyHistoryHead?:string; erasureIndexVersion?:1; erasureContinuationVersion?:1; erasureCursor?:string; archiveRetention?:ArchiveRetention; previousVersion?:number; normalDays:number; retentionDays?:number; }
export interface AnswerRecord extends GroupIdentity, AnswerSummary {
  pk:string; requestId:string; question:string; draft:string; answer:string; actorId:string; answerTs:string;
  sourceChannel:string; sourceTs:string; mentionTs:string; reviewChannel:string; reviewTs:string;
  pendingKey?:string; references:import('./groups.js').KnowledgeReference[]; next?:string; work:WorkState; purged?:boolean;
  requesterId?:string; questionCapture?:QuestionEvidence; recoveredQuestion?:QuestionEvidence;
}
export interface SourceRecord extends Evidence { pk:string; raw:string; fetchedAt:string; url?:string; contentType?:string; }
export interface ManualHistory extends GroupIdentity { pk:string; version:number; previousVersion?:number; }
export function manualSource(document:KnowledgeDocument,identity:GroupIdentity):SourceRecord & GroupIdentity & {source:string} {
  return {pk:`wiki-manual#${document.id}#${document.version}`,environmentId:identity.environmentId,appId:identity.appId,teamId:identity.teamId,id:`manual:${document.id}`,version:document.version,title:document.title,source:document.source,text:document.body,raw:document.body,hash:hashText(document.body),kind:'document',channelIds:[...document.channelIds],reviewChannelIds:[...document.reviewChannelIds],fetchedAt:new Date().toISOString()};
}
export function requireManualSource(original:SourceRecord,document:KnowledgeDocument,identity:GroupIdentity):void {
  const record=original as SourceRecord & Partial<GroupIdentity> & {source?:string};
  if(record.environmentId!==undefined || record.appId!==undefined || record.teamId!==undefined) requireIdentity(record as GroupIdentity,identity);
  if(original.pk!==`wiki-manual#${document.id}#${document.version}` || original.id!==`manual:${document.id}` || original.version!==document.version || original.title!==document.title || record.source!==document.source || original.kind!=='document' || original.raw!==document.body || original.text!==document.body || original.hash!==hashText(document.body) || scopeKey(original)!==scopeKey(document) || original.accessScopes?.length || !Number.isFinite(Date.parse(original.fetchedAt))) throw new AppError('settings_conflict');
}

export function scopeKey(scope:Scope):string { return JSON.stringify([[...scope.channelIds].sort(),[...scope.reviewChannelIds].sort()]); }
export function scopeConfigured(scope:Scope,config:GroupConfig):boolean {
  return [scope,...scope.accessScopes ?? []].every(item=>item.channelIds.every(channel=>config.intakeChannelIds.includes(channel)) && item.reviewChannelIds.every(channel=>channel===config.reviewChannelId));
}
export function historicalScopeRetained(original:Scope,current:Scope):boolean {
  return original.channelIds.every(channel=>current.channelIds.includes(channel)) && original.reviewChannelIds.every(channel=>current.reviewChannelIds.includes(channel));
}
export function sourceKey(source:Pick<UrlSource,'id'|'revision'|'version'>):string { return `wiki-source#${source.id}#${source.revision}#${source.version}`; }

export function answerCitation(answer:AnswerSummary):Citation {
  return {id:answer.id,version:answer.version,hash:answer.hash,answerProof:{channelIds:[...answer.channelIds],reviewChannelIds:[...answer.reviewChannelIds],sentAt:answer.sentAt,dependencies:answer.dependencies ?? [],...(answer.questionState ? {questionState:answer.questionState}:{}),...(answer.questionRecoveryHash ? {questionRecoveryHash:answer.questionRecoveryHash}:{})}};
}
export function answerSummary(answer:AnswerSummary):AnswerSummary {
  const {id,version,hash,sentAt,channelIds,reviewChannelIds,dependencies,questionState,questionRecoveryHash}=answer;
  return {id,version,hash,sentAt,channelIds,reviewChannelIds,...(dependencies ? {dependencies}:{}),...(questionState ? {questionState}:{}),...(questionRecoveryHash ? {questionRecoveryHash}:{})};
}
export function emptyWiki(identity:GroupIdentity):WikiRoot { return {pk:'wiki',environmentId:identity.environmentId,appId:identity.appId,teamId:identity.teamId,version:0,pendingIndexVersion:1,erasureIndexVersion:1,erasureContinuationVersion:1,sources:[],pages:[],answers:[],normalDays:90}; }
export function requireWikiPages(pages:WikiPage[]):void {
  if(!Array.isArray(pages) || pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(pages))>wikiLimits.wikiBytes) throw new AppError('invalid_wiki');
  for(const page of pages) {
    if(page?.mergeVersion!==undefined && (!Number.isSafeInteger(page.mergeVersion) || page.mergeVersion<1)) throw new AppError('invalid_wiki');
    if(!page || typeof page.id!=='string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(page.id) || typeof page.title!=='string' || !page.title.trim() || page.title.length>120 || typeof page.body!=='string' || Buffer.byteLength(page.body)>wikiLimits.pageBytes || typeof page.scope!=='string' || !Array.isArray(page.citations) || !page.citations.length || page.citations.length>8 || !Array.isArray(page.relatedIds) || page.relatedIds.length>8 || page.relatedIds.some(id=>typeof id!=='string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(id)) || !['ready','review'].includes(page.status)) throw new AppError('invalid_wiki');
    const human=page.human;
    if(human && (!/^[UW][A-Z0-9]+$/.test(human.actorId) || !Number.isFinite(Date.parse(human.at)) || !['edit','merge','confirm'].includes(human.operation) || !Number.isSafeInteger(human.baseVersion) || human.baseVersion<0 || !Array.isArray(human.baseHashes) || !human.baseHashes.length || human.baseHashes.length>2 || human.baseHashes.some(hash=>!/^([a-f0-9]{64})$/.test(hash)) || !human.scope || [human.scope.channelIds,human.scope.reviewChannelIds].some(ids=>!Array.isArray(ids) || ids.length>20 || ids.some(id=>!/^([CG][A-Z0-9]+)$/.test(id))) || scopeKey(human.scope)!==page.scope || human.scope.accessScopes)) throw new AppError('invalid_wiki');
  }
}
export function validateWiki(raw:unknown,identity:GroupIdentity):WikiRoot {
  const value=object(raw) as unknown as WikiRoot;
  requireIdentity(value,identity);
  if (value.pk!=='wiki' || !Number.isSafeInteger(value.version) || value.version<0 || !Array.isArray(value.sources) || value.sources.length>wikiLimits.urls || !Array.isArray(value.pages) || value.pages.length>wikiLimits.pages || !Array.isArray(value.answers) || value.answers.length>wikiLimits.activeAnswers || !Number.isInteger(value.normalDays) || value.normalDays<1 || value.normalDays>3650 || value.retentionDays!==undefined && (!Number.isInteger(value.retentionDays) || value.retentionDays<1 || value.retentionDays>3650) || Buffer.byteLength(JSON.stringify(value))>wikiLimits.rootBytes) throw new AppError('invalid_wiki');
  if(value.erasureIndexVersion!==undefined && value.erasureIndexVersion!==1) throw new AppError('invalid_wiki');
  if(value.erasureContinuationVersion!==undefined && value.erasureContinuationVersion!==1 || value.erasureCursor!==undefined && !/^wiki-answer#[a-f0-9]{64}$/.test(value.erasureCursor)) throw new AppError('invalid_wiki');
  const retention=value.archiveRetention;
  if(retention && (!Number.isSafeInteger(retention.step) || retention.step<0 || retention.cursor!==undefined && !/^wiki-answer#[a-f0-9]{64}$/.test(retention.cursor) || (retention.owner===undefined)!==(retention.until===undefined) || retention.owner!==undefined && !/^[a-f0-9-]{36}$/.test(retention.owner) || [retention.until,retention.nextRunAt].some(time=>time!==undefined && (!Number.isSafeInteger(time) || time<0)) || retention.retentionDays!==undefined && (!Number.isInteger(retention.retentionDays) || retention.retentionDays<1 || retention.retentionDays>3650))) throw new AppError('invalid_wiki');
  if(value.proposalHead!==undefined && !/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(value.proposalHead)) throw new AppError('invalid_wiki');
  if(value.pendingIndexVersion!==undefined && value.pendingIndexVersion!==1 || value.pendingHead!==undefined && !/^wiki-pending#[a-f0-9]{64}$/.test(value.pendingHead)) throw new AppError('invalid_wiki');
  if(value.pendingSequence!==undefined && (!Number.isSafeInteger(value.pendingSequence) || value.pendingSequence<0)) throw new AppError('invalid_wiki');
  const validScope=(scope:Scope)=>[scope.channelIds,scope.reviewChannelIds].every(ids=>Array.isArray(ids) && ids.length<=20 && ids.every(id=>typeof id==='string' && /^[CG][A-Z0-9]+$/.test(id)) && new Set(ids).size===ids.length);
  const validWork=(work:WorkState)=>work && ['pending','processing','ready','failed','review'].includes(work.status) && Number.isInteger(work.attempts) && work.attempts>=0 && work.attempts<=wikiLimits.attempts && (work.refreshSource===undefined || typeof work.refreshSource==='boolean') && [work.refreshBoundary,work.proposalBoundary,work.organized?.comparisonBoundary,work.organized?.readyBoundary].every(boundary=>boundary===undefined || typeof boundary==='string' && /^[a-f0-9]{64}$/.test(boundary));
  const works=[...value.sources.map(source=>source.work),...(value.manualJobs ?? []).map(job=>job.work)];
  for(const work of works) requireProposalDelivery(work.delivery);
  if(value.contentVersion!==undefined && (!Number.isSafeInteger(value.contentVersion) || value.contentVersion<0) || value.purgedBefore!==undefined && (!Number.isFinite(value.purgedBefore) || value.purgedBefore<0)) throw new AppError('invalid_wiki');
  if(value.sources.some(source=>!validScope(source) || !validWork(source.work) || !Number.isInteger(source.version) || source.version<0 || typeof source.url!=='string' || source.url.length>500) || value.answers.some(answer=>!validScope(answer) || !Number.isFinite(Date.parse(answer.sentAt)) || !/^[a-f0-9]{64}$/.test(answer.hash) || (answer.dependencies?.length ?? 0)>wikiLimits.dependencies || answer.questionState!==undefined && !['captured','unavailable'].includes(answer.questionState) || answer.questionRecoveryHash!==undefined && (answer.questionState!=='unavailable' || !/^[a-f0-9]{64}$/.test(answer.questionRecoveryHash))) || value.manualJobs && (value.manualJobs.length>12 || value.manualJobs.some(job=>!validWork(job.work))) || Buffer.byteLength(JSON.stringify(value.pages))>wikiLimits.wikiBytes) throw new AppError('invalid_wiki');
  requireWikiPages(value.pages);
  return value;
}
export function currentAnswer(answer:Pick<AnswerSummary,'sentAt'> & {purged?:boolean},root:WikiRoot,now:number):boolean {
  return Date.parse(answer.sentAt)>now-root.normalDays*86400000 && answerRetained(answer,root,now);
}
export function answerRetained(answer:Pick<AnswerSummary,'sentAt'> & {purged?:boolean},root:WikiRoot,now:number):boolean {
  const sent=Date.parse(answer.sentAt);
  return !answer.purged && Number.isFinite(sent) && sent>(root.purgedBefore ?? 0) && (root.retentionDays===undefined || sent>now-root.retentionDays*86400000);
}
function citationAllowed(citation:Citation,root:WikiRoot,catalog:KnowledgeCatalog,now:number,consultation:boolean,depth=0,rawAnswers=false):boolean {
  if(depth>wikiLimits.proofDepth) return false;
  const manual=catalog.documents.find(document=>`manual:${document.id}`===citation.id);
  if(manual) return manual.version===citation.version && hashText(manual.body)===citation.hash && (!consultation || !withheldManualIds(root,catalog).includes(manual.id));
  const source=root.sources.find(source=>`url:${source.id}:${source.revision}`===citation.id);
  if(source) return source.version===citation.version && source.hash===citation.hash && (!consultation || sourceConsultable(source));
  if(!/^wiki-answer#[a-f0-9]{64}$/.test(citation.id)) return false;
  const answer=root.answers.find(answer=>answer.id===citation.id);
  const proof=answer ?? citation.answerProof;
  return !!proof && (proof.questionState!=='unavailable' || !!proof.questionRecoveryHash) && (proof.dependencies?.length ?? 0)<=wikiLimits.dependencies && (rawAnswers ? currentAnswer(proof,root,now):answerRetained(proof,root,now)) && (!answer || answer.version===citation.version && answer.hash===citation.hash) && (proof.dependencies ?? []).every(dependency=>{
    const scope=citationScope(dependency,root,catalog);
    return scope && proof.channelIds.every(channel=>scope.channelIds.includes(channel)) && proof.reviewChannelIds.every(channel=>scope.reviewChannelIds.includes(channel)) && citationAllowed(dependency,root,catalog,now,consultation,depth+1,rawAnswers);
  });
}
export function wikiCitation(citation:Citation,root:WikiRoot,catalog:KnowledgeCatalog,now:number):boolean {
  return citationAllowed(citation,root,catalog,now,true);
}
export function currentCitation(citation:Citation,root:WikiRoot,catalog:KnowledgeCatalog,now:number):boolean {
  return citationAllowed(citation,root,catalog,now,true,0,true);
}
export function comparisonCitation(citation:Citation,root:WikiRoot,catalog:KnowledgeCatalog,now:number):boolean {
  // 再比較には保留原文を使えるが、回答proofで保留知識を再注入しない。
  return citation.id.startsWith('wiki-answer#') ? currentCitation(citation,root,catalog,now):citationAllowed(citation,root,catalog,now,false);
}
export function wikiContentVersion(root:WikiRoot):number { return root.contentVersion ?? root.version; }
export function citationScope(citation:Citation,root:WikiRoot,catalog:KnowledgeCatalog):Scope|undefined {
  return catalog.documents.find(document=>`manual:${document.id}`===citation.id) ?? root.sources.find(source=>`url:${source.id}:${source.revision}`===citation.id) ?? (citation.id.startsWith('url:') ? root.sources.find(source=>source.id===citation.id.split(':')[1]):undefined) ?? root.answers.find(answer=>answer.id===citation.id) ?? citation.answerProof;
}
export function citationScopes(citations:Citation[],root:WikiRoot,catalog:KnowledgeCatalog,depth=0):Scope[] {
  if(depth>wikiLimits.proofDepth) return [];
  const scopes:Scope[]=[];
  for(const citation of citations) {
    const scope=citationScope(citation,root,catalog);
    if(scope) scopes.push({channelIds:scope.channelIds,reviewChannelIds:scope.reviewChannelIds});
    const proof=root.answers.find(answer=>answer.id===citation.id) ?? citation.answerProof;
    if(proof) scopes.push(...citationScopes(proof.dependencies ?? [],root,catalog,depth+1));
  }
  return [...new Map(scopes.map(scope=>[scopeKey(scope),scope])).values()];
}
export function pageAccessScope(page:WikiPage,root:WikiRoot,catalog:KnowledgeCatalog):Scope {
  const scope=citationScope(page.citations[0],root,catalog);
  if(!scope) throw new AppError('missing_wiki_source');
  return {...(page.human?.scope ?? scope),accessScopes:citationScopes(page.citations,root,catalog)};
}
export function availablePages(root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig,now:number):WikiPage[] {
  return root.pages.filter(page=>page.citations.length && page.citations.every(citation=>{
    const scope=citationScope(citation,root,catalog);
    return citationAllowed(citation,root,catalog,now,false) && scope && (page.human ? scopeKey(page.human.scope)===page.scope && page.human.scope.channelIds.every(id=>scope.channelIds.includes(id)) && page.human.scope.reviewChannelIds.every(id=>scope.reviewChannelIds.includes(id)) : scopeKey(scope)===page.scope) && scope.channelIds.every(channel=>config.intakeChannelIds.includes(channel)) && scope.reviewChannelIds.every(channel=>channel===config.reviewChannelId);
  }));
}
export function pageAdopted(page:WikiPage):boolean { return !!page.human || !page.citations.some(citation=>citation.id.startsWith('wiki-answer#')); }
export function wikiDocuments(root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig):KnowledgeDocument[] {
  return availablePages(root,catalog,config,Date.now()).filter(page=>page.status==='ready' && pageAdopted(page) && page.citations.every(citation=>wikiCitation(citation,root,catalog,Date.now()))).map(page=>{
    const scope=page.human?.scope ?? citationScope(page.citations[0],root,catalog)!;
    return {kind:'wiki',id:`wiki-${hashText(page.scope).slice(0,8)}-${page.id}`,title:page.title,body:page.body,source:`Wiki v${wikiContentVersion(root)} / ${page.citations.map(citation=>`${citation.id}@${citation.version}`).join(', ')}`,version:wikiContentVersion(root),origins:page.citations,channelIds:[...scope.channelIds],reviewChannelIds:[...scope.reviewChannelIds],accessScopes:citationScopes(page.citations,root,catalog)};
  });
}
export function sourceConsultable(source:UrlSource):boolean {
  const organized=source.work.organized;
  return source.work.status==='ready' && !!organized && organized.status==='ready' && organized.version===source.version && organized.hash===source.hash && organized.scope===scopeKey(source);
}
export function manualWithheld(work:WorkState):boolean { return work.status!=='ready' || work.organized?.status!=='ready'; }
export function withheldManualIds(root:WikiRoot,catalog:KnowledgeCatalog):string[] {
  return catalog.documents.filter(document=>{
    const hash=hashText(document.body),job=root.manualJobs?.find(job=>job.id===document.id && job.version===document.version && job.hash===hash);
    const organized=job?.work.organized;
    return !job || manualWithheld(job.work) || !organized || organized.version!==document.version || organized.hash!==hash || organized.scope!==scopeKey(document);
  }).map(document=>document.id);
}
function validateComparisons(raw:unknown):WikiComparison[]|undefined {
  if(raw===undefined) return undefined;
  if(!Array.isArray(raw) || raw.length>wikiLimits.evidence+wikiLimits.pages) throw new AppError('invalid_wiki_output');
  const comparisons=raw.map(raw=>{
    const check=object(raw),target=string(check.target),relation=string(check.relation);
    if(target.length>160 || !['consistent','conflict','unresolved'].includes(relation)) throw new AppError('invalid_wiki_output');
    return {target,relation:relation as WikiComparison['relation']};
  });
  if(new Set(comparisons.map(check=>check.target)).size!==comparisons.length) throw new AppError('invalid_wiki_output');
  return comparisons;
}
export function validateWikiProposal(raw:unknown,evidence:Evidence[],scope:string,existingIds:string[]=[]):WikiProposal {
  const comparisons=validateComparisons(object(raw).comparisons);
  return {pages:validateProposal(raw,evidence,scope,existingIds),...(comparisons ? {comparisons}: {})};
}
export function validateProposal(raw:unknown,evidence:Evidence[],scope:string,existingIds:string[]=[]):WikiPage[] {
  const value=object(raw);
  if(!Array.isArray(value.pages) || value.pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(raw))>wikiLimits.wikiBytes) throw new AppError('invalid_wiki_output');
  const pages=value.pages.map(raw=>{
    const page=object(raw);
    const id=string(page.id),title=string(page.title),body=string(page.body);
    if(!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || title.length>120 || Buffer.byteLength(body)>wikiLimits.pageBytes || !['faq','procedure','term','example','case'].includes(string(page.kind)) || !['ready','review'].includes(string(page.status)) || !Array.isArray(page.citations) || !page.citations.length || page.citations.length>8 || !Array.isArray(page.relatedIds) || page.relatedIds.length>8 || page.relatedIds.some(id=>typeof id!=='string')) throw new AppError('invalid_wiki_output');
    const citations=page.citations.map(raw=>{
      const citation=object(raw),id=string(citation.id);
      const original=evidence.find(item=>item.id===id);
      if(!original || original.version!==citation.version || original.hash!==citation.hash || scopeKey(original)!==scope) throw new AppError('invalid_wiki_citation');
      return {id,version:original.version,hash:original.hash,...(original.answerProof ? {answerProof:original.answerProof}: {})};
    });
    const comparisons=validateComparisons(page.comparisons);
    return {id,title,body,kind:page.kind as WikiPage['kind'],status:page.status as WikiPage['status'],scope,citations,relatedIds:page.relatedIds as string[],...(comparisons ? {comparisons}: {})};
  });
  if(new Set(pages.map(page=>page.id)).size!==pages.length || pages.some(page=>page.relatedIds.some(id=>!pages.some(other=>other.id===id) && !existingIds.includes(id)))) throw new AppError('invalid_wiki_output');
  return pages;
}

export function originalDocuments(root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig):KnowledgeDocument[] {
  const citations:Citation[]=[
    ...root.sources.filter(source=>source.hash && sourceConsultable(source)).map(source=>({id:`url:${source.id}:${source.revision}`,version:source.version,hash:source.hash!})),
  ];
  return [...new Map(citations.map(citation=>[citation.id,citation])).values()].filter(citation=>{
    const scope=citationScope(citation,root,catalog);
    return scope && scope.channelIds.every(channel=>config.intakeChannelIds.includes(channel)) && scope.reviewChannelIds.every(channel=>channel===config.reviewChannelId) && currentCitation(citation,root,catalog,Date.now());
  }).map(citation=>{
    const scope=citationScope(citation,root,catalog)!;
    const source=root.sources.find(source=>`url:${source.id}:${source.revision}`===citation.id);
    return {kind:source ? 'url':'answer',id:`original-${hashText(citation.id).slice(0,32)}`,title:source?.title ?? '確定回答',body:'',source:citation.id,version:citation.version,channelIds:[...scope.channelIds],reviewChannelIds:[...scope.reviewChannelIds],accessScopes:citationScopes([citation],root,catalog),origins:[citation]};
  });
}

export function requireProposalDelivery(delivery:WikiProposalDelivery|undefined):void {
  if(delivery && (!['not_sent','posting','sent','blocked'].includes(delivery.status) || !/^[a-f0-9]{64}$/.test(delivery.hash) || !/^[a-f0-9-]{36}$/.test(delivery.owner) || !Number.isSafeInteger(delivery.until) || delivery.until<0 || delivery.ts!==undefined && !/^\d+(?:\.\d+)?$/.test(delivery.ts) || ['sent','blocked'].includes(delivery.status) && !delivery.ts || delivery.status==='not_sent' && (delivery.until!==0 || delivery.ts!==undefined))) throw new AppError('invalid_wiki');
}
