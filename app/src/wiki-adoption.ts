import { WikiUpdateError, isWikiUpdateFailureReason, wikiUpdateFailureText, type WikiUpdateFailureReason } from './wiki-update-failure.js';
import { randomUUID } from 'node:crypto';
import { requireAdoptionOrigin, type WikiAdoptionOrigin } from './wiki-adoption-origin.js';
import type { WebClient, KnownBlock } from '@slack/web-api';
import { AppError, env, object, string } from './contracts.js';
import { requireAdmin, requireIdentity, requireRunningGroup, type GroupConfig, type KnowledgeCatalog } from './groups.js';
import type { Storage } from './storage.js';
import { WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import { ChannelAudience } from './channel-audience.js';
import { adoptionPath, answerProposalHash, proposalPagePath, requireAnswerProposal, requireProposalIntake } from './wiki-answer-proposal.js';
import { comparisonTargets, prepareWikiComparison } from './wiki-comparison.js';
import { generateAdoptedUpdate } from './llm.js';
import { applyUpdateOperations, requireUpdateTargetIdentity, requireUpdateTargets, updatePageCitations, wikiSection } from './wiki-update-plan.js';
import { wikiContentHash } from './wiki-content.js';
import { promptCitation } from './wiki-provenance.js';
import { answerCitation, manualSource, requireProposalDelivery, scopeKey, wikiContentVersion, wikiLimits, type WikiCheckpoint, type WorkState, type Evidence, type AnswerRecord, type SourceRecord, type WikiPage, type WikiRoot } from './wiki-model.js';

export interface WikiAdoption extends WikiCheckpoint {
  command:{actorId:string;proposalKey:string;proposalHash:string;operation:'confirm'|'reject';policyHash:string;origin:WikiAdoptionOrigin};
  commandHash:string;
  acceptedAt:string;commandExpiresAt:number;work:WorkState;
  result?:{status:'applied'|'unchanged'|'rejected'|'failed';at:string;wikiVersion:number;changes:{target:number;title:string;before:string;after:string}[];failureCode?:string;failureReason?:WikiUpdateFailureReason};
}

export function requireAdoptionCapacity(receipt:WikiAdoption):number {
  // 失敗結果・公開/lease metadataと既存8192byte reserveを、本文を削らず確保する。
  const largest={...receipt,result:receipt.result ?? {status:'failed',at:'9999-12-31T23:59:59.999Z',wikiVersion:Number.MAX_SAFE_INTEGER,changes:[],failureCode:'wiki_result_capacity_exceeded',failureReason:'generation_request_failed'},work:{...receipt.work,owner:'0'.repeat(36),until:9999999999999,delivery:{status:'posting',hash:'0'.repeat(64),owner:'0'.repeat(36),until:9999999999999,ts:receipt.work.delivery?.ts ?? '9'.repeat(32)}}};
  const available=wikiLimits.itemBytes-Buffer.byteLength(JSON.stringify(largest))-wikiLimits.answerReserveBytes;
  if(available<0) throw new AppError('wiki_result_capacity_exceeded');
  return available;
}
function adoptionResult(receipt:WikiAdoption,root:WikiRoot,answer:AnswerRecord,comparisonPages:WikiPage[],evidence:Evidence[],update:ReturnType<typeof applyUpdateOperations>,at:string) {
  const status:NonNullable<WikiAdoption['result']>['status']=receipt.command.operation==='reject' ? 'rejected':update.changes.length ? 'applied':'unchanged';
  const pages=update.changes.length ? update.pages.map(page=>{
    if(!update.changes.some(change=>receipt.targets![change.target].id===page.id && receipt.targets![change.target].scope===page.scope)) return page;
    const previous=root.pages.find(item=>item.id===page.id && item.scope===page.scope);
    return {...page,status:'ready' as const,human:{actorId:receipt.command.actorId,at,operation:'confirm' as const,baseVersion:wikiContentVersion(root),baseHashes:[wikiContentHash(previous ?? receipt.targets!.find(target=>target.id===page.id))],scope:{channelIds:[...answer.channelIds],reviewChannelIds:[...answer.reviewChannelIds]}}};
  }):root.pages;
  const next:WikiAdoption={...receipt,approval:{...receipt.approval!,comparisonPages,comparisonCitations:receipt.command.operation==='confirm' ? evidence.map(promptCitation):receipt.approval!.comparisonCitations},pages:update.changes.length ? pages.filter(page=>receipt.targets!.some(target=>target.id===page.id && target.scope===page.scope)):[],result:{status,at,wikiVersion:wikiContentVersion(root)+(update.changes.length ? 1:0),changes:update.changes},work:{status:'ready' as const,attempts:receipt.work.attempts}};
  return {next,pages};
}
export function adoptionGrowthBudget(receipt:WikiAdoption,root:WikiRoot,answer:AnswerRecord,comparisonPages:WikiPage[],evidence:Evidence[]):number {
  const changes=receipt.targets!.map((target,index)=>{
    const current=root.pages.find(page=>page.id===target.id && page.scope===target.scope),text=current ? wikiSection(current.body,target.headingPath).text:'';
    return {target:index,title:current?.title ?? target.title,before:text,after:text};
  });
  const pages=[...root.pages,...receipt.targets!.filter(target=>target.isNew).map(target=>({id:target.id,title:target.title,scope:target.scope,body:'',kind:'faq' as const,status:'ready' as const,relatedIds:[],citations:target.citations}))].map(page=>{
    const targets=receipt.targets!.filter(target=>target.id===page.id && target.scope===page.scope);
    return targets.length ? {...page,citations:updatePageCitations(root.pages.find(current=>current.id===page.id && current.scope===page.scope),targets,comparisonPages,evidence)}:page;
  });
  const preview=adoptionResult(receipt,root,answer,comparisonPages,evidence,{pages,changes},new Date().toISOString()).next;
  // 直下本文の増分はresult.afterと保存ページbodyの2箇所へ入る。
  return Math.floor(requireAdoptionCapacity(preview)/2);
}
export async function adoptionContext(store:Storage,client:WebClient,config:GroupConfig,checkpoint:WikiCheckpoint,user:string,hash:string,adoptionKey?:string,completed=false) {
  const root=await store.wiki.root(config),catalog=await store.knowledge(config);
  const history=new WikiHistoryAccess(store,config,root,catalog,new WikiAccess(client,config,user));
  const answer=await requireAnswerProposal(store,config,catalog,root,checkpoint,history,user,hash,adoptionKey,completed);
  const audience=new WikiHistoryAccess(store,config,root,catalog,new ChannelAudience(client,config,[string(config.reviewChannelId)]));
  await requireAnswerProposal(store,config,catalog,root,checkpoint,audience,user,hash,adoptionKey,completed);
  return {root,catalog,answer,history,audience};
}
function sameAdoptionInstruction(first:WikiAdoption['command'],second:WikiAdoption['command']):boolean {
  const {origin:firstOrigin,...firstInstruction}=first,{origin:secondOrigin,...secondInstruction}=second;
  void firstOrigin;void secondOrigin;
  return wikiContentHash(firstInstruction)===wikiContentHash(secondInstruction);
}
export async function acceptWikiAdoption(store:Storage,config:GroupConfig,user:string,key:string,hash:string,operation:'confirm'|'reject',origin:WikiAdoptionOrigin,policies?:string[]):Promise<string> {
  requireRunningGroup(config);requireAdmin(config,user);
  requireAdoptionOrigin(origin);
  if(origin.configVersion!==config.version) throw new AppError('forbidden');
  if(!['confirm','reject'].includes(operation)) throw new AppError('invalid_input');
  const checkpoint=await store.wiki.get<WikiCheckpoint>(key);
  if(!checkpoint || hash!==answerProposalHash(checkpoint)) throw new AppError('wiki_conflict');requireIdentity(checkpoint,config);
  requireUpdateTargets(checkpoint.targets!);
  if(policies && (operation!=='confirm' || policies.length!==checkpoint.targets?.length)) throw new AppError('invalid_input');
  const targets=checkpoint.targets!.map((target,index)=>({...target,...(policies ? {policy:policies[index]}:{})}));
  requireUpdateTargets(targets);
  const pk='wiki-proposal#submission-'+wikiContentHash(key).slice(0,32),policyHash=wikiContentHash(targets);
  const command={actorId:user,proposalKey:key,proposalHash:hash,operation,policyHash,origin};
  const root=await store.wiki.root(config),catalog=await store.knowledge(config);
  const prior=await store.wiki.get<WikiAdoption>(pk);
  if(prior) {
    requireWikiAdoption(prior,config,user);
    if(!sameAdoptionInstruction(prior.command,command)) throw new AppError('forbidden');
    await requireProposalIntake(store,config,root,checkpoint,user,hash,pk,!!prior.result);
    const latest=await store.group(config);
    if(latest.version!==config.version || latest.lifecycle) throw new AppError('wiki_conflict');
    return pk;
  }
  // ACKは採用指示の保存まで。出典・共有先の詳細ACLはworkerのAI入力・確定処理前に検査する。
  const answer=await requireProposalIntake(store,config,root,checkpoint,user,hash);
  const acceptedAt=new Date().toISOString();
  const receipt:WikiAdoption={...checkpoint,pk,targets,command,commandHash:wikiContentHash(command),acceptedAt,commandExpiresAt:Math.floor(Date.parse(acceptedAt)/1000)+86400,work:{status:'pending',attempts:0}};
  requireAdoptionCapacity(receipt);
  const work:WorkState={...answer.work,adoptionKey:pk,humanDecision:{actorId:user,at:acceptedAt,operation,wikiVersion:wikiContentVersion(root),proposalKey:key,boundary:checkpoint.approval!.boundary}};
  try {await store.wiki.save(config,root,{...root,version:root.version+1},[{item:{...receipt}},{item:{...answer,work},work:answer.work}],{catalogVersion:catalog.version,workOnly:true});}
  catch(error) {
    if(!(error instanceof AppError) || error.code!=='wiki_conflict') throw error;
    const concurrent=await store.wiki.get<WikiAdoption>(pk);
    if(!concurrent) throw error;
    requireWikiAdoption(concurrent,config,user);
    if(!sameAdoptionInstruction(concurrent.command,command)) throw error;
    const currentRoot=await store.wiki.root(config);
    await requireProposalIntake(store,config,currentRoot,checkpoint,user,hash,pk,!!concurrent.result);
    const latest=await store.group(config);
    if(latest.version!==config.version || latest.lifecycle) throw new AppError('wiki_conflict');
  }
  return pk;
}
export function requireWikiAdoption(receipt:WikiAdoption,config:GroupConfig,user:string):void {
  requireIdentity(receipt,config);
  if(!receipt.command || receipt.commandHash!==wikiContentHash(receipt.command) || !/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(receipt.command.proposalKey) || receipt.pk!=='wiki-proposal#submission-'+wikiContentHash(receipt.command.proposalKey).slice(0,32)) throw new AppError('forbidden');
  requireAdoptionOrigin(receipt.command.origin);
  if(!/^wiki-proposal#submission-[a-f0-9]{32}$/.test(receipt.pk) || !receipt.command || receipt.command.actorId!==user || !/^[a-f0-9]{64}$/.test(receipt.command.proposalHash) || receipt.command.policyHash!==wikiContentHash(receipt.targets) || !['confirm','reject'].includes(receipt.command.operation) || !Number.isSafeInteger(receipt.commandExpiresAt) || 'expiresAt' in receipt || !Number.isFinite(Date.parse(receipt.acceptedAt)) || !receipt.work || !['pending','processing','ready','failed'].includes(receipt.work.status) || !Number.isInteger(receipt.work.attempts) || receipt.work.attempts<0 || receipt.work.attempts>wikiLimits.attempts) throw new AppError('forbidden');
  const result=receipt.result;
  if(result && (!['applied','unchanged','rejected','failed'].includes(result.status) || !Number.isFinite(Date.parse(result.at)) || !Number.isSafeInteger(result.wikiVersion) || !Array.isArray(result.changes) || result.changes.length>(receipt.targets?.length ?? 0) || result.changes.some(change=>!change || !Number.isInteger(change.target) || change.target<0 || change.target>=(receipt.targets?.length ?? 0) || [change.title,change.before,change.after].some(text=>typeof text!=='string' || Buffer.byteLength(text)>wikiLimits.pageBytes)))) throw new AppError('forbidden');
  if(result?.failureReason!==undefined && (result.status!=='failed' || !isWikiUpdateFailureReason(result.failureReason))) throw new AppError('forbidden');
  requireUpdateTargets(receipt.targets!);requireProposalDelivery(receipt.work.delivery);
}
function currentAdoptionPages(receipt:WikiAdoption,root:WikiRoot):WikiPage[] {
  return receipt.targets!.flatMap((target,index)=>{
    const current=root.pages.find(page=>page.id===target.id && page.scope===target.scope);
    const created=receipt.result?.status==='applied' && receipt.result.changes.some(change=>change.target===index);
    if(target.isNew && !created) {
      if(current) throw new AppError('wiki_target_changed');
      return [];
    }
    if(!current || current.status!=='ready') throw new AppError('wiki_target_changed');
    requireUpdateTargetIdentity(target,current);
    return [current];
  });
}
export async function requireAdoptionResultHistory(receipt:WikiAdoption,root:WikiRoot,histories:WikiHistoryAccess[]):Promise<WikiPage[]> {
  const current=currentAdoptionPages(receipt,root);
  for(const history of histories) {
    for(const citation of receipt.approval!.comparisonCitations) await history.comparison(citation,false);
    for(const page of [...receipt.approval!.comparisonPages,...receipt.pages,...current]) await history.pageComparison(page);
  }
  return current;
}
export async function requireAdoptionResultAccess(store:Storage,client:WebClient,config:GroupConfig,receipt:WikiAdoption):Promise<WikiPage[]> {
  requireWikiAdoption(receipt,config,receipt.command.actorId);requireAdmin(config,receipt.command.actorId);
  const checkpoint=await store.wiki.get<WikiCheckpoint>(receipt.command.proposalKey);
  if(!checkpoint) throw new AppError('wiki_target_changed');
  const context=await adoptionContext(store,client,config,checkpoint,receipt.command.actorId,receipt.command.proposalHash,receipt.pk,!!receipt.result);
  const audience=new WikiHistoryAccess(store,config,context.root,context.catalog,new ChannelAudience(client,config,[string(config.reviewChannelId)]));
  const current=await requireAdoptionResultHistory(receipt,context.root,[context.history,audience]);
  const latest=await store.group(config),root=await store.wiki.root(config),catalog=await store.knowledge(config);
  if(latest.version!==config.version || latest.lifecycle || root.version!==context.root.version || catalog.version!==context.catalog.version) throw new AppError('wiki_conflict');
  return current;
}
async function updateEvidence(store:Storage,receipt:WikiAdoption,answer:AnswerRecord,catalog:KnowledgeCatalog):Promise<Evidence[]> {
  const evidence:Evidence[]=[];
  const citations=receipt.approval!.comparisonCitations;
  if(citations.length>wikiLimits.evidence) throw new AppError('wiki_prompt_too_large');
  for(const citation of citations) {
    if(citation.id.startsWith('wiki-answer#')) {
      const original=citation.id===answer.id ? answer:await store.wiki.get<AnswerRecord>(citation.id);
      if(!original) throw new AppError('missing_wiki_answer');requireIdentity(original,receipt);
      evidence.push({...answerCitation(original),title:'確定回答',text:original.answer,kind:'answer',channelIds:original.channelIds,reviewChannelIds:original.reviewChannelIds});
    } else {
      const match=/^url:([^:]+):([^:]+)$/.exec(citation.id),key=match ? `wiki-source#${match[1]}#${match[2]}#${citation.version}`:`wiki-manual#${citation.id.slice(7)}#${citation.version}`;
      const stored=await store.wiki.get<SourceRecord>(key),document=!match && catalog.documents.find(document=>`manual:${document.id}`===citation.id && document.version===citation.version);
      const original=stored ?? (document ? manualSource(document,receipt):undefined);
      if(!original || original.hash!==citation.hash) throw new AppError('missing_wiki_source');
      evidence.push(original);
    }
  }
  if(Buffer.byteLength(JSON.stringify(evidence))>wikiLimits.evidenceBytes) throw new AppError('wiki_prompt_too_large');
  return evidence;
}
async function latestUpdateComparison(store:Storage,config:GroupConfig,receipt:WikiAdoption,input:Awaited<ReturnType<typeof adoptionContext>>):Promise<{evidence:Evidence[];pages:WikiPage[]}> {
  const scope=scopeKey(input.answer),ids=new Set(comparisonTargets([],input.root.pages.filter(page=>page.scope===scope)).map(target=>target.id));
  const pages=input.root.pages.filter(page=>page.scope===scope && ids.has(page.id));
  for(const access of [input.history,input.audience]) for(const page of pages) await access.pageComparison(page);
  const incoming:Evidence={...answerCitation(input.answer),title:'確定回答',text:input.answer.answer,kind:'answer',channelIds:input.answer.channelIds,reviewChannelIds:input.answer.reviewChannelIds};
  const latest=await prepareWikiComparison(store,config,input.root,input.catalog,incoming,pages);
  if(!latest.complete) throw new AppError('wiki_prompt_too_large');
  const required=await updateEvidence(store,receipt,input.answer,input.catalog);
  const evidence=[...new Map([...required,...latest.evidence].map(item=>[wikiContentHash(promptCitation(item)),item])).values()];
  if(evidence.length>wikiLimits.evidence || Buffer.byteLength(JSON.stringify(evidence))>wikiLimits.evidenceBytes) throw new AppError('wiki_prompt_too_large');
  for(const access of [input.history,input.audience]) for(const item of evidence) await access.comparison(promptCitation(item));
  const configNow=await store.group(config),rootNow=await store.wiki.root(config),catalogNow=await store.knowledge(config);
  if(configNow.version!==config.version || configNow.lifecycle || rootNow.version!==input.root.version || catalogNow.version!==input.catalog.version) throw new AppError('wiki_conflict');
  return {evidence,pages:latest.existing};
}
export async function applyWikiAdoption(store:Storage,client:WebClient,config:GroupConfig,user:string,key:string):Promise<void> {
  if(!/^wiki-proposal#submission-[a-f0-9]{32}$/.test(key)) throw new AppError('forbidden');
  let receipt=await store.wiki.get<WikiAdoption>(key);
  if(!receipt) throw new AppError('forbidden');requireWikiAdoption(receipt,config,user);
  if(receipt.work.status==='ready' || receipt.work.status==='failed') {await publishAdoptionResult(store,client,config,receipt);return;}
  if(receipt.work.status==='processing' && (receipt.work.until ?? 0)>Date.now()) throw new AppError('wiki_processing');
  const owner=randomUUID(),deadline=Date.now()+95000;
  const saveBefore=Math.min(deadline,receipt.commandExpiresAt*1000);
  const requireDeadline=()=>{if(Date.now()>=saveBefore) throw new AppError('settings_request_expired');};
  let cycles=0;
  const save=async(next:WikiAdoption,root:Awaited<ReturnType<Storage['wiki']['root']>>,catalogVersion:number,writes:Parameters<Storage['wiki']['save']>[3]=[],pages=root.pages)=>{
    requireAdoptionCapacity(next);
    if(next.result?.status!=='failed') requireDeadline();
    await store.wiki.save(config,root,{...root,version:root.version+1,pages},[{item:{...next},work:receipt!.work},...writes],{catalogVersion,workOnly:pages===root.pages,publicationIdle:pages!==root.pages,...(next.result?.status!=='failed' ? {saveBefore}:{})});receipt=next;
  };
  try {
    requireAdmin(config,user);
    while(receipt.work.attempts<wikiLimits.attempts && cycles++<wikiLimits.attempts && Date.now()<deadline) {
      try {
        if(receipt.commandExpiresAt<=Math.floor(Date.now()/1000)) throw new AppError('settings_request_expired');
        const checkpoint=await store.wiki.get<WikiCheckpoint>(receipt.command.proposalKey);
        if(!checkpoint) throw new AppError('wiki_target_changed');
        if(wikiContentHash(receipt.targets!.map(target=>({...target,policy:''})))!==wikiContentHash(checkpoint.targets!.map(target=>({...target,policy:''})))) throw new AppError('forbidden');
        const context=await adoptionContext(store,client,config,checkpoint,user,receipt.command.proposalHash,key);
        await save({...receipt,work:{status:'processing',attempts:receipt.work.attempts+1,owner,until:deadline}},context.root,context.catalog.version);
        // lease保存後の最新ページと必要根拠をAI入力へ束縛する。
        const input=await adoptionContext(store,client,config,checkpoint,user,receipt.command.proposalHash,key);
        const selected=input.root.pages.filter(page=>receipt!.targets!.some(target=>target.id===page.id && target.scope===page.scope));
        // 全比較の容量に先立ち、最新対象だけでも結果項目に収まらない採用を止める。
        if(receipt.command.operation==='confirm') adoptionGrowthBudget(receipt,input.root,input.answer,[],[]);
        const comparison=receipt.command.operation==='confirm' ? await latestUpdateComparison(store,config,receipt,input):{evidence:[],pages:[]};
        const {evidence,pages:comparisonPages}=comparison;
        const growthBudget=receipt.command.operation==='confirm' ? adoptionGrowthBudget(receipt,input.root,input.answer,comparisonPages,evidence):0;
        const secrets=receipt.command.operation==='confirm' ? await store.readSecrets():undefined;
        if(secrets) {
          const ai=await adoptionContext(store,client,config,checkpoint,user,receipt.command.proposalHash,key);
          for(const access of [ai.history,ai.audience]) {
            for(const item of evidence) await access.comparison(promptCitation(item));
            for(const page of comparisonPages) await access.pageComparison(page);
          }
          if(ai.root.version!==input.root.version || ai.catalog.version!==input.catalog.version) throw new AppError('wiki_conflict');
        }
        requireDeadline();
        const output=secrets ? await generateAdoptedUpdate(secrets.apiKey,secrets.model,evidence,selected,comparisonPages,receipt.targets!,Math.min(60000,Math.max(1,deadline-Date.now())),growthBudget):undefined;
        requireDeadline();
        const update=secrets ? applyUpdateOperations(output,receipt.targets!,input.root.pages,comparisonPages,evidence):{pages:input.root.pages,changes:[]};
        const validate=async()=>{
          const checked=await adoptionContext(store,client,config,checkpoint,user,receipt!.command.proposalHash,key);
          if(checked.root.version!==input.root.version || checked.catalog.version!==input.catalog.version) throw new AppError('wiki_conflict');
          for(const access of [checked.history,checked.audience]) {
            for(const item of evidence) await access.comparison(promptCitation(item));
            for(const page of comparisonPages) await access.pageComparison(page);
          }
          const current=await store.wiki.get<WikiAdoption>(key);
          if(!current || current.work.owner!==owner) throw new AppError('wiki_processing');
          requireWikiAdoption(current,config,user);
          if(current.commandHash!==receipt!.commandHash) throw new AppError('forbidden');
          requireDeadline();
          return checked;
        };
        let timer:ReturnType<typeof setTimeout>|undefined;
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('settings_request_expired')),Math.max(0,saveBefore-Date.now()));});
        let checked:Awaited<ReturnType<typeof adoptionContext>>;
        try {checked=await Promise.race([validate(),timeout]);}
        finally {clearTimeout(timer);}
        const at=new Date().toISOString();
        const {next,pages}=adoptionResult(receipt,input.root,input.answer,comparisonPages,evidence,update,at);
        const answerWork={...checked.answer.work,status:'ready' as const};
        const writes:Parameters<Storage['wiki']['save']>[3]=[{item:{...checked.answer,work:answerWork},work:checked.answer.work}];
        if(update.changes.length) writes.push({item:{pk:`wiki-version#${input.root.version}`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,version:input.root.version,contentVersion:wikiContentVersion(input.root),pages:input.root.pages,createdAt:at,...(input.root.previousVersion ? {previousVersion:input.root.previousVersion}:{})}});
        const root=update.changes.length ? {...input.root,previousVersion:input.root.version}:input.root;
        await save(next,root,input.catalog.version,writes,pages);
        await publishAdoptionResult(store,client,config,receipt);return;
      } catch(error) {
        if(!(error instanceof AppError) || error.code!=='wiki_conflict') throw error;
        const current=await store.wiki.get<WikiAdoption>(key);
        if(current?.result) {receipt=current;await publishAdoptionResult(store,client,config,receipt);return;}
        if(!current || current.work.status==='processing' && current.work.owner!==owner) throw new AppError('wiki_processing');
        requireWikiAdoption(current,config,user);
        receipt=current;
      }
    }
    throw new AppError('wiki_attempts_exhausted');
  } catch(error) {
    const current=await store.wiki.get<WikiAdoption>(key);
    const expiredCommand=current && current.commandExpiresAt<=Math.floor(Date.now()/1000) && (current.work.until ?? 0)<=Date.now();
    if(current && !current.result && (!current.work.owner || current.work.owner===owner || expiredCommand)) {
      requireWikiAdoption(current,config,user);
      if(current.commandHash!==receipt.commandHash) throw new AppError('forbidden');
      receipt=current;const root=await store.wiki.root(config),catalog=await store.knowledge(config);
      const failed={...current,result:{status:'failed' as const,at:new Date().toISOString(),wikiVersion:wikiContentVersion(root),changes:[],failureCode:error instanceof AppError ? error.code:'wiki_processing_failed',...(error instanceof WikiUpdateError && isWikiUpdateFailureReason(error.reason) ? {failureReason:error.reason}:{})},work:{status:'failed' as const,attempts:current.work.attempts}};
      const answer=await store.wiki.get<AnswerRecord>(current.inputId!);
      const writes:Parameters<Storage['wiki']['save']>[3]=[];
      if(answer?.work.adoptionKey===key) writes.push({item:{...answer,work:{...answer.work,status:'failed',failureCode:failed.result.failureCode}},work:answer.work});
      await save(failed,root,catalog.version,writes);
      await publishAdoptionResult(store,client,config,receipt);return;
    }
    throw error;
  }
}

