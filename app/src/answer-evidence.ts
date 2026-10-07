import { isDeepStrictEqual } from 'node:util';
import { AppError, string, type Consultation } from './contracts.js';
import type { KnowledgeDocument } from './groups.js';
import { answerKey, hashText, wikiLimits } from './wiki-contract.js';
import type { AnswerRecord, Citation } from './wiki-model.js';

export function answerDependencies(documents:KnowledgeDocument[]):Citation[] {
  if(documents.length>wikiLimits.dependencies || Buffer.byteLength(JSON.stringify(documents))>wikiLimits.referenceBytes) throw new AppError('invalid_wiki_answer');
  const unique=new Map<string,Citation>();
  const check=(citations:Citation[],depth:number):void=>{
    if(citations.length && depth>wikiLimits.proofDepth || citations.length>wikiLimits.dependencies) throw new AppError('invalid_wiki_answer');
    for(const citation of citations) {
      if(!citation.id || !Number.isSafeInteger(citation.version) || citation.version<1 || !/^[a-f0-9]{64}$/.test(citation.hash)) throw new AppError('invalid_wiki_answer');
      if(!/^(?:manual:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}|url:[a-zA-Z0-9_-]+:[a-f0-9]{24}|wiki-answer#[a-f0-9]{64})$/.test(citation.id)) throw new AppError('invalid_wiki_answer');
      if(citation.id.startsWith('wiki-answer#')) {
        const proof=citation.answerProof;
        if(!proof || !Number.isFinite(Date.parse(proof.sentAt)) || !Array.isArray(proof.channelIds) || !Array.isArray(proof.reviewChannelIds) || !Array.isArray(proof.dependencies) || proof.questionState==='unavailable' && !proof.questionRecoveryHash || proof.questionRecoveryHash!==undefined && !/^[a-f0-9]{64}$/.test(proof.questionRecoveryHash)) throw new AppError('invalid_wiki_answer');
        check(proof.dependencies,depth+1);
      }
    }
  };
  for(const document of documents) {
    const kind=document.kind ?? 'manual';
    if(kind==='manual') {
      if(document.origins!==undefined || document.accessScopes!==undefined) throw new AppError('invalid_wiki_answer');
    } else {
      if(!['wiki','url','answer'].includes(kind) || !document.origins?.length || !document.accessScopes) throw new AppError('invalid_wiki_answer');
      if(kind!=='wiki' && (document.origins.length!==1 || document.source!==document.origins[0].id || (kind==='url' ? !/^url:[a-zA-Z0-9_-]+:[a-f0-9]{24}$/.test(document.source) : !/^wiki-answer#[a-f0-9]{64}$/.test(document.source)))) throw new AppError('invalid_wiki_answer');
    }
    const origins=kind==='manual' ? [{id:`manual:${document.id}`,version:document.version,hash:hashText(document.body)}] : document.origins!;
    for(const citation of origins) {
      const previous=unique.get(citation.id);
      if(previous && !isDeepStrictEqual(previous,citation)) throw new AppError('invalid_wiki_answer');
      unique.set(citation.id,citation);
    }
  }
  const dependencies=[...unique.values()];
  // 新回答自身がproofの一段を使う。祖先を切断して受理しない。
  check(dependencies,1);
  if(Buffer.byteLength(JSON.stringify(dependencies))>wikiLimits.referenceBytes) throw new AppError('invalid_wiki_answer');
  return dependencies;
}
export function selectAnswerDocuments(candidates:KnowledgeDocument[]):KnowledgeDocument[] {
  const selected:KnowledgeDocument[]=[];
  for(const document of candidates) {
    try { answerDependencies([...selected,document]); }
    catch(error) { if(error instanceof AppError && error.code==='invalid_wiki_answer') continue; throw error; }
    selected.push(document);
  }
  return selected;
}
export function confirmedAnswer(item:Consultation,answerTs:string,next?:string):AnswerRecord {
  if(answerTs.length>128 || !/^[0-9]+(?:\.[0-9]+)?$/.test(answerTs) || !Number.isFinite(Number(answerTs)) || !Number.isFinite(new Date(Number(answerTs)*1000).getTime())) throw new AppError('invalid_wiki_answer');
  const pk=answerKey(item.pk),answer=string(item.answer),sentAt=new Date(Number(answerTs)*1000).toISOString();
  const question=typeof item.question==='string' && item.question.trim() ? item.question:'';
  const dependencies=answerDependencies(item.knowledgeReferences ?? []);
  const record:AnswerRecord={pk,id:pk,environmentId:string(item.environmentId),appId:string(item.appId),teamId:item.teamId,version:1,hash:hashText(JSON.stringify([question,answer])),channelIds:[item.sourceChannel],reviewChannelIds:[item.reviewChannel],sentAt,dependencies,requestId:item.pk,question,questionState:question ? 'captured':'unavailable',...(item.questionCapture ? {questionCapture:item.questionCapture}:{}),...(item.requesterId ? {requesterId:item.requesterId}:{}),draft:item.draft ?? '',answer,actorId:string(item.actorId),answerTs,sourceChannel:item.sourceChannel,sourceTs:item.sourceTs,mentionTs:item.mentionTs,reviewChannel:item.reviewChannel,reviewTs:string(item.reviewTs),references:item.knowledgeReferences ?? [],pendingKey:`wiki-pending#${hashText(pk)}`,...(next ? {next}: {}),work:{status:question ? 'pending':'failed',attempts:0,...(!question ? {failureCode:'question_unavailable'} : {})}};
  // 履歴リンク、Slack日時、再試行/checkpoint状態の拡張枠を投稿前から確保する。
  const largest={...record,answerTs:'0'.repeat(128),sentAt:'0'.repeat(27),next:`wiki-answer#${'f'.repeat(64)}`};
  if(Buffer.byteLength(JSON.stringify(largest))+wikiLimits.answerReserveBytes>wikiLimits.answerBytes) throw new AppError('invalid_wiki_answer');
  return record;
}
export function validateAnswerStorage(item:Consultation,answer:string,actorId:string):void {
  confirmedAnswer({...item,answer,actorId},'9999999999.999999',`wiki-answer#${'f'.repeat(64)}`);
}
