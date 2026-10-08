import { c, type DocumentStore, type DocumentOperation } from './document-store.js';
import { wikiContentHash } from './wiki-content.js';
import { randomUUID } from 'node:crypto';
import { AppError } from './contracts.js';
import { requireIdentity, type GroupIdentity, type KnowledgeDocument } from './groups.js';
import { answerRetained, hashText, wikiLimits, type Citation, type WikiPage, type WikiRoot, type WorkState } from './wiki-model.js';
import { promptCitation, promptDocument } from './wiki-provenance.js';

type TransactionItems=DocumentOperation[];
export interface ErasureHead extends GroupIdentity { pk:string; answerId:string; version:number; nodes:number; head?:string; purged?:true; cursor?:string; offset?:number; remaining?:number; }
interface ErasureNode extends GroupIdentity { pk:string; answerId:string; targets:string[]; next?:string; }
export interface SavedArtifact { pk:string; citations:Citation[]; }
const identity=(value:GroupIdentity):GroupIdentity=>({environmentId:value.environmentId,appId:value.appId,teamId:value.teamId});
export function erasureKey(answerId:string):string { return `wiki-erasure#${hashText(answerId)}`; }
function nodeKey(key:string):boolean { return /^wiki-erasure-node#[a-f0-9]{64}$/.test(key); }
function targetKey(key:string):boolean { return /^(?:wiki-version#[0-9]+|wiki-proposal#[a-zA-Z0-9_-]{1,128}|wiki-answer#[a-f0-9]{64}|request#[^\s]{1,256})$/.test(key); }
export function artifactCitations(item:Record<string,unknown>):Citation[] {
  const pages=item.pages as WikiPage[]|undefined,work=item.work as WorkState|undefined;
  const approval=item.approval as import('./wiki-model.js').WikiAnswerApproval|undefined;
  const references=(item.references ?? item.knowledgeReferences) as KnowledgeDocument[]|undefined;
  return [...(approval?.comparisonPages ?? []).flatMap(page=>page.citations),...(approval?.comparisonCitations ?? []),...((item.targets as import('./wiki-model.js').WikiUpdateTarget[]|undefined) ?? []).flatMap(target=>target.citations),...(pages ?? []).flatMap(page=>page.citations),...(work?.proposal ?? []).flatMap(page=>page.citations),...(references ?? []).filter(reference=>reference.body).flatMap(reference=>reference.origins ?? [])];
}
function answers(citations:Citation[],root:WikiRoot):Map<string,Citation> {
  const result=new Map<string,Citation>();let checks=0;
  const visit=(citation:Citation,depth:number)=>{
    if(++checks>2048 || depth>wikiLimits.proofDepth) throw new AppError('wiki_erasure_index_capacity');
    if(!citation.id.startsWith('wiki-answer#')) return;
    const proof=root.answers.find(answer=>answer.id===citation.id) ?? citation.answerProof;
    if(!/^wiki-answer#[a-f0-9]{64}$/.test(citation.id) || !proof || !Number.isFinite(Date.parse(proof.sentAt))) throw new AppError('invalid_wiki_citation');
    result.set(citation.id,{...citation,answerProof:{...proof,dependencies:proof.dependencies ?? []}});
    for(const dependency of proof.dependencies ?? []) visit(dependency,depth+1);
  };
  for(const citation of citations) visit(citation,0);
  return result;
}
export function expiredCitations(citations:Citation[],root:WikiRoot,now:number):boolean {
  return [...answers(citations,root).values()].some(citation=>!answerRetained(citation.answerProof!,root,now));
}
function pagesWithout(pages:WikiPage[],remove:(citations:Citation[])=>boolean):WikiPage[] {
  const kept=pages.filter(page=>!remove(page.citations));
  if(kept.length===pages.length) return pages;
  const ids=new Set(kept.map(page=>page.id));
  return kept.map(page=>({...page,relatedIds:page.relatedIds.filter(id=>ids.has(id))}));
}
export function scrubArtifact(item:Record<string,unknown>,remove:(citations:Citation[])=>boolean):Record<string,unknown> {
  const next={...item};
  if(Array.isArray(item.pages)) {next.pages=pagesWithout(item.pages as WikiPage[],remove);if(item.pagesHash!==undefined) next.pagesHash=wikiContentHash(next.pages);}
  const approval=item.approval as import('./wiki-model.js').WikiAnswerApproval|undefined;
  if(approval && remove(artifactCitations(item))) {
    delete next.approval;next.pages=[];next.pagesHash=wikiContentHash([]);next.targets=[];
    if(item.result && typeof item.result==='object') next.result={...item.result as Record<string,unknown>,changes:[]};
    const work=item.work as WorkState|undefined;
    next.work={status:'failed',attempts:work?.attempts ?? 0,failureCode:'wiki_retention_expired',...(work?.delivery ? {delivery:work.delivery}:{})};next.status='expired';
  }
  for(const field of ['references','knowledgeReferences']) if(Array.isArray(item[field])) next[field]=(item[field] as KnowledgeDocument[]).map(reference=>remove(reference.origins ?? []) ? promptDocument({...reference,title:'',body:''}):reference);
  if(Array.isArray(item.dependencies) && remove(item.dependencies as Citation[])) next.dependencies=(item.dependencies as Citation[]).map(promptCitation);
  const work=item.work as WorkState|undefined;
  if(work?.proposal) next.work={...work,proposal:pagesWithout(work.proposal,remove)};
  return next;
}
export function scrubRoot(root:WikiRoot,remove:(citations:Citation[])=>boolean):WikiRoot {
  return {...root,answers:root.answers.map(answer=>remove(answer.dependencies ?? []) ? {...answer,dependencies:(answer.dependencies ?? []).map(promptCitation)}:answer),pages:pagesWithout(root.pages,remove),sources:root.sources.map(source=>({...source,work:(scrubArtifact({work:source.work},remove).work as WorkState)})),...(root.manualJobs ? {manualJobs:root.manualJobs.map(job=>({...job,work:(scrubArtifact({work:job.work},remove).work as WorkState)}))}:{})};
}
export function transactionSize(items:TransactionItems):void {
  if(items.length>100 || Buffer.byteLength(JSON.stringify(items))>3500000) throw new AppError('wiki_transaction_capacity');
}
export class WikiErasureIndex {
  constructor(private db:DocumentStore,private table:string,private signal?:AbortSignal) {}
  private async get<T>(pk:string):Promise<T|undefined> {
    const result=await this.db.get({namespace:this.table,key:{pk},consistent:true}, {abortSignal:this.signal});return result.item as T|undefined;
  }
  rootCheck(root:WikiRoot):TransactionItems[number] {
    return {check:{namespace:this.table,key:{pk:'wiki'},condition: (root.version===0 ? c.absent("pk") : c.all(c.compare("#v","=",":v"),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"))),...(root.version ? {fields:{'#v':'version'},parameters:{':v':root.version,':env':root.environmentId,':app':root.appId,':team':root.teamId}}:{})}};
  }
  async head(root:WikiRoot,answerId:string):Promise<ErasureHead|undefined> {
    const head=await this.get<ErasureHead>(erasureKey(answerId));
    if(!head) return undefined;
    requireIdentity(head,root);
    if(head.pk!==erasureKey(answerId) || head.answerId!==answerId || !Number.isSafeInteger(head.version) || head.version<1 || !Number.isSafeInteger(head.nodes) || head.nodes<0 || head.remaining!==undefined && (!Number.isSafeInteger(head.remaining) || head.remaining<0 || head.remaining>head.nodes) || [head.head,head.cursor].some(key=>key!==undefined && !nodeKey(key)) || head.purged!==undefined && head.purged!==true || head.offset!==undefined && (!Number.isInteger(head.offset) || head.offset<0 || head.offset>wikiLimits.erasureTargets) || Buffer.byteLength(JSON.stringify(head))>wikiLimits.erasureNodeBytes) throw new AppError('invalid_wiki_erasure_index');
    if((head.nodes===0)!==(head.head===undefined) || (head.purged ? head.remaining===undefined || (head.remaining>0)!==(head.cursor!==undefined) || !head.cursor && head.offset!==undefined : head.cursor!==undefined || head.offset!==undefined || head.remaining!==undefined)) throw new AppError('invalid_wiki_erasure_index');
    return head;
  }
  putHead(next:ErasureHead,previous:ErasureHead|undefined):TransactionItems[number] {
    return {put:{namespace:this.table,item:next,condition: (previous ? c.all(c.compare("#v","=",":v"),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team")) : c.absent("pk")),...(previous ? {fields:{'#v':'version'},parameters:{':v':previous.version,':env':previous.environmentId,':app':previous.appId,':team':previous.teamId}}:{})}};
  }
  async reserve(root:WikiRoot,artifacts:SavedArtifact[]):Promise<void> {
    const targets=new Map<string,{citation:Citation;keys:Set<string>}>();
    for(const artifact of artifacts) for(const citation of answers(artifact.citations,root).values()) {
      if(!targetKey(artifact.pk)) throw new AppError('invalid_wiki_erasure_index');
      if(!answerRetained(citation.answerProof!,root,Date.now())) throw new AppError('wiki_retention_expired');
      const target=targets.get(citation.id) ?? {citation,keys:new Set<string>()};target.keys.add(artifact.pk);targets.set(citation.id,target);
    }
    if([...targets.values()].some(target=>target.keys.size>wikiLimits.erasureTargets)) throw new AppError('wiki_erasure_index_capacity');
    const entries=[...targets.entries()];
    for(let page=0;page<entries.length;page+=wikiLimits.erasureAnswers) {
      const bounded=entries.slice(page,page+wikiLimits.erasureAnswers),heads=new Map<string,ErasureHead|undefined>();
      for(let offset=0;offset<bounded.length;offset+=5) {
        const batch=await Promise.all(bounded.slice(offset,offset+5).map(async([id])=>[id,await this.head(root,id)] as const));
        for(const [id,head] of batch) heads.set(id,head);
      }
      const writes:TransactionItems=[this.rootCheck(root)];
      for(const [id,target] of bounded) {
        const previous=heads.get(id);
        if(previous?.purged) throw new AppError('wiki_retention_expired');
        const pk=`wiki-erasure-node#${hashText(id+randomUUID())}`,node:ErasureNode={pk,...identity(root),answerId:id,targets:[...target.keys],...(previous?.head ? {next:previous.head}:{})};
        if(Buffer.byteLength(JSON.stringify(node))>wikiLimits.erasureNodeBytes) throw new AppError('wiki_erasure_index_capacity');
        writes.push({put:{namespace:this.table,item:node,condition: c.absent("pk")}},this.putHead({pk:erasureKey(id),...identity(root),answerId:id,version:(previous?.version ?? 0)+1,nodes:(previous?.nodes ?? 0)+1,head:pk},previous));
      }
      transactionSize(writes);
      try {await this.db.transaction({operations:writes}, {abortSignal:this.signal});}
      catch(error) {if(error instanceof Error && error.name==='TransactionCanceledException') throw new AppError('wiki_conflict');throw error;}
    }
  }

  seal(root:WikiRoot,answerId:string,previous:ErasureHead|undefined):ErasureHead {
    return {pk:erasureKey(answerId),...identity(root),answerId,version:(previous?.version ?? 0)+1,nodes:previous?.nodes ?? 0,remaining:previous?.nodes ?? 0,purged:true,...(previous?.head ? {head:previous.head,cursor:previous.head,offset:0}:{})};
  }
  async target(root:WikiRoot,head:ErasureHead):Promise<{pk:string;next:ErasureHead}> {
    if(!head.purged || !head.cursor || head.remaining===undefined || head.remaining<1) throw new AppError('invalid_wiki_erasure_index');
    const node=await this.get<ErasureNode>(head.cursor);
    if(!node) throw new AppError('missing_wiki_erasure_index');requireIdentity(node,root);
    if(node.pk!==head.cursor || node.answerId!==head.answerId || !Array.isArray(node.targets) || !node.targets.length || node.targets.length>wikiLimits.erasureTargets || node.targets.some(key=>!targetKey(key)) || node.next!==undefined && (!nodeKey(node.next) || node.next===node.pk) || Buffer.byteLength(JSON.stringify(node))>wikiLimits.erasureNodeBytes) throw new AppError('invalid_wiki_erasure_index');
    const offset=head.offset ?? 0;
    if(offset>=node.targets.length) throw new AppError('invalid_wiki_erasure_index');
    const next={...head,version:head.version+1};
    if(offset+1<node.targets.length) next.offset=offset+1;
    else {
      next.remaining=head.remaining-1;
      if(!!node.next!==(next.remaining>0)) throw new AppError('invalid_wiki_erasure_index');
      delete next.cursor;delete next.offset;if(node.next) {next.cursor=node.next;next.offset=0;}
    }
    return {pk:node.targets[offset],next};
  }
  depends(citations:Citation[],root:WikiRoot,answerId:string):boolean { return answers(citations,root).has(answerId); }
}
