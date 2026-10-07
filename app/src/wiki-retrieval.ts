import type { WebClient } from '@slack/web-api';
import { AppError } from './contracts.js';
import { type GroupConfig, type KnowledgeCatalog, type KnowledgeDocument } from './groups.js';
import type { ConsultationEvidenceStore } from './consultation-store.js';
import { currentAnswer, answerRetained, currentCitation, citationScope, citationScopes, hashText, scopeKey, sourceKey, sourceConsultable, wikiLimits, type SourceRecord } from './wiki-model.js';
import { visibleScopes, viewerKey, WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import { ChannelAudience } from './channel-audience.js';
import { answerQuestion } from './answer-question.js';
import type { Consultation } from './contracts.js';

export function searchTerms(question:string):string[] {
  return [...new Set([...new Intl.Segmenter('ja',{granularity:'word'}).segment(question.toLowerCase())].filter(part=>part.isWordLike && part.segment.length>1).map(part=>part.segment))].slice(0,64);
}
export function relevance(document:Pick<KnowledgeDocument,'title'|'body'>,terms:string[]):number {
  const title=document.title.toLowerCase(),body=document.body.toLowerCase();
  return terms.reduce((sum,term)=>sum+(title.includes(term) ? 3:0)+(body.includes(term) ? 1:0),0);
}
export async function validateOriginalReferences(store:ConsultationEvidenceStore,client:WebClient,config:GroupConfig,user:string,item:Consultation,catalog:KnowledgeCatalog):Promise<void> {
  const references=(item.knowledgeReferences ?? []).filter(reference=>reference.kind==='url' || reference.kind==='answer');
  if(!references.length) return;
  const root=await store.wiki.root(config),access=new WikiAccess(client,config,user),history=new WikiHistoryAccess(store,config,root,catalog,access);
  for(const reference of references) {
    const citation=reference.origins?.[0];
    if(!citation || !currentCitation(citation,root,catalog,Date.now())) throw new AppError('knowledge_changed');
    const original=await history.citation(citation);
    let text:string;
    if(reference.kind==='url') {
      const source=root.sources.find(source=>`url:${source.id}:${source.revision}`===citation.id);
      const record=source && await store.wiki.get<SourceRecord>(sourceKey(source));
      if(!record || record.version!==citation.version || record.hash!==citation.hash || scopeKey(record)!==scopeKey(original)) throw new AppError('knowledge_changed');
      text=record.text;
    } else {
      const answer=await history.answer(citation);
      const question=answerQuestion(answer);
      if(!question) throw new AppError('knowledge_changed');
      text=JSON.stringify({question,answer:answer.answer});
    }
    const prefix='[原資料の抜粋]\n';
    if(reference.body!==text && (!reference.body.startsWith(prefix) || reference.body.length===prefix.length || reference.body.length>prefix.length+3000 || !text.includes(reference.body.slice(prefix.length)))) throw new AppError('knowledge_changed');
  }
}
export async function retrieveOriginals(store:ConsultationEvidenceStore,client:WebClient,config:GroupConfig,user:string,catalog:KnowledgeCatalog,selected:KnowledgeDocument[],terms:string[],channel:string,review:string,access=new WikiAccess(client,config,user),audience?:ChannelAudience):Promise<KnowledgeDocument[]> {
  const referenced=new Set(selected.flatMap(document=>document.origins?.map(citation=>citation.id) ?? []));
  const candidates=(catalog.originalDocuments ?? []).filter(document=>document.channelIds.includes(channel) && document.reviewChannelIds.includes(review));
  const ranked=candidates.sort((a,b)=>Number(referenced.has(b.source))-Number(referenced.has(a.source)) || relevance(b,terms)-relevance(a,terms)).slice(0,8);
  const {visible}=await visibleScopes(client,config,user,ranked,access);
  const bounded=await shareableDocuments(ranked.filter(document=>visible.has(viewerKey(document))),audience ?? new ChannelAudience(client,config,[channel,review]));
  if(!bounded.length) return [];
  const root=await store.wiki.root(config),result:KnowledgeDocument[]=[];
  const history=new WikiHistoryAccess(store,config,root,catalog,access);
  let bytes=0;
  for(const document of bounded) {
    const citation=document.origins?.[0],scope=citation && citationScope(citation,root,catalog);
    const rawAnswer=citation && (root.answers.find(answer=>answer.id===citation.id) ?? citation.answerProof);
    if(document.kind==='answer' && rawAnswer && !currentAnswer(rawAnswer,root,Date.now()) && answerRetained(rawAnswer,root,Date.now())) continue;
    if(!citation || !scope || !currentCitation(citation,root,catalog,Date.now()) || viewerKey({...scope,accessScopes:citationScopes([citation],root,catalog)})!==viewerKey(document)) throw new AppError('knowledge_changed');
    await access.require({...scope,accessScopes:citationScopes([citation],root,catalog)});
    let body:string;
    if(document.kind==='url') {
      const source=root.sources.find(source=>`url:${source.id}:${source.revision}`===document.source);
      if(!source || !sourceConsultable(source)) throw new AppError('knowledge_changed');
      const original=await store.wiki.get<SourceRecord>(sourceKey(source));
      if(!original || original.hash!==citation.hash || original.hash!==hashText(original.raw) || original.version!==document.version || scopeKey(original)!==scopeKey(source)) throw new AppError('missing_wiki_source');
      body=original.text;
    } else {
      const answer=await history.answer(citation);
      if(answer.version!==document.version || scopeKey(answer)!==scopeKey(document)) throw new AppError('knowledge_changed');
      if(!currentAnswer(answer,root,Date.now()) || !currentCitation(citation,root,catalog,Date.now())) continue;
      body=JSON.stringify({question:answerQuestion(answer),answer:answer.answer});
    }
    if(!referenced.has(document.source) && relevance({...document,body},terms)===0) continue;
    const at=terms.map(term=>body.toLowerCase().indexOf(term)).find(index=>index>=0) ?? 0;
    const start=Math.max(0,at-300);
    const snippet={...document,body:body.length<=3000 ? body:`[原資料の抜粋]\n${body.slice(start,start+3000)}`};
    const size=Buffer.byteLength(JSON.stringify(snippet));
    if(bytes+size>30000) continue;
    result.push(snippet);bytes+=size;
  }
  return result;
}

export async function shareableDocuments(documents:KnowledgeDocument[],audience:ChannelAudience):Promise<KnowledgeDocument[]> {
  const result:KnowledgeDocument[]=[];
  for(const document of documents) {
    try { await audience.require(document);result.push(document); }
    catch(error) {
      if(!(error instanceof AppError) || !['forbidden','wiki_membership_incomplete','bot_not_in_channel','external_channel_not_supported'].includes(error.code)) throw error;
    }
  }
  return result;
}
export async function validateSharedReferences(store:ConsultationEvidenceStore,client:WebClient,config:GroupConfig,item:Consultation,catalog:KnowledgeCatalog,audience=new ChannelAudience(client,config,[item.sourceChannel,item.reviewChannel])):Promise<void> {
  const references=item.knowledgeReferences ?? [];
  if(!references.length) return;
  audience.requireConfig(config);
  const root=await store.wiki.root(config);
  const history=new WikiHistoryAccess(store,config,root,catalog,audience,wikiLimits.dependencies*wikiLimits.proofDepth);
  for(const reference of references) {
    await audience.require(reference);
    const citations=reference.origins ?? [{id:`manual:${reference.id}`,version:reference.version,hash:hashText(reference.body)}];
    for(const citation of citations) await history.citation(citation,0,references);
  }
}
