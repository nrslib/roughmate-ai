import type { ConsultationCondition } from './consultation-store.js';
import { dynamoConsultationCondition } from './aws-consultation-condition.js';
import { wikiContentHash } from './wiki-content.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { confirmedAnswer, validateAnswerStorage } from './answer-evidence.js';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { AppError, string, workerDrainSeconds, type Consultation } from './contracts.js';
import { requireIdentity, type GroupConfig, type GroupIdentity, type KnowledgeCatalog } from './groups.js';
import { emptyWiki, hashText, requireProposalDelivery, validateWiki, wikiLimits, type WikiRoot, type AnswerRecord, type SourceRecord, type WorkState, type WikiCheckpoint, wikiContentVersion, sourceConsultable, manualWithheld, answerSummary, answerRetained } from './wiki-model.js';
import { WikiErasureIndex, erasureKey, artifactCitations, expiredCitations, scrubArtifact, scrubRoot, transactionSize } from './wiki-erasure.js';
import { promptCitation } from './wiki-provenance.js';
import { answerQuestion } from './answer-question.js';

interface PendingNode extends GroupIdentity { pk:string; answerId:string; active:boolean; prev?:string; next?:string; }
type TransactionItems=NonNullable<TransactWriteCommandInput['TransactItems']>;
const originalAnswerFields=['pk','id','requestId','environmentId','appId','teamId','version','hash','question','questionState','questionCapture','requesterId','draft','answer','actorId','answerTs','sentAt','sourceChannel','sourceTs','mentionTs','reviewChannel','reviewTs','channelIds','reviewChannelIds','dependencies','references','next'] as const;
const immutableAnswerFields=[...originalAnswerFields,'recoveredQuestion','questionRecoveryHash'] as const;
const immutableAdoptionFields=['command','commandHash','acceptedAt','commandExpiresAt','environmentId','appId','teamId'] as const;
function itemSnapshot(item:Record<string,unknown>,fields:readonly string[]) {
  const names:Record<string,string>={},values:Record<string,unknown>={};
  const expression=fields.map((field,index)=>{
    const name=`#f${index}`,value=`:f${index}`;names[name]=field;
    if(item[field]===undefined) return `attribute_not_exists(${name})`;
    values[value]=item[field];return `${name} = ${value}`;
  }).join(' AND ');
  return {expression,names,values};
}

