import { answerProposalHash } from './wiki-answer-proposal.js';
import { wikiContentHash } from './wiki-content.js';
import { requireProposalDelivery } from './wiki-model.js';
import { randomUUID } from 'node:crypto';
import type { WebClient } from '@slack/web-api';
import { AppError, string } from './contracts.js';
import { requireAdmin, requireIdentity, type GroupConfig, type GroupIdentity, type KnowledgeCatalog } from './groups.js';
import { requireSettingsExpiry, type Storage } from './storage.js';
import { fetchPublicSource, publicSourceUrl } from './public-source.js';
import { organizeWiki, proposeWikiUpdate } from './llm.js';
import { hashText, scopeKey, scopeConfigured, sourceKey, wikiLimits, availablePages, validateWikiProposal, type AnswerRecord, type Evidence, type SourceRecord, type WikiRoot, type UrlSource, type WorkState, type WikiPage, type WikiProposal, type WikiCheckpoint, type Scope, manualSource, requireManualSource, answerRetained, answerCitation, currentCitation, comparisonCitation, citationScope, wikiContentVersion } from './wiki-model.js';

import { prepareWikiComparison, comparisonTargets, comparisonBoundary, comparisonVerified, assessWikiProposal } from './wiki-comparison.js';
import { requireWikiViewer, visibleScopes, viewerKey, WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import { answerQuestion, fetchOriginalQuestion } from './answer-question.js';
import { answerSummary } from './wiki-model.js';
import { ChannelAudience } from './channel-audience.js';
export interface WikiCommand { requestId:string; actorId:string; configVersion:number; wikiVersion:number; operation:'put'|'delete'|'sync'|'retry'|'retention'; source?:UrlSource; id?:string; normalDays?:number; retentionDays?:number; }
export interface WikiReceipt extends GroupIdentity { pk:string; command:WikiCommand; work:WorkState; tasks?:string[]; commandExpiresAt:number; expiresAt:number; }
function withoutCheckpoint(work:WorkState):WorkState {
  const fresh={...work};
  delete fresh.humanDecision;delete fresh.refreshBoundary;delete fresh.proposal;delete fresh.proposalKey;delete fresh.proposalBoundary;delete fresh.organized;delete fresh.reviewReason;
  return fresh;
}
function synchronizedWork(previous:WorkState|undefined,root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig,scope:Scope):WorkState {
  const checkpoint=previous && previous.proposalBoundary===comparisonBoundary(root,catalog,config,scopeKey(scope));
  return {status:'pending',attempts:0,
    ...((checkpoint || previous?.humanDecision?.operation==='confirm' && previous.organized?.readyBoundary===comparisonBoundary(root,catalog,config,scopeKey(scope))) && previous?.humanDecision ? {humanDecision:previous.humanDecision}:{}),
    ...(previous?.organized ? {organized:previous.organized}: {}),
    ...(previous?.reviewReason ? {reviewReason:previous.reviewReason}: {}),
    ...(checkpoint && previous?.proposal ? {proposal:previous.proposal}: {}),
    ...(checkpoint && previous?.proposalKey ? {proposalKey:previous.proposalKey}: {}),
    ...(checkpoint ? {proposalBoundary:previous.proposalBoundary}: {})};
}
export async function applyWikiCommand(store:Storage,client:WebClient,config:GroupConfig,receipt:WikiReceipt):Promise<string[]> {
  requireIdentity(receipt,config);
  const command=receipt.command;
  requireSettingsExpiry(receipt.commandExpiresAt);
  requireAdmin(config,command.actorId);
  if(config.version!==command.configVersion) throw new AppError('wiki_conflict');
  const root=await store.wiki.root(config);
  if(root.version!==command.wikiVersion) throw new AppError('wiki_conflict');
  const keys:string[]=[];
  const next:WikiRoot={...root,version:root.version+1};
  const writes:{item:AnswerRecord|Record<string,unknown>;work:WorkState}[]=[];
  let failureCode:string|undefined;
  let protection:{catalogVersion:number}|undefined;
  if(command.operation==='put') {
    const raw=command.source;
    if(!raw || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(raw.id) || !raw.title.trim() || raw.title.length>120) throw new AppError('invalid_wiki_source');
    const previous=root.sources.find(source=>source.id===raw.id);
    if(previous) await requireWikiViewer(client,config,command.actorId,previous);
    await requireWikiViewer(client,config,command.actorId,raw);
    if(raw.channelIds.some(channel=>!config.intakeChannelIds.includes(channel)) || raw.reviewChannelIds.some(channel=>channel!==config.reviewChannelId) || new Set(raw.channelIds).size!==raw.channelIds.length || new Set(raw.reviewChannelIds).size!==raw.reviewChannelIds.length) throw new AppError('forbidden');
    if(previous?.work.status==='processing' && (previous.work.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
    const url=publicSourceUrl(raw.url).href;
    const unchanged=previous && previous.url===url && scopeKey(previous)===scopeKey(raw);
    const source:UrlSource={...previous,id:raw.id,title:raw.title,url,channelIds:[...raw.channelIds],reviewChannelIds:[...raw.reviewChannelIds],revision:previous && previous.url===url ? previous.revision:hashText(command.requestId).slice(0,24),version:previous && previous.url===url ? previous.version:0,work:unchanged ? previous.work:{status:'pending',attempts:0}};
    if(previous && previous.url!==url) {delete source.hash;delete source.fetchedAt;delete source.contentType;}
    next.sources=[...root.sources.filter(source=>source.id!==raw.id),source];
    if(!unchanged) keys.push(`url:${source.id}:${source.revision}`);
  } else if(command.operation==='delete') {
    const source=root.sources.find(source=>source.id===command.id);
    if(!source) throw new AppError('invalid_wiki_source');
    if(scopeConfigured(source,config)) await requireWikiViewer(client,config,command.actorId,source);
    next.sources=root.sources.filter(source=>source.id!==command.id);
  } else if(command.operation==='sync') {
    const access=new WikiAccess(client,config,command.actorId);
    const catalog=await store.knowledge(config);
    protection={catalogVersion:catalog.version};
    if(root.retentionDays!==undefined && root.historyHead) keys.push(`retention:${root.historyHead}`);
    const {visible,incomplete:sourceIncomplete}=await visibleScopes(client,config,command.actorId,root.sources,access);
    if(sourceIncomplete) throw new AppError('wiki_membership_incomplete');
    next.sources=root.sources.map(source=>{
      if(!visible.has(viewerKey(source))) return source;
      keys.push(`url:${source.id}:${source.revision}`);
      if(source.work.status==='processing' && (source.work.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
      const boundary=source.work.proposalBoundary ?? (source.work.organized?.status==='ready' ? source.work.organized.readyBoundary:source.work.organized?.comparisonBoundary);
      return {...source,work:{...synchronizedWork(source.work,root,catalog,config,source),...(source.work.proposal ? {proposal:source.work.proposal,...(source.work.proposalBoundary ? {proposalBoundary:source.work.proposalBoundary}:{})}:{}),refreshSource:true,...(boundary ? {refreshBoundary:boundary}:{})}};
    });
    const {visible:manualVisible,incomplete:manualIncomplete}=await visibleScopes(client,config,command.actorId,catalog.documents,access);
    if(manualIncomplete) throw new AppError('wiki_membership_incomplete');
    next.manualJobs=catalog.documents.map(document=>{
      const prior=root.manualJobs?.find(job=>job.id===document.id && job.version===document.version && job.hash===hashText(document.body));
      if(!manualVisible.has(viewerKey(document))) return prior ?? {id:document.id,version:document.version,hash:hashText(document.body),work:{status:'pending' as const,attempts:0}};
      keys.push(`manual:${document.id}:${document.version}`);
      if(prior?.work.status==='processing' && (prior.work.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
      return {id:document.id,version:document.version,hash:hashText(document.body),work:synchronizedWork(prior?.work,root,catalog,config,document)};
    });
    store.wiki.requirePendingIndex(root);
    if(root.pendingHead) keys.push(`pending:${root.pendingHead}`);
  } else if(command.operation==='retry') {
    const answer=await store.wiki.get<AnswerRecord>(string(command.id));
    if(!answer || answer.purged) throw new AppError('missing_wiki_answer');
    requireIdentity(answer,config);
    requireProposalDelivery(answer.work.delivery);
    if(answer.work.humanDecision) throw new AppError('wiki_conflict');
    const history=new WikiHistoryAccess(store,config,root,await store.knowledge(config),new WikiAccess(client,config,command.actorId));
    await history.answer(answerCitation(answer));
    if(answer.work.status==='processing' && (answer.work.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
    if(answer.work.delivery?.status==='posting') {
      if(answer.work.status!=='review' || !answer.work.proposalKey) throw new AppError('wiki_proposal_delivery_unknown');
      keys.push(answer.pk);
      // 配送結果が確定するまで、再処理も保存済み案の照合だけをキューへ戻す。
      writes.push({item:answer,work:answer.work});
    } else {
      let updated=answer;
      if(!answerQuestion(answer)) {
        const question=await fetchOriginalQuestion(client,answer);
        if(question) updated={...answer,recoveredQuestion:question,questionRecoveryHash:question.hash};
        else failureCode='question_unavailable';
      }
      writes.push({item:{...updated,pendingKey:`wiki-pending#${hashText(answer.pk)}`,work:failureCode ? {status:'failed',attempts:answer.work.attempts,failureCode}:{status:'pending',attempts:0}},work:answer.work});
      next.answers=[answerSummary(updated),...next.answers.filter(item=>item.id!==answer.id)].slice(0,wikiLimits.activeAnswers);
      if(!failureCode) keys.push(answer.pk);
    }
  } else if(command.operation==='retention') {
    next.normalDays=command.normalDays!;
    if(command.retentionDays===undefined) delete next.retentionDays; else next.retentionDays=command.retentionDays;
    if(next.retentionDays!==undefined && root.historyHead) keys.push(`retention:${root.historyHead}`);
  } else throw new AppError('invalid_input');
  requireSettingsExpiry(receipt.commandExpiresAt);
  writes.push({item:{...receipt,work:{status:failureCode ? 'failed':'ready',attempts:0,...(failureCode ? {failureCode}: {})},tasks:keys},work:receipt.work});
  await store.wiki.save(config,root,next,writes,protection);
  return keys;
}
export async function processWiki(store:Storage,config:GroupConfig,key:string,client?:WebClient):Promise<void> {
  let root=await store.wiki.root(config);
  const source=root.sources.find(source=>`url:${source.id}:${source.revision}`===key);
  const manualCatalog=key.startsWith('manual:') ? await store.knowledge(config) : undefined;
  const manual=manualCatalog?.documents.find(document=>`manual:${document.id}:${document.version}`===key);
  if(key.startsWith('manual:') && !manual) return;
  let answer:AnswerRecord|undefined;
  if(!source && !manual) {
    if(!/^wiki-answer#[a-f0-9]{64}$/.test(key)) return;
    answer=await store.wiki.get<AnswerRecord>(key);
    if(!answer || answer.purged) return;
    requireIdentity(answer,config);
  }
  const scope:Scope=source ?? manual ?? answer!;
  const scopeChanged=scope.channelIds.some(channel=>!config.intakeChannelIds.includes(channel)) || scope.reviewChannelIds.some(channel=>channel!==config.reviewChannelId);
  const manualJob=manual ? root.manualJobs?.find(item=>item.id===manual.id && item.version===manual.version && item.hash===hashText(manual.body)) : undefined;
  const previous=source?.work ?? manualJob?.work ?? (manual ? {status:'pending' as const,attempts:0} : answer!.work);
  if(previous.status==='ready' || previous.status==='review' || previous.status==='failed') return;
  if(answer && (!answerRetained(answer,root,Date.now()) || scopeChanged || !answerQuestion(answer))) {
    const failed:WorkState={...previous,status:'failed',failureCode:scopeChanged ? 'wiki_access_changed':!answerRetained(answer,root,Date.now()) ? 'wiki_retention_expired':'question_unavailable'};
    await store.wiki.save(config,root,{...root,version:root.version+1},[{item:{...answer,work:failed},work:previous}],{catalogVersion:(await store.knowledge(config)).version,workOnly:true});
    return;
  }
  if(scopeChanged) throw new AppError('wiki_access_changed');
  if(previous.status==='processing' && (previous.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
  if(previous.attempts>=wikiLimits.attempts) {
    const failed={...previous,status:'failed' as const,failureCode:'wiki_attempts_exhausted'};
    const manualJobs=manual ? [...(root.manualJobs ?? []).filter(item=>item.id!==manual.id),{id:manual.id,version:manual.version,hash:hashText(manual.body),work:failed}] : root.manualJobs;
    await store.wiki.save(config,root,{...root,version:root.version+1,...(manualJobs ? {manualJobs}: {}),sources:source ? root.sources.map(item=>item.revision===source.revision ? {...item,work:failed}:item):root.sources},answer ? [{item:{...answer,work:failed},work:previous}] : []);
    return;
  }
  const owner=randomUUID();
  let work:WorkState={...previous,status:'processing',attempts:previous.attempts+1,owner,until:Date.now()+150000};
  const saveWork=async(nextWork:WorkState,protection?:{catalogVersion:number;workOnly?:boolean},pages?:WikiPage[],raw?:SourceRecord,checkpoint?:Record<string,unknown>|SourceRecord,checkpointSnapshot?:WikiCheckpoint)=>{
    const latest=await store.wiki.root(config);
    if(root.version!==latest.version) {
      if(nextWork.status==='ready' || nextWork.status==='review') throw new AppError('wiki_conflict');
      const active=source ? latest.sources.find(item=>item.revision===source.revision)?.work : manual ? latest.manualJobs?.find(item=>item.id===manual.id)?.work : (await store.wiki.get<AnswerRecord>(key))?.work;
      if(active?.owner!==owner) throw new AppError('wiki_conflict');
      root=latest;
      if(answer) {
        const saved=await store.wiki.get<AnswerRecord>(key);
        if(!saved || saved.purged || saved.work.owner!==owner) throw new AppError('wiki_conflict');
        requireIdentity(saved,config);answer=saved;
      }
    }
    const manualJobs=manual ? [...(root.manualJobs ?? []).filter(item=>item.id!==manual.id && manualCatalog!.documents.some(document=>document.id===item.id)),{id:manual.id,version:manual.version,hash:hashText(manual.body),work:nextWork}] : root.manualJobs;
    const newProposal=checkpoint && String(checkpoint.pk).startsWith('wiki-proposal#') && !checkpointSnapshot;
    const savedCheckpoint=newProposal ? {...checkpoint,...('pages' in checkpoint && Array.isArray(checkpoint.pages) ? {pagesHash:wikiContentHash(checkpoint.pages)}:{}),...(root.proposalHead ? {previousProposalKey:root.proposalHead}:{})}:checkpoint;
    const next={...root,version:root.version+1,...(manualJobs ? {manualJobs}: {}),sources:source ? root.sources.map(item=>item.revision===source.revision ? {...item,work:nextWork,...(['ready','review'].includes(nextWork.status) ? {fetchedAt:new Date().toISOString()}: {}),...(raw ? {version:raw.version,hash:raw.hash,fetchedAt:raw.fetchedAt,contentType:raw.contentType}: {})}:item):root.sources,...(pages ? {pages}: {}),...(newProposal ? {proposalHead:String(checkpoint.pk)}:{})};
    await store.wiki.save(config,root,next,[...(answer ? [{item:{...answer,work:nextWork},work:answer.work}] : []),...(raw ? [{item:raw}] : []),...(savedCheckpoint ? [{item:savedCheckpoint,...(checkpointSnapshot ? {checkpoint:checkpointSnapshot}:{})}] : [])],protection);
    root=next;if(answer) answer={...answer,work:nextWork};
    return savedCheckpoint;
  };
  await saveWork(work,{catalogVersion:(await store.knowledge(config)).version,workOnly:!manual || !!manualJob});
  const catalog=await store.knowledge(config),protection={catalogVersion:catalog.version};
  const inlineCheckpoint=():Record<string,unknown>|undefined=>work.proposal ? {pk:`wiki-proposal#${owner}-previous`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,pages:work.proposal,...(work.proposalBoundary ? {proposalBoundary:work.proposalBoundary}:{})}:undefined;
  try {
    const refreshSource=work.refreshSource===true;
    let incoming:Evidence;
    if(source) {
      const current=root.sources.find(item=>item.revision===source.revision)!;
      if(!work.refreshSource && (work.proposal || work.proposalKey) && current.hash) {
        incoming=(await store.wiki.get<SourceRecord>(sourceKey(current)))!;
      } else {
        const fetched=await fetchPublicSource(source.url),hash=hashText(fetched.raw);
        const existingRaw=current.hash===hash ? await store.wiki.get<SourceRecord>(sourceKey(current)) : undefined;
        if(existingRaw && (existingRaw.pk!==sourceKey(current) || existingRaw.id!==key || existingRaw.version!==current.version || existingRaw.hash!==hash || hashText(existingRaw.raw)!==hash)) throw new AppError('missing_wiki_source');
        if(existingRaw && scopeKey(existingRaw)===scopeKey(source) && existingRaw.url===fetched.url && existingRaw.text===fetched.text && existingRaw.contentType===fetched.contentType) incoming=existingRaw;
        else {
          const archived=inlineCheckpoint();
          work=withoutCheckpoint(work);
          const original:SourceRecord & import('./groups.js').GroupIdentity={pk:sourceKey({...source,version:current.version+1}),environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,id:key,title:source.title,text:fetched.text,raw:fetched.raw,version:current.version+1,hash,fetchedAt:new Date().toISOString(),url:fetched.url,contentType:fetched.contentType,kind:'document',channelIds:source.channelIds,reviewChannelIds:source.reviewChannelIds};
          await saveWork(work,protection,undefined,original,archived);incoming=original;
        }
      }
      if(!incoming) throw new AppError('missing_wiki_source');
    } else if(manual) {
      const pk=`wiki-manual#${manual.id}#${manual.version}`;
      const original=await store.wiki.get<SourceRecord>(pk);
      incoming={...manual,id:`manual:${manual.id}`,hash:hashText(manual.body),text:manual.body,kind:'document'};
      if(original) requireManualSource(original,manual,config);
      else await saveWork(work,protection,undefined,manualSource(manual,config));
    }
    else {
      if(!currentCitation(answerCitation(answer!),root,catalog,Date.now())) throw new AppError('wiki_evidence_changed');
      incoming={...answerCitation(answer!),title:'確定回答',text:JSON.stringify({question:answerQuestion(answer!).slice(0,6000),answer:answer!.answer}),kind:'answer',channelIds:answer!.channelIds,reviewChannelIds:answer!.reviewChannelIds};
    }
    const currentRoot=await store.wiki.root(config);
    const currentCatalog=await store.knowledge(config),scope=scopeKey(incoming);
    const currentWork=source ? currentRoot.sources.find(item=>item.revision===source.revision)?.work : manual ? currentRoot.manualJobs?.find(item=>item.id===manual.id)?.work : (await store.wiki.get<AnswerRecord>(key))?.work;
    if(currentWork?.owner!==owner) throw new AppError('wiki_conflict');
    const currentScope=citationScope(incoming,currentRoot,currentCatalog);
    if(!comparisonCitation(incoming,currentRoot,currentCatalog,Date.now()) || !currentScope || scopeKey(currentScope)!==scope) throw new AppError('wiki_evidence_changed');
    root=currentRoot;
    if(source && work.refreshSource && work.refreshBoundary && work.refreshBoundary!==comparisonBoundary(root,currentCatalog,config,scope)) {
      const archived=inlineCheckpoint();
      work=withoutCheckpoint(work);
      const original:SourceRecord & GroupIdentity={...incoming as SourceRecord,pk:sourceKey({...source,version:incoming.version+1}),environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,version:incoming.version+1,fetchedAt:new Date().toISOString()};
      await saveWork(work,{catalogVersion:currentCatalog.version},undefined,original,archived);
      incoming=original;
    }
    if(source && work.refreshSource) {
      const boundary=comparisonBoundary(root,currentCatalog,config,scope);
      const obsolete=(work.proposal || work.proposalKey) && work.proposalBoundary!==boundary || work.organized?.status==='ready' && work.organized.readyBoundary!==boundary;
      const archived=obsolete ? inlineCheckpoint():undefined;
      if(obsolete) work=withoutCheckpoint(work);
      work={...work};delete work.refreshSource;delete work.refreshBoundary;
      await saveWork(work,{catalogVersion:currentCatalog.version,workOnly:true},undefined,undefined,archived);
    }
    if(work.humanDecision?.operation==='reject' && work.humanDecision.boundary===comparisonBoundary(root,currentCatalog,config,scope)) {await saveWork({...work,status:'review'},{catalogVersion:currentCatalog.version,workOnly:true});return;}
    const organized=work.organized;
    if((source || manual) && !work.proposal && (!work.proposalKey || organized?.status==='review' && work.proposalKey===organized.proposalKey) && organized && organized.version===incoming.version && organized.hash===incoming.hash && organized.scope===scope && (organized.status==='ready' && (!refreshSource || organized.readyBoundary===comparisonBoundary(root,currentCatalog,config,scope)) || organized.status==='review' && organized.comparisonBoundary===comparisonBoundary(root,currentCatalog,config,scope))) {
      await saveWork({status:organized.status,attempts:work.attempts,organized,...(work.humanDecision ? {humanDecision:work.humanDecision}:{}),...(organized.status==='review' && organized.proposalKey ? {proposalKey:organized.proposalKey,...(organized.comparisonBoundary ? {proposalBoundary:organized.comparisonBoundary}:{})}: {}),...(previous.reviewReason ? {reviewReason:previous.reviewReason}: {})},{catalogVersion:currentCatalog.version,workOnly:organized.status!=='ready'});return;
    }
    const verifiedPages=answer ? root.pages.filter(page=>page.scope===scope && comparisonTargets([], [page]).length>0):undefined;
    const requireAnswerComparison=async(checkedRoot:WikiRoot,checkedCatalog:KnowledgeCatalog,items:Evidence[],pages:WikiPage[])=>{
      if(!client || !answer) throw new AppError('invalid_input');
      for(const access of [new WikiAccess(client,config,answer.actorId),new ChannelAudience(client,config,[string(config.reviewChannelId)])]) {
        const history=new WikiHistoryAccess(store,config,checkedRoot,checkedCatalog,access);
        for(const item of items) await history.comparison(item);
        for(const page of pages) await history.pageComparison(page);
      }
    };
    if(answer) await requireAnswerComparison(root,currentCatalog,[incoming],verifiedPages!);
    const comparison=await prepareWikiComparison(store,config,root,currentCatalog,incoming,verifiedPages);
    const {evidence,existing}=comparison;
    for(const item of evidence.filter(item=>item.id.startsWith('manual:'))) {
      const document=currentCatalog.documents.find(document=>`manual:${document.id}`===item.id)!;
      const original=manualSource(document,config),saved=await store.wiki.get<SourceRecord>(original.pk);
      if(saved) requireManualSource(saved,document,config);
      else await saveWork(work,{catalogVersion:currentCatalog.version,workOnly:true},undefined,undefined,original);
    }
    if(answer) {
      if(!comparison.complete) throw new AppError('wiki_prompt_too_large');
      await requireAnswerComparison(root,currentCatalog,evidence,existing);
      const inputRootVersion=root.version;
      const secrets=await store.readSecrets();
      const aiRoot=await store.wiki.root(config),aiCatalog=await store.knowledge(config),aiConfig=await store.group(config);
      await requireAnswerComparison(aiRoot,aiCatalog,evidence,existing);
      if(aiConfig.version!==config.version || aiConfig.lifecycle || aiRoot.version!==inputRootVersion || aiCatalog.version!==currentCatalog.version) throw new AppError('wiki_conflict');
      const targets=await proposeWikiUpdate(secrets.apiKey,secrets.model,evidence,existing,scope,incoming.id,{question:answerQuestion(answer).slice(0,6000),draft:answer.draft,answer:answer.answer});
      const checkedRoot=await store.wiki.root(config),checkedCatalog=await store.knowledge(config),checkedConfig=await store.group(config);
      await requireAnswerComparison(checkedRoot,checkedCatalog,evidence,existing);
      if(checkedConfig.version!==config.version || checkedConfig.lifecycle || checkedRoot.version!==inputRootVersion || checkedCatalog.version!==currentCatalog.version) throw new AppError('wiki_conflict');
      if(!targets.length) {await saveWork({status:'ready',attempts:work.attempts},{catalogVersion:currentCatalog.version,workOnly:true});return;}
      const proposalKey=`wiki-proposal#${owner}`;
      const checkpoint:WikiCheckpoint={pk:proposalKey,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,inputId:incoming.id,pages:[],targets,approval:{schema:2,configVersion:config.version,baseVersion:wikiContentVersion(root),boundary:comparison.boundary,comparisonPages:existing,comparisonCitations:evidence.map(({id,version,hash,answerProof})=>({id,version,hash,...(answerProof ? {answerProof}:{})}))}};
      await saveWork({status:'review',attempts:work.attempts,proposalKey,proposalHash:answerProposalHash(checkpoint),proposalBoundary:comparison.boundary},{catalogVersion:currentCatalog.version,workOnly:true},undefined,undefined,{...checkpoint});
      return;
    }
    const targets=comparisonTargets(evidence,existing).map(item=>item.target);
    const loadedCheckpoint=work.proposalKey ? await store.wiki.get<WikiCheckpoint>(work.proposalKey):undefined;
    const cached=loadedCheckpoint;
    if(work.proposalKey && !loadedCheckpoint) throw new AppError('missing_wiki_proposal');
    if(cached) {requireIdentity(cached,config);if(cached.pagesHash!==undefined && cached.pagesHash!==wikiContentHash(cached.pages)) throw new AppError('wiki_evidence_changed');}
    let update:WikiProposal;
    const proposalBoundary=work.proposal || cached ? work.proposalBoundary:comparison.boundary;
    if(work.proposal || cached) update=validateWikiProposal(cached ?? {pages:work.proposal},evidence,scope,existing.map(page=>page.id));
    else {
      const secrets=await store.readSecrets();
      update=await organizeWiki(secrets.apiKey,secrets.model,evidence,existing,scope,incoming.id);
    }
    const proposalKey=cached ? cached.pk:work.proposalKey ?? `wiki-proposal#${owner}`;
    const checkpointWork={...work};
    delete checkpointWork.proposal;
    const initialCheckpoint:WikiCheckpoint=cached ?? {pk:proposalKey,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,inputId:incoming.id,...update};
    const publicationCatalog=await store.knowledge(config),publicationProtection={catalogVersion:publicationCatalog.version};
    const savedCheckpoint=await saveWork({...checkpointWork,proposalKey,...(proposalBoundary ? {proposalBoundary}: {})},{...publicationProtection,workOnly:true},undefined,undefined,{...initialCheckpoint},cached);
    const checkpoint=cached ?? savedCheckpoint as unknown as WikiCheckpoint;
    const latest=await store.wiki.root(config);
    const active=source ? latest.sources.find(item=>item.revision===source.revision)?.work : manual ? latest.manualJobs?.find(item=>item.id===manual.id)?.work : (await store.wiki.get<AnswerRecord>(key))?.work;
    const latestScope=citationScope(incoming,latest,publicationCatalog);
    if(active?.owner!==owner || !comparisonCitation(incoming,latest,publicationCatalog,Date.now()) || !latestScope || scopeKey(latestScope)!==scope || !update.pages.every(page=>page.citations.every(citation=>{
      const currentScope=citationScope(citation,latest,publicationCatalog);
      return comparisonCitation(citation,latest,publicationCatalog,Date.now()) && currentScope && scopeKey(currentScope)===page.scope;
    }))) throw new AppError('wiki_evidence_changed');
    root=latest;
    const valid=availablePages(root,publicationCatalog,config,Date.now());
    const complete=comparison.complete && proposalBoundary===comparison.boundary && comparison.boundary===comparisonBoundary(root,publicationCatalog,config,scope);
    const verified=comparisonVerified(update.comparisons,targets);
    let proposal=assessWikiProposal(update.pages,targets,complete,incoming,valid);
    proposal=proposal.map(page=>page.citations.some(citation=>citation.id.startsWith('wiki-answer#')) && !page.human ? {...page,status:'review',reviewReason:'formal_replacement'}:page);
    if(!verified) proposal=proposal.map(page=>({...page,status:'review',reviewReason:page.reviewReason ?? 'comparison_unverified'}));
    // 未確認提案は正式ページを保持したまま別ページにする。
    const renamed=new Map(proposal.filter(page=>page.status==='review' && valid.some(old=>old.scope===scope && old.id===page.id && old.status==='ready')).map(page=>[page.id,'review-'+hashText(page.id+JSON.stringify(page.citations)).slice(0,32)]));
    proposal=proposal.map(page=>({...page,id:renamed.get(page.id) ?? page.id,relatedIds:page.relatedIds.map(id=>renamed.get(id) ?? id)}));
    const retained=valid.filter(page=>!proposal.some(item=>item.scope===page.scope && item.id===page.id));
    const status=!complete || !verified || proposal.some(page=>page.status==='review') ? 'review':'ready';
    const reviewReason=!complete ? 'comparison_incomplete' : !verified ? 'comparison_unverified' : proposal.find(page=>page.reviewReason)?.reviewReason;
    const proposedPages=[...retained,...proposal];
    const deferred=proposedPages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(proposedPages))>wikiLimits.wikiBytes;
    if(deferred && status!=='review') throw new AppError('wiki_capacity');
    // 要確認案の保存枠がなくても正式ページを削って公開せず、checkpointへ保持する。
    const pages=deferred ? valid:proposedPages;
    const old={pk:`wiki-version#${root.version}`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,version:root.version,contentVersion:wikiContentVersion(root),pages:root.pages,createdAt:new Date().toISOString(),...(root.previousVersion ? {previousVersion:root.previousVersion}: {})};
    const clean:WorkState={status,attempts:work.attempts,...(reviewReason ? {reviewReason}: {}),...(status==='review' ? {proposalKey,...(proposalBoundary ? {proposalBoundary}: {})}: {}),organized:{version:incoming.version,hash:incoming.hash,scope,status,proposalKey,...(proposalBoundary ? {comparisonBoundary:proposalBoundary}: {})}};
    const manualJobs=manual ? [...(root.manualJobs ?? []).filter(item=>item.id!==manual.id),{id:manual.id,version:manual.version,hash:hashText(manual.body),work:clean}] : root.manualJobs;
    const next={...root,version:root.version+1,previousVersion:root.version,pages,...(manualJobs ? {manualJobs}: {}),sources:source ? root.sources.map(item=>item.revision===source.revision ? {...item,work:clean}:item):root.sources};
    if(source && status==='ready') clean.organized!.readyBoundary=comparisonBoundary(next,publicationCatalog,config,scope);
    const completed={pk:proposalKey,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,status:'completed',...(checkpoint.previousProposalKey ? {previousProposalKey:checkpoint.previousProposalKey}:{})};
    await store.wiki.save(config,root,next,[{item:old},...(status==='ready' ? [{item:completed,checkpoint}]:[])],publicationProtection);
  } catch(error) {
    const latest=await store.wiki.root(config);
    const current=source ? latest.sources.find(item=>item.revision===source.revision)?.work : manual ? latest.manualJobs?.find(item=>item.id===manual.id)?.work : (await store.wiki.get<AnswerRecord>(key))?.work;
    if(current?.owner===owner) {
      root=latest;
      const failed:WorkState={status:current.attempts>=wikiLimits.attempts ? 'failed':'pending',attempts:current.attempts,...(current.refreshSource ? {refreshSource:true}: {}),...(current.refreshBoundary ? {refreshBoundary:current.refreshBoundary}: {}),...(current.proposal ? {proposal:current.proposal}: {}),...(current.proposalKey ? {proposalKey:current.proposalKey}: {}),...(current.proposalBoundary ? {proposalBoundary:current.proposalBoundary}: {}),...(current.organized ? {organized:current.organized}: {}),failureCode:error instanceof AppError ? error.code:'wiki_processing_failed'};
      if(answer) answer=(await store.wiki.get<AnswerRecord>(key))!;
      await saveWork(failed,{catalogVersion:(await store.knowledge(config)).version,workOnly:true});
      if(failed.status==='failed') return;
    }
    throw error;
  }
}