async function publishAdoptionResult(store:Storage,client:WebClient,config:GroupConfig,receipt:WikiAdoption):Promise<void> {
  requireWikiAdoption(receipt,config,receipt.command.actorId);
  requireAdmin(config,receipt.command.actorId);
  if(!receipt.result || ['sent','blocked'].includes(receipt.work.delivery?.status ?? '')) return;
  const hash=wikiContentHash([receipt.pk,receipt.command,receipt.result]),delivery=receipt.work.delivery;
  if(delivery && delivery.hash!==hash) throw new AppError('wiki_conflict');
  const save=async(next:NonNullable<WorkState['delivery']>)=>{
    const current=await store.wiki.get<WikiAdoption>(receipt.pk),root=await store.wiki.root(config),catalog=await store.knowledge(config);
    if(!current || wikiContentHash(current.work)!==wikiContentHash(receipt.work)) throw new AppError('wiki_conflict');
    requireWikiAdoption(current,config,receipt.command.actorId);
    if(current.commandHash!==receipt.commandHash) throw new AppError('forbidden');
    const updated={...current,work:{...current.work,delivery:next}};
    requireAdoptionCapacity(updated);
    await store.wiki.save(config,root,{...root,version:root.version+1},[{item:{...updated},work:current.work}],{catalogVersion:catalog.version,workOnly:true});receipt=updated;
  };
  const answer=await store.wiki.get<AnswerRecord>(receipt.inputId!);
  if(!answer) throw new AppError('wiki_target_changed');requireIdentity(answer,config);
  if(delivery?.status==='posting') {
    if(delivery.until>Date.now()) throw new AppError('wiki_processing');
    let cursor:string|undefined,bytes=0;const cursors=new Set<string>();
    for(let count=0;count<8;count++) {
      const page=await client.conversations.replies({channel:answer.reviewChannel,ts:answer.reviewTs,limit:100,cursor,include_all_metadata:true});
      bytes+=Buffer.byteLength(JSON.stringify(page));
      if(page.ok!==true || page.error || !Array.isArray(page.messages) || bytes>128*1024) throw new AppError('wiki_proposal_delivery_unknown');
      const found=page.messages.find(message=>message.app_id===config.appId && message.metadata?.event_type==='roughmate_wiki_result' && object(message.metadata.event_payload).adoption_key===receipt.pk && object(message.metadata.event_payload).result_hash===hash);
      if(found) {await save({...delivery,status:object(found.metadata?.event_payload).restricted===true ? 'blocked':'sent',until:0,ts:string(found.ts)});return;}
      cursor=page.response_metadata?.next_cursor;if(!cursor || cursors.has(cursor)) break;cursors.add(cursor);
    }
    throw new AppError('wiki_proposal_delivery_unknown');
  }
  if(answer.reviewChannel!==config.reviewChannelId) throw new AppError('wiki_access_changed');
  await new WikiAccess(client,config,receipt.command.actorId).require({channelIds:[],reviewChannelIds:[answer.reviewChannel]});
  const requireResultAccess=()=>requireAdoptionResultAccess(store,client,config,receipt);
  let shared=receipt.result.status!=='failed';
  if(shared) {
    try {await requireResultAccess();}
    catch(error) {if(!(error instanceof AppError)) throw error;shared=false;}
  }
  const catalog=await store.knowledge(config),owner=randomUUID();
  await store.reservePublication(config,catalog,owner);
  try {
    if(shared) await requireResultAccess();
    const posting={status:'posting' as const,hash,owner,until:Date.now()+150000};await save(posting);
    let current:WikiPage[]=[];
    try {if(shared) current=await requireResultAccess();else await new WikiAccess(client,config,receipt.command.actorId).require({channelIds:[],reviewChannelIds:[answer.reviewChannel]});}
    catch(error) {await save({...posting,status:'not_sent',until:0});throw error;}
    const section=(text:string):KnownBlock=>({type:'section',text:{type:'plain_text',text}});
    const excerpt=(text:string)=>text.length>1000 ? text.slice(0,1000)+'\n（抜粋。全文は結果のリンク）':text;
    const blocks:KnownBlock[]=shared ? [section(receipt.result.status==='applied' ? '採用した方針をWikiへ反映しました。':receipt.result.status==='unchanged' ? '最新Wikiには既に反映済みのため、本文の変更はありません。':'Wiki更新方針を見送りました。Wikiは保持しました。'),section(`${receipt.result.status==='rejected' ? '見送り判断者':'採用者'}: ${receipt.command.actorId} / 受付: ${receipt.acceptedAt} / 処理完了日時: ${receipt.result.at}`),section(`全${receipt.targets!.length}件、表示${Math.min(4,receipt.targets!.length)}件${receipt.targets!.length>4 ? `、残り${receipt.targets!.length-4}件は結果の全文`:''}。`),...receipt.targets!.slice(0,4).flatMap((target,index)=>{
      const change=receipt.result!.changes.find(change=>change.target===index),path=proposalPagePath(config,{...receipt,pk:receipt.command.proposalKey},{...target,isNew:target.isNew && !change});
      const page=current.find(page=>page.id===target.id && page.scope===target.scope);
      return [section((page ? page.title:target.title)+' / '+(target.headingPath.join(' / ') || '本文')+'\n'+(receipt.result!.status==='rejected' ? '見送った方針':'採用方針')+': '+excerpt(target.policy)),...(change ? [section('変更前\n'+excerpt(change.before)),section('変更後\n'+excerpt(change.after))]:[]),{type:'actions' as const,elements:[{type:'button' as const,action_id:'open_wiki_page',text:{type:'plain_text' as const,text:'Wiki・保存済み提案'},url:new URL(path,env('PUBLIC_URL')).href}]}];
    })]:[section(wikiUpdateFailureText(receipt.result.failureReason) || (receipt.result.failureCode==='wiki_result_capacity_exceeded' ? '変更前後の履歴・保存ページ・最新比較を含む結果全体が保存容量の上限を超えるため停止しました。Wiki本文と採用した対象・方針は保持しています。':receipt.result.failureCode==='wiki_target_review' ? '対象ページは要確認のため、部分採用では更新できません。ページの未解決事項を確認してください。':receipt.result.failureCode==='wiki_prompt_too_large' ? '最新の同じ閲覧範囲の資料・Wikiを上限内で全件比較できないため停止しました。管理者は本人認証済みWikiで状態を確認してください。':'Wiki更新の処理結果を共有できません。管理者は本人認証済みWikiで状態を確認してください。'))];
    blocks.push({type:'actions',elements:[{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text:'結果の全文'},url:new URL(adoptionPath(config,receipt.pk),env('PUBLIC_URL')).href}]});
    const posted=await client.chat.postMessage({channel:string(config.reviewChannelId),thread_ts:answer.reviewTs,text:shared ? 'Wiki更新方針の処理結果':'Wiki更新の処理状態を本人認証済みWikiで確認してください。',blocks,mrkdwn:false,parse:'none',unfurl_links:false,unfurl_media:false,metadata:{event_type:'roughmate_wiki_result',event_payload:{adoption_key:receipt.pk,result_hash:hash,restricted:!shared}}});
    await save({status:shared ? 'sent':'blocked',hash,owner,until:0,ts:string(posted.ts)});
  } finally {await store.releasePublication(owner);}
}