function pendingWork(work:Pick<WorkState,'status'|'adoptionKey'>):boolean {
  return ['pending','processing'].includes(work.status) || work.status==='review' && /^wiki-proposal#submission-[a-f0-9]{32}$/.test(work.adoptionKey ?? '');
}
export class WikiStorage {
  private erasures:WikiErasureIndex;
  constructor(private db:DynamoDBDocumentClient,private table:string,private signal?:AbortSignal) {this.erasures=new WikiErasureIndex(db,table,signal);}
  async get<T>(pk:string):Promise<T|undefined> {
    const result=await this.db.send(new GetCommand({TableName:this.table,Key:{pk},ConsistentRead:true}),{abortSignal:this.signal});
    return result.Item as T|undefined;
  }
  async root(identity:GroupIdentity):Promise<WikiRoot> {
    const raw=await this.get('wiki');
    return raw ? validateWiki(raw,identity) : emptyWiki(identity);
  }
  private rootPut(previous:WikiRoot,next:WikiRoot) {
    const content=(root:WikiRoot)=>[root.manualJobs?.filter(job=>manualWithheld(job.work)).sort((a,b)=>a.id.localeCompare(b.id)).map(job=>[job.id,job.version,job.hash]) ?? [],root.sources.map(({work,fetchedAt,contentType,...source})=>{ void work;void fetchedAt;void contentType;return {...source,consultable:sourceConsultable({...source,work})}; }),root.pages,root.normalDays,root.retentionDays,root.purgedBefore];
    next.contentVersion=Math.max(1,wikiContentVersion(previous)+(isDeepStrictEqual(content(previous),content(next)) ? 0:1));
    while(next.answers.length && Buffer.byteLength(JSON.stringify(next))>wikiLimits.rootBytes) next.answers=next.answers.slice(0,-1);
    validateWiki(next,previous);
    if(next.version!==previous.version+1) throw new AppError('invalid_wiki');
    return {TableName:this.table,Item:next,ConditionExpression:previous.version===0 ? 'attribute_not_exists(pk)' : '#v = :v AND environmentId = :env AND appId = :app AND teamId = :team',
      ...(previous.version ? {ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':previous.version,':env':previous.environmentId,':app':previous.appId,':team':previous.teamId}} : {})};
  }
  async manualKnowledgeChange(config:GroupConfig,previous:KnowledgeCatalog,next:KnowledgeCatalog):Promise<{write:TransactionItems[number];tasks:string[]}> {
    requireIdentity(previous,config);requireIdentity(next,config);
    const root=await this.root(config),tasks:string[]=[];
    const manualJobs=next.documents.map(document=>{
      const prior=previous.documents.find(item=>item.id===document.id);
      const hash=hashText(document.body),job=root.manualJobs?.find(item=>item.id===document.id && item.version===document.version && item.hash===hash);
      if(prior && isDeepStrictEqual(prior,document) && job) return job;
      tasks.push(`manual:${document.id}:${document.version}`);
      return {id:document.id,version:document.version,hash,work:{status:'pending' as const,attempts:0}};
    });
    return {write:{Put:this.rootPut(root,{...root,version:root.version+1,manualJobs})},tasks};
  }
  requirePendingIndex(root:WikiRoot):void {
    if(root.pendingIndexVersion!==1 || root.pendingSequence!==undefined || root.legacyHistoryHead!==undefined) throw new AppError('wiki_task_index_unsupported');
  }
  private async pendingNode(identity:GroupIdentity,pk:string):Promise<PendingNode> {
    if(!/^wiki-pending#[a-f0-9]{64}$/.test(pk)) throw new AppError('invalid_wiki_task');
    const node=await this.get<PendingNode>(pk);
    if(!node) throw new AppError('missing_wiki_task');
    requireIdentity(node,identity);
    if(node.pk!==pk || typeof node.active!=='boolean' || !/^wiki-answer#[a-f0-9]{64}$/.test(node.answerId) || [node.prev,node.next].some(key=>key!==undefined && !/^wiki-pending#[a-f0-9]{64}$/.test(key)) || Buffer.byteLength(JSON.stringify(node))>1024) throw new AppError('invalid_wiki_task');
    return node;
  }
  private pendingPut(node:PendingNode,previous?:PendingNode):TransactionItems[number] {
    const fields=['active','prev','next','answerId'] as const;
    return {Put:{TableName:this.table,Item:node,ConditionExpression:previous ? fields.map((field,index)=>previous[field]===undefined ? `attribute_not_exists(#f${index})` : `#f${index} = :f${index}`).join(' AND ') : 'attribute_not_exists(pk)',...(previous ? {ExpressionAttributeNames:Object.fromEntries(fields.map((field,index)=>[`#f${index}`,field])),ExpressionAttributeValues:Object.fromEntries(fields.flatMap((field,index)=>previous[field]===undefined ? [] : [[`:f${index}`,previous[field]]]))}: {})}};
  }
  private async indexChange(root:WikiRoot,next:WikiRoot,answer:AnswerRecord):Promise<TransactionItems> {
    if(!answer.pendingKey) return [];
    this.requirePendingIndex(root);
    if(answer.pendingKey!==`wiki-pending#${hashText(answer.pk)}`) throw new AppError('invalid_wiki_task');
    const stored=await this.get<PendingNode>(answer.pendingKey);
    const node=stored ? await this.pendingNode(root,answer.pendingKey):undefined;
    if(node && node.answerId!==answer.pk) throw new AppError('invalid_wiki_task');
    const active=!answer.purged && pendingWork(answer.work);
    if(active===node?.active || !active && !node) return [];
    if(active) {
      const head=root.pendingHead ? await this.pendingNode(root,root.pendingHead):undefined;
      if(head && (!head.active || head.prev)) throw new AppError('invalid_wiki_task');
      next.pendingHead=answer.pendingKey;
      return [this.pendingPut({pk:answer.pendingKey,environmentId:root.environmentId,appId:root.appId,teamId:root.teamId,answerId:answer.pk,active:true,...(head ? {next:head.pk}: {})},node),...(head ? [this.pendingPut({...head,prev:answer.pendingKey},head)]:[])];
    }
    if(!node) throw new AppError('missing_wiki_task');
    const before=node.prev ? await this.pendingNode(root,node.prev):undefined;
    const after=node.next ? await this.pendingNode(root,node.next):undefined;
    if(before && (!before.active || before.next!==node.pk) || after && (!after.active || after.prev!==node.pk) || !before && root.pendingHead!==node.pk) throw new AppError('invalid_wiki_task');
    if(!before) {if(node.next) next.pendingHead=node.next; else delete next.pendingHead;}
    const writes:TransactionItems=[this.pendingPut({...node,active:false},node)];
    if(before) {const changed={...before};if(node.next) changed.next=node.next;else delete changed.next;writes.push(this.pendingPut(changed,before));}
    if(after) {const changed={...after};if(node.prev) changed.prev=node.prev;else delete changed.prev;writes.push(this.pendingPut(changed,after));}
    return writes;
  }
  async save(config:GroupConfig,previous:WikiRoot,next:WikiRoot,writes:{item:AnswerRecord|SourceRecord|Record<string,unknown>; work?:WorkState; checkpoint?:WikiCheckpoint}[]=[],protection?:{catalogVersion:number; workOnly?:boolean; publicationIdle?:boolean; saveBefore?:number}):Promise<void> {
    requireIdentity(previous,config);
    const remove=(citations:import('./wiki-model.js').Citation[])=>expiredCitations(citations,next,Date.now());
    Object.assign(next,scrubRoot(next,remove));
    writes=writes.map(write=>{
      if(write.work && String(write.item.pk).startsWith('wiki-answer#')) {
        const item=write.item as AnswerRecord;
        return {...write,item:{...item,work:scrubArtifact({work:item.work},remove).work as WorkState}};
      }
      const item=scrubArtifact(write.item as unknown as Record<string,unknown>,remove);
      if(String(item.pk).startsWith('wiki-version#') && Array.isArray(item.pages)) item.pagesHash=wikiContentHash(item.pages);
      return {...write,item};
    });
    if(writes.length>8) throw new AppError('invalid_wiki');
    for(const {item} of writes) if(Buffer.byteLength(JSON.stringify(item))> (String(item.pk).startsWith('wiki-answer#') ? wikiLimits.answerBytes:wikiLimits.itemBytes)) throw new AppError('invalid_wiki');
    const snapshots=new Map<string,ReturnType<typeof itemSnapshot>>();
    for(const write of writes.filter(write=>/^wiki-proposal#submission-[a-f0-9]{32}$/.test(String(write.item.pk)) && write.work)) {
      const saved=await this.get<Record<string,unknown>>(String(write.item.pk));
      if(!saved) throw new AppError('wiki_conflict');
      requireIdentity(saved as unknown as GroupIdentity,config);
      const item=write.item as Record<string,unknown>;
      if(!isDeepStrictEqual(immutableAdoptionFields.map(field=>saved[field]),immutableAdoptionFields.map(field=>item[field]))) throw new AppError('forbidden');
      snapshots.set(String(item.pk),itemSnapshot(saved,immutableAdoptionFields));
    }
    for(const write of writes.filter(write=>String(write.item.pk).startsWith('wiki-answer#'))) {
      const answer=write.item as AnswerRecord;
      requireIdentity(answer,config);answerQuestion(answer);requireProposalDelivery(answer.work.delivery);
      if(write.work) {
        const saved=await this.get<AnswerRecord>(answer.pk);
        if(!saved) throw new AppError('missing_wiki_answer');
        requireIdentity(saved,config);
        if(saved.purged) throw new AppError('wiki_retention_expired');
        const immutable=(item:AnswerRecord)=>originalAnswerFields.map(field=>item[field]);
        if(!isDeepStrictEqual(immutable(saved),immutable(answer)) || saved.recoveredQuestion && (!isDeepStrictEqual(saved.recoveredQuestion,answer.recoveredQuestion) || saved.questionRecoveryHash!==answer.questionRecoveryHash)) throw new AppError('answer_state_conflict');
        snapshots.set(answer.pk,itemSnapshot(saved as unknown as Record<string,unknown>,immutableAnswerFields));
      }
      const largest={...answer,work:{...answer.work,owner:'0'.repeat(36),until:9999999999999}};
      if(Buffer.byteLength(JSON.stringify(largest))+wikiLimits.answerReserveBytes>wikiLimits.answerBytes) throw new AppError('invalid_wiki_answer');
    }
    const nodes:NonNullable<TransactWriteCommandInput['TransactItems']>=writes.map(({item,work,checkpoint})=>{
      if(checkpoint) {
        requireIdentity(checkpoint,config);
        const completed='status' in item && item.status==='completed';
        const metadata={pk:checkpoint.pk,environmentId:checkpoint.environmentId,appId:checkpoint.appId,teamId:checkpoint.teamId,status:'completed',...(checkpoint.previousProposalKey ? {previousProposalKey:checkpoint.previousProposalKey}:{})};
        if(checkpoint.pk!==item.pk || !/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(checkpoint.pk) || (completed ? !isDeepStrictEqual(item,metadata) || Buffer.byteLength(JSON.stringify(item))>1024:!isDeepStrictEqual(item,checkpoint))) throw new AppError('invalid_wiki');
        const snapshot=itemSnapshot(checkpoint as unknown as Record<string,unknown>,['pages','pagesHash','inputId','approval','targets','comparisons','previousProposalKey','environmentId','appId','teamId']);
        return {Put:{TableName:this.table,Item:item,ConditionExpression:snapshot.expression,ExpressionAttributeNames:snapshot.names,ExpressionAttributeValues:snapshot.values}};
      }
      const snapshot=snapshots.get(String(item.pk));
      return {Put:{TableName:this.table,Item:item,ConditionExpression:work ? '#work = :work'+(snapshot ? ` AND ${snapshot.expression}`:'') : 'attribute_not_exists(pk)',...(work ? {ExpressionAttributeNames:{'#work':'work',...snapshot?.names},ExpressionAttributeValues:{':work':work,...snapshot?.values}} : {})}};
    });
    const answers=writes.map(write=>write.item).filter(item=>String(item.pk).startsWith('wiki-answer#')) as AnswerRecord[];
    if(answers.length>1) throw new AppError('invalid_wiki');
    const index=answers.length ? await this.indexChange(previous,next,answers[0]):[];
    await this.erasures.reserve(previous,writes.map(write=>({pk:String(write.item.pk),citations:artifactCitations(write.checkpoint ? write.checkpoint as unknown as Record<string,unknown> : write.work && String(write.item.pk).startsWith('wiki-answer#') ? {work:(write.item as AnswerRecord).work}:write.item as unknown as Record<string,unknown>)})));
    const rootPut=this.rootPut(previous,next);
    if(protection?.workOnly && previous.version>0 && next.contentVersion!==wikiContentVersion(previous)) throw new AppError('invalid_wiki');
    try {
      const transaction:TransactionItems=[
        {ConditionCheck:{TableName:this.table,Key:{pk:'roughmate'},ConditionExpression:'#v = :v AND environmentId = :env AND appId = :app AND teamId = :team AND '+(protection?.workOnly ? 'attribute_exists(pk)' : '(attribute_not_exists(postingUntil) OR postingUntil <= :now)')+' AND attribute_not_exists(lifecycle)'+(protection?.publicationIdle ? ' AND attribute_not_exists(publicationOwner)':''),ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':config.version,':env':config.environmentId,':app':config.appId,':team':config.teamId,...(!protection?.workOnly ? {':now':Math.floor(Date.now()/1000)}:{})}}},
        {Put:rootPut},...nodes,...index,
        ...(protection ? [{ConditionCheck:{TableName:this.table,Key:{pk:'knowledge'},ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':protection.catalogVersion}}}] : [])
      ];
      transactionSize(transaction);
      if(protection?.saveBefore!==undefined && Date.now()>=protection.saveBefore) throw new AppError('settings_request_expired');
      await this.db.send(new TransactWriteCommand({TransactItems:transaction}),{abortSignal:this.signal});
    } catch(error) { if(error instanceof Error && error.name==='TransactionCanceledException') throw new AppError('wiki_conflict'); throw error; }
  }
  async preflightSent(item:Consultation):Promise<void> {
    const identity={environmentId:string(item.environmentId),appId:string(item.appId),teamId:item.teamId};
    const root=await this.root(identity);this.requirePendingIndex(root);
    validateAnswerStorage(item,string(item.answer),string(item.actorId));
    if(root.pendingHead) {
      const head=await this.pendingNode(identity,root.pendingHead);
      if(!head.active || head.prev) throw new AppError('invalid_wiki_task');
    }
  }
  async confirmSent(item:Consultation,answerTs:string,condition?:ConsultationCondition):Promise<boolean> {
    const extra=dynamoConsultationCondition(condition);
    const identity={environmentId:string(item.environmentId),appId:string(item.appId),teamId:item.teamId};
    if(item.status==='sent') {
      if(item.answerTs!==answerTs) throw new AppError('answer_state_conflict');
      return true;
    }
    if(item.status!=='posting' && item.status!=='uncertain') return false;
    for(let attempt=0;attempt<3;attempt++) {
      const root=await this.root(identity);
      let record=confirmedAnswer(item,answerTs,root.historyHead);
      const ownExpired=!answerRetained(record,root,Date.now());
      const dependencyExpired=expiredCitations(record.dependencies ?? [],root,Date.now());
      const erased=scrubArtifact(record as unknown as Record<string,unknown>,citations=>expiredCitations(citations,root,Date.now()));
      if(dependencyExpired) record={...record,references:erased.references as AnswerRecord['references'],dependencies:(record.dependencies ?? []).map(promptCitation),work:{status:'failed',attempts:0,failureCode:'wiki_retention_expired'}};
      if(ownExpired) {
        record={...record,question:'',draft:'',answer:'',references:[],dependencies:(record.dependencies ?? []).map(promptCitation),purged:true,work:{status:'ready',attempts:0}};
        delete record.questionCapture;delete record.recoveredQuestion;
      }
      const pk=record.pk,summary=answerSummary(record);
      const next=scrubRoot({...root,version:root.version+1,historyHead:pk,answers:ownExpired ? root.answers:[summary,...root.answers].slice(0,wikiLimits.activeAnswers),...(ownExpired && root.retentionDays!==undefined ? {purgedBefore:Math.max(root.purgedBefore ?? 0,Date.now()-root.retentionDays*86400000)}:{})},citations=>expiredCitations(citations,root,Date.now()));
      const index=await this.indexChange(root,next,record);
      await this.erasures.reserve(root,[{pk:record.pk,citations:artifactCitations(record as unknown as Record<string,unknown>)},{pk:item.pk,citations:record.references.filter(reference=>reference.body).flatMap(reference=>reference.origins ?? [])}]);
      const head=await this.erasures.head(root,pk);
      if(ownExpired) index.push(this.erasures.putHead(this.erasures.seal(root,pk,head),head));
      else if(!head) index.push(this.erasures.putHead({pk:erasureKey(pk),...identity,answerId:pk,version:1,nodes:0},undefined));
      const snapshot=itemSnapshot(item as unknown as Record<string,unknown>,['answer','actorId','question','questionCapture','draft','knowledgeReferences','sourceChannel','sourceTs','mentionTs','reviewChannel','reviewTs','wikiErasedAt','configVersion','postingUntil']);
      const release=await this.sentPublicationRelease(item,identity);
      try {
        await this.db.send(new TransactWriteCommand({TransactItems:[
          {Update:{TableName:this.table,Key:{pk:item.pk},UpdateExpression:'SET #s = :sent, answerTs = :ts, wikiAnswerId = :id'+(ownExpired ? ', wikiErasedAt = :erased REMOVE question, questionCapture, draft, answer, knowledgeReferences':dependencyExpired ? ', knowledgeReferences = :references, wikiErasedAt = :erased':''),ConditionExpression:'#s = :from AND '+(item.postingOwner===undefined ? 'attribute_not_exists(postingOwner)':'postingOwner = :owner')+' AND environmentId = :env AND appId = :app AND teamId = :team AND '+snapshot.expression+(extra ? ` AND (${extra.expression})` : ''),ExpressionAttributeNames:{'#s':'status',...snapshot.names},ExpressionAttributeValues:{':sent':'sent',':from':item.status,':ts':answerTs,...(item.postingOwner===undefined ? {}:{':owner':string(item.postingOwner)}),':id':pk,...(ownExpired || dependencyExpired ? {':erased':Date.now()}:{}),...(dependencyExpired && !ownExpired ? {':references':record.references}:{}),':env':identity.environmentId,':app':identity.appId,':team':identity.teamId,...snapshot.values,...extra?.values}}},
          ...release,...index,
          {Put:{TableName:this.table,Item:record,ConditionExpression:'attribute_not_exists(pk)'}},
          {Put:this.rootPut(root,next)}
        ]}),{abortSignal:this.signal});
        return true;
      } catch(error) {
        const current=await this.get<Consultation>(item.pk);
        if(current?.status==='sent') { if(current.answerTs!==answerTs) throw new AppError('answer_state_conflict'); return true; }
        if(current?.status!==item.status || current.postingOwner!==item.postingOwner) return false;
        if(!(error instanceof Error) || error.name!=='TransactionCanceledException') throw error;
        if(attempt===2) return false;
      }
    }
    throw new AppError('answer_state_conflict');
  }
  private async sentPublicationRelease(item:Consultation,identity:GroupIdentity):Promise<TransactionItems> {
    const config=await this.get<GroupConfig>('roughmate');
    if(!item.postingOwner || !config || config.publicationOwner!==item.postingOwner || config.environmentId!==identity.environmentId || config.appId!==identity.appId || config.teamId!==identity.teamId || config.version!==item.configVersion || !Number.isSafeInteger(config.postingUntil) || !config.postingUntil || config.postingUntil<0 || item.postingUntil!==0 && item.postingUntil!==config.postingUntil) return [];
    // 通信不明では相談側だけ期限が0になる。同じ所有者のleaseをCASで解除し、後続投稿には触れない。
    const snapshot=itemSnapshot(config as unknown as Record<string,unknown>,['publicationOwner','postingUntil','version','environmentId','appId','teamId']);
    return [{Update:{TableName:this.table,Key:{pk:'roughmate'},UpdateExpression:'SET postingUntil = :zero REMOVE publicationOwner, publicationKind',ConditionExpression:snapshot.expression,ExpressionAttributeNames:snapshot.names,ExpressionAttributeValues:{...snapshot.values,':zero':0}}}];
  }
  async finishStoppedUncertain(item:Consultation,config:GroupConfig,check:{startedAt:number;completedAt:number}):Promise<boolean> {
    const {startedAt,completedAt}=check,now=Math.floor(Date.now()/1000);
    if(config.lifecycle!=='stopping' || !config.stopId || !/^[a-f0-9]{32}$/.test(config.stopId) || !Number.isSafeInteger(config.stoppedAt) || !Number.isSafeInteger(config.postingUntil) || !config.postingUntil || config.postingUntil<0 || config.publicationKind!=='answer' || !config.publicationOwner || config.publicationOwner!==item.postingOwner || config.version!==item.configVersion || config.environmentId!==item.environmentId || config.appId!==item.appId || config.teamId!==item.teamId || !item.pk.startsWith(`request#${config.appId}#${config.teamId}#`) || item.status!=='uncertain' || !item.actorId || !item.answer || item.answerTs!==undefined || item.wikiAnswerId!==undefined || item.answerCancellation!==undefined || item.stoppedAnswerReconciliation!==undefined || item.postingUntil!==0 && item.postingUntil!==config.postingUntil || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt) || completedAt<startedAt || completedAt>now || startedAt<config.stoppedAt!+workerDrainSeconds || startedAt<config.postingUntil) return false;
    const receipt:NonNullable<Consultation['stoppedAnswerReconciliation']>={stopId:config.stopId,postingOwner:config.publicationOwner,publicationUntil:config.postingUntil,startedAt,completedAt,result:'not_found'};
    const request=itemSnapshot(item as unknown as Record<string,unknown>,['pk','environmentId','appId','teamId','configVersion','status','postingOwner','postingUntil','actorId','answer','answerTs','wikiAnswerId','answerCancellation','stoppedAnswerReconciliation','question','questionCapture','draft','knowledgeReferences','wikiErasedAt','sourceChannel','sourceTs','mentionTs','reviewChannel','reviewTs','draftTs']);
    const lock=itemSnapshot(config as unknown as Record<string,unknown>,['lifecycle','stopId','stoppedAt','version','environmentId','appId','teamId','publicationOwner','publicationKind','postingUntil']);
    // 見つからなかった事実だけを記録する。送信成功・未送信確定・学習登録へは変換しない。
    try {
      await this.db.send(new TransactWriteCommand({TransactItems:[
        {Update:{TableName:this.table,Key:{pk:item.pk},UpdateExpression:'SET stoppedAnswerReconciliation = :receipt',ConditionExpression:request.expression,ExpressionAttributeNames:request.names,ExpressionAttributeValues:{...request.values,':receipt':receipt}}},
        {Update:{TableName:this.table,Key:{pk:'roughmate'},UpdateExpression:'SET postingUntil = :zero REMOVE publicationOwner, publicationKind',ConditionExpression:lock.expression,ExpressionAttributeNames:lock.names,ExpressionAttributeValues:{...lock.values,':zero':0}}}
      ]}),{abortSignal:this.signal});
      return true;
    } catch(error) {if(error instanceof Error && error.name==='TransactionCanceledException') return false;throw error;}
  }
  async pending(identity:GroupIdentity,cursor?:string):Promise<{keys:string[];next?:string}> {
    const root=await this.root(identity);this.requirePendingIndex(root);
    let pk=cursor ?? root.pendingHead,bytes=0;
    const keys:string[]=[],visited=new Set<string>();
    for(let count=0;pk && count<wikiLimits.pendingPage;count++) {
      if(visited.has(pk)) throw new AppError('invalid_wiki_task');visited.add(pk);
      const node=await this.pendingNode(identity,pk);
      bytes+=Buffer.byteLength(JSON.stringify(node));
      if(node.active) {
        const response=await this.db.send(new GetCommand({TableName:this.table,Key:{pk:node.answerId},ConsistentRead:true,ProjectionExpression:'pk, environmentId, appId, teamId, purged, #work.#status, #work.#until, #work.#adoption',ExpressionAttributeNames:{'#work':'work','#status':'status','#until':'until','#adoption':'adoptionKey'}}),{abortSignal:this.signal});
        const answer=response.Item as (GroupIdentity & {pk:string;purged?:boolean;work:Pick<WorkState,'status'|'until'|'adoptionKey'>})|undefined;
        if(!answer) throw new AppError('missing_wiki_answer');requireIdentity(answer,identity);
        if(answer.pk!==node.answerId || !answer.work || !pendingWork(answer.work) || answer.purged) throw new AppError('invalid_wiki_task');
        bytes+=Buffer.byteLength(JSON.stringify(answer));
        if(answer.work.status==='pending' || (answer.work.until ?? 0)<=Date.now()) keys.push(node.answerId);
      }
      if(bytes>wikiLimits.pendingPageBytes) throw new AppError('invalid_wiki_task');
      pk=node.next;
    }
    return {keys,...(pk ? {next:pk}: {})};
  }
  async history(identity:GroupIdentity,cursor:string|undefined):Promise<{items:AnswerRecord[];next?:string}> {
    let pk=cursor ?? (await this.root(identity)).historyHead;
    if(pk && !/^wiki-answer#[a-f0-9]{64}$/.test(pk)) throw new AppError('invalid_input');
    const items:AnswerRecord[]=[];let bytes=0;
    const visited=new Set<string>();
    for(let count=0;pk && count<wikiLimits.historyPage;count++) {
      if(visited.has(pk)) throw new AppError('invalid_wiki_history');visited.add(pk);
      const node=await this.get<AnswerRecord>(pk);
      if(!node) throw new AppError('missing_wiki_answer');
      requireIdentity(node,identity);
      bytes+=Buffer.byteLength(JSON.stringify(node));
      if(bytes>wikiLimits.historyPage*wikiLimits.answerBytes) throw new AppError('invalid_wiki_history');
      items.push(node);pk=node.next;
    }
    return {items,...(pk ? {next:pk} : {})};
  }
  async transitionReferences(item:Consultation,from:Consultation['status'],patch:Partial<Consultation>,condition?:ConsultationCondition):Promise<boolean> {
    const identity={environmentId:string(item.environmentId),appId:string(item.appId),teamId:item.teamId};
    const root=await this.root(identity);
    const extra=dynamoConsultationCondition(condition);
    const references=patch.knowledgeReferences!;
    if(expiredCitations(references.flatMap(reference=>reference.origins ?? []),root,Date.now())) throw new AppError('knowledge_changed');
    await this.erasures.reserve(root,[{pk:item.pk,citations:references.flatMap(reference=>reference.origins ?? [])}]);
    const entries=Object.entries(patch),names=Object.fromEntries(entries.map(([key],i)=>[`#p${i}`,key])),values=Object.fromEntries(entries.map(([,value],i)=>[`:p${i}`,value]));
    try {
      await this.db.send(new TransactWriteCommand({TransactItems:[this.erasures.rootCheck(root),{Update:{TableName:this.table,Key:{pk:item.pk},UpdateExpression:'SET '+entries.map((_,i)=>`#p${i} = :p${i}`).join(', '),ConditionExpression:'#status = :from AND attribute_not_exists(wikiErasedAt)'+(extra ? ' AND '+extra.expression:''),ExpressionAttributeNames:{...names,'#status':'status'},ExpressionAttributeValues:{...values,':from':from,...extra?.values}}}]}),{abortSignal:this.signal});return true;
    } catch(error) {if(error instanceof Error && error.name==='TransactionCanceledException') return false;throw error;}
  }
  async purgeHistory(config:GroupConfig,cursor:string):Promise<string|undefined> {
    if(!/^wiki-answer#[a-f0-9]{64}$/.test(cursor)) throw new AppError('invalid_input');
    let root=await this.root(config);
    if(root.erasureIndexVersion!==1) throw new AppError('wiki_erasure_index_unsupported');
    const resume=root.erasureCursor;
    const continuation=resume && resume!==cursor ? cursor:undefined;
    const visited=new Set<string>();
    let candidate:string|undefined=resume ?? cursor;
    for(let count=0;candidate && count<wikiLimits.historyPage;count++) {
      if(!/^wiki-answer#[a-f0-9]{64}$/.test(candidate) || visited.has(candidate)) throw new AppError('invalid_wiki_history');visited.add(candidate);
      const response=await this.db.send(new GetCommand({TableName:this.table,Key:{pk:candidate},ConsistentRead:true,ProjectionExpression:'pk, id, environmentId, appId, teamId, sentAt, purged, #next',ExpressionAttributeNames:{'#next':'next'}}),{abortSignal:this.signal});
      const metadata=response.Item as Pick<AnswerRecord,'pk'|'id'|'environmentId'|'appId'|'teamId'|'sentAt'|'purged'|'next'>|undefined;
      if(!metadata) throw new AppError('missing_wiki_answer');requireIdentity(metadata,config);
      if(metadata.pk!==candidate || metadata.id!==candidate || !Number.isFinite(Date.parse(metadata.sentAt)) || metadata.next===candidate || metadata.next!==undefined && !/^wiki-answer#[a-f0-9]{64}$/.test(metadata.next)) throw new AppError('invalid_wiki_history');
      if(resume===candidate && !metadata.purged) throw new AppError('invalid_wiki_erasure_index');
      if(metadata.purged || root.retentionDays!==undefined && Date.parse(metadata.sentAt)<=Date.now()-root.retentionDays*86400000) break;
      candidate=metadata.next;
      if(count===wikiLimits.historyPage-1) return candidate;
    }
    if(!candidate) return undefined;
    cursor=candidate;
    const record=await this.get<AnswerRecord>(cursor);
    if(!record) throw new AppError('missing_wiki_answer');requireIdentity(record,config);
    if(record.pk!==cursor || record.id!==cursor || record.id!==`wiki-answer#${hashText(record.requestId)}` || !Number.isFinite(Date.parse(record.sentAt)) || record.next!==undefined && (!/^wiki-answer#[a-f0-9]{64}$/.test(record.next) || record.next===cursor) || !record.purged && record.hash!==hashText(JSON.stringify([record.question,record.answer])) || Buffer.byteLength(JSON.stringify(record))>wikiLimits.answerBytes) throw new AppError('invalid_wiki_answer');
    let head=await this.erasures.head(root,record.id);
    if(!head) throw new AppError('missing_wiki_erasure_index');
    if(resume===record.id && !head.cursor) throw new AppError('invalid_wiki_erasure_index');
    if(!record.purged) {
      if(root.retentionDays===undefined || Date.parse(record.sentAt)>Date.now()-root.retentionDays*86400000) return record.next;
      const cutoff=Date.now()-root.retentionDays*86400000;
      const next=scrubRoot({...root,version:root.version+1,purgedBefore:Math.max(root.purgedBefore ?? 0,cutoff),answers:root.answers.filter(answer=>answer.id!==record.id)},citations=>expiredCitations(citations,{...root,purgedBefore:Math.max(root.purgedBefore ?? 0,cutoff)},Date.now()));
      const purged={...record,question:'',draft:'',answer:'',references:[],dependencies:(record.dependencies ?? []).map(promptCitation),purged:true,work:{status:'ready' as const,attempts:record.work.attempts}};
      delete purged.questionCapture;delete purged.recoveredQuestion;
      const index=await this.indexChange(root,next,purged),sealed=this.erasures.seal(root,record.id,head);
      if(sealed.cursor) next.erasureCursor=record.id;
      const snapshot=itemSnapshot(record as unknown as Record<string,unknown>,[...immutableAnswerFields,'purged']);
      await this.purgeTransaction(config,root,next,[...index,this.erasures.putHead(sealed,head),
        {Put:{TableName:this.table,Item:purged,ConditionExpression:'#work = :work AND '+snapshot.expression,ExpressionAttributeNames:{'#work':'work',...snapshot.names},ExpressionAttributeValues:{':work':record.work,...snapshot.values}}},
        {Update:{TableName:this.table,Key:{pk:record.requestId},UpdateExpression:'SET wikiErasedAt = :erased REMOVE question, questionCapture, draft, answer, knowledgeReferences',ConditionExpression:'#s = :sent AND wikiAnswerId = :id',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':sent':'sent',':id':record.id,':erased':Date.now()}}}
      ]);
      root=next;head=sealed;
    }
    if(!head?.purged) throw new AppError('missing_wiki_erasure_index');
    for(let count=0;head.cursor && count<wikiLimits.erasurePage;count++) {
      const target=await this.erasures.target(root,head),stored=await this.get<Record<string,unknown>>(target.pk);
      const writes:TransactionItems=[];
      if(stored) {
        requireIdentity(stored as unknown as GroupIdentity,config);
        if(stored.pk!==target.pk || Buffer.byteLength(JSON.stringify(stored))>wikiLimits.itemBytes) throw new AppError('invalid_wiki_erasure_index');
        const cleaned=scrubArtifact(stored,citations=>this.erasures.depends(citations,root,record.id));
        if(!isDeepStrictEqual(stored,cleaned)) {
          const fields=target.pk.startsWith('request#') ? ['knowledgeReferences','status','wikiErasedAt']:['pages','references','dependencies','work','purged','approval','targets','command','result'];
          const snapshot=itemSnapshot(stored,fields);
          if(target.pk.startsWith('request#')) writes.push({Update:{TableName:this.table,Key:{pk:target.pk},UpdateExpression:'SET knowledgeReferences = :refs, wikiErasedAt = :erased'+(['generating','draft'].includes(String(stored.status)) ? ' REMOVE draft, answer':''),ConditionExpression:snapshot.expression,ExpressionAttributeNames:snapshot.names,ExpressionAttributeValues:{...snapshot.values,':refs':cleaned.knowledgeReferences,':erased':Date.now()}}});
          else writes.push({Put:{TableName:this.table,Item:cleaned,ConditionExpression:snapshot.expression,ExpressionAttributeNames:snapshot.names,ExpressionAttributeValues:snapshot.values}});
        }
      }
      const next={...root,version:root.version+1};
      if(target.next.cursor) next.erasureCursor=record.id;
      else if(next.erasureCursor===record.id) delete next.erasureCursor;
      writes.push(this.erasures.putHead(target.next,head));
      await this.purgeTransaction(config,root,next,writes);
      root=next;head=target.next;
    }
    return head.cursor ? continuation ?? cursor:continuation ?? record.next;
  }
  private archiveRetentionDue(root:WikiRoot,now:number):boolean {
    const progress=root.archiveRetention;
    if(progress?.until!==undefined && progress.until>now) return false;
    if(progress?.retentionDays===root.retentionDays && progress?.nextRunAt!==undefined && progress.nextRunAt>now) return false;
    const migration=root.erasureContinuationVersion!==1 && root.purgedBefore!==undefined;
    return !!root.erasureCursor || !!root.historyHead && (migration || root.retentionDays!==undefined);
  }
  async archiveRetentionStep(identity:GroupIdentity):Promise<number|undefined> {
    const root=await this.root(identity);
    return this.archiveRetentionDue(root,Date.now()) ? root.archiveRetention?.step ?? 0:undefined;
  }
  async purgeArchiveHistory(config:GroupConfig,step:number|undefined):Promise<void> {
    if(config.lifecycle!=='archived' || !config.stopId) throw new AppError('registration_boundary');
    if(step!==undefined && (!Number.isSafeInteger(step) || step<0)) throw new AppError('invalid_input');
    const root=await this.root(config),progress=root.archiveRetention;
    // 旧配送の任意cursorは採用せず、最初の永続巡回だけを開始する。
    if(step===undefined && progress || step!==undefined && step!==(progress?.step ?? 0) || !this.archiveRetentionDue(root,Date.now())) return;
    const cursor=progress?.cursor ?? root.historyHead ?? root.erasureCursor;
    if(!cursor) throw new AppError('invalid_wiki_history');
    const owner=randomUUID(),claimed={...root,version:root.version+1,archiveRetention:{step:progress?.step ?? 0,cursor,owner,until:Date.now()+workerDrainSeconds*1000,...(root.retentionDays!==undefined ? {retentionDays:root.retentionDays}:{})}};
    await this.purgeTransaction(config,root,claimed,[]);
    const cursorNext=await this.purgeHistory(config,cursor),current=await this.root(config);
    if(current.archiveRetention?.owner!==owner || current.archiveRetention.step!==claimed.archiveRetention.step) throw new AppError('wiki_conflict');
    const next={...current,version:current.version+1,archiveRetention:{step:claimed.archiveRetention.step+1,nextRunAt:Date.now()+30*60*1000,...(cursorNext ? {cursor:cursorNext}:{}),...(current.retentionDays!==undefined ? {retentionDays:current.retentionDays}:{})}};
    if(!cursorNext) next.erasureContinuationVersion=1;
    await this.purgeTransaction(config,current,next,[]);
  }
  private async purgeTransaction(config:GroupConfig,root:WikiRoot,next:WikiRoot,writes:TransactionItems):Promise<void> {
    const transaction:TransactionItems=[{Put:this.rootPut(root,next)},...writes,{ConditionCheck:{TableName:this.table,Key:{pk:'roughmate'},ConditionExpression:'#v = :v AND environmentId = :env AND appId = :app AND teamId = :team AND (attribute_not_exists(postingUntil) OR postingUntil <= :now)'+(config.lifecycle==='archived' ? ' AND lifecycle = :archived AND stopId = :stopId':''),ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':config.version,':env':config.environmentId,':app':config.appId,':team':config.teamId,':now':Math.floor(Date.now()/1000),...(config.lifecycle==='archived' ? {':archived':'archived',':stopId':config.stopId}:{})}}}];
    transactionSize(transaction);
    try {await this.db.send(new TransactWriteCommand({TransactItems:transaction}),{abortSignal:this.signal});}
    catch(error) {if(error instanceof Error && error.name==='TransactionCanceledException') throw new AppError('wiki_conflict');throw error;}
  }
}
