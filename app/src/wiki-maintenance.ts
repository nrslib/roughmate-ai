import type { Storage } from './storage.js';
import { AppError, string } from './contracts.js';
import { requireAdmin, requireIdentity, requireRunningGroup, type GroupConfig, type KnowledgeCatalog } from './groups.js';
import { WikiHistoryAccess } from './wiki-access.js';
import { comparisonBoundary } from './wiki-comparison.js';
import { pageSlug } from './wiki-web-ui.js';
import { wikiContentHash } from './wiki-content.js';
import { requireWikiPages, wikiCitation, comparisonCitation, wikiContentVersion, wikiLimits, scopeKey, citationScope, type WikiPage, type WikiRoot, type WikiCheckpoint, type WorkState, type Scope } from './wiki-model.js';

export interface WikiHumanChange { actorId:string; at:string; operation:'edit'|'merge'|'confirm'; baseVersion:number; baseHashes:string[]; scope:Scope; }
export interface WikiMaintenanceCommand { requestId:string; actorId:string; configVersion:number; wikiVersion:number; operation:'edit'|'merge'|'confirm'|'reject'; pageId?:string; otherId?:string; title?:string; body?:string; proposalKey?:string; pageHash?:string; proposalHash?:string; }
export interface WikiMaintenanceReceipt { pk:string; environmentId:string; appId:string; teamId:string; command:WikiMaintenanceCommand; status:'saved'; commandHash:string; createdAt:string; }
export function humanPageScope(page:WikiPage):Scope|undefined { return page.human?.scope; }
export function maintainedPageTitle(title:string):string {
  if(!title.trim() || title.length>120 || Array.from(title).some(character=>character.charCodeAt(0)<32)) throw new AppError('invalid_wiki_page');
  return title;
}
function maintainedBody(body:string):string {
  if(!body.trim() || Buffer.byteLength(body)>wikiLimits.pageBytes || body.includes('\u0000')) throw new AppError('invalid_wiki_page');
  return body;
}
function intersection(pages:WikiPage[],root:WikiRoot,catalog:KnowledgeCatalog):Scope {
  const scopes=pages.map(page=>page.human?.scope ?? citationScope(page.citations[0],root,catalog));
  if(scopes.some(scope=>!scope)) throw new AppError('wiki_evidence_changed');
  const first=scopes[0]!;
  return {channelIds:first.channelIds.filter(id=>scopes.every(scope=>scope!.channelIds.includes(id))),reviewChannelIds:first.reviewChannelIds.filter(id=>scopes.every(scope=>scope!.reviewChannelIds.includes(id)))};
}
function auditPage(page:WikiPage,command:WikiMaintenanceCommand,base:WikiPage[],root:WikiRoot,catalog:KnowledgeCatalog):WikiPage {
  const scope=intersection(base,root,catalog);
  // Empty intersections are administrator-only, never wider than the inputs.
  const current=base.find(item=>item.id===page.id && item.scope===page.scope && root.pages.includes(item));
  // 統合の識別子は後続のedit/confirmで監査操作が置き換わっても保持する。
  const mergeVersion=command.operation==='merge' ? wikiContentVersion(root)+1:current?.mergeVersion;
  return {...page,...(mergeVersion!==undefined ? {mergeVersion}:{}),scope:scopeKey(scope),human:{actorId:command.actorId,at:new Date().toISOString(),operation:command.operation as WikiHumanChange['operation'],baseVersion:wikiContentVersion(root),baseHashes:base.map(wikiContentHash),scope}};
}
function sameCheckpointPage(page:WikiPage,proposal:WikiPage):boolean {
  return page.scope===proposal.scope && page.title===proposal.title && page.body===proposal.body && wikiContentHash(page.citations)===wikiContentHash(proposal.citations) && page.status==='review';
}
export async function maintainWiki(store:Storage,config:GroupConfig,catalog:KnowledgeCatalog,history:WikiHistoryAccess,command:WikiMaintenanceCommand):Promise<void> {
  requireRunningGroup(config);requireAdmin(config,command.actorId);
  if(config.publicationOwner) throw new AppError('wiki_processing');
  if(!/^wiki-maintenance#[a-f0-9]{32}$/.test(command.requestId)) throw new AppError('invalid_input');
  const saved=await store.wiki.get<WikiMaintenanceReceipt>(command.requestId);
  if(saved) {
    requireIdentity(saved,config);
    if(saved.commandHash!==wikiContentHash(command)) throw new AppError('forbidden');
    return;
  }
  const root=await store.wiki.root(config);
  if(config.version!==command.configVersion || root.version!==command.wikiVersion) throw new AppError('wiki_conflict');
  let pages=[...root.pages];
  const writes:Parameters<Storage['wiki']['save']>[3]=[];
  const next:WikiRoot={...root,version:root.version+1};
  if(command.operation==='edit' || command.operation==='merge') {
    const current=pages.find(page=>page.id===command.pageId && wikiContentHash(page)===command.pageHash);
    if(!current) throw new AppError('wiki_conflict');
    const other=command.operation==='merge' ? pages.find(page=>pageSlug(page)===command.otherId):undefined;
    if(command.operation==='merge' && (!other || other===current)) throw new AppError('invalid_input');
    const base=other ? [current,other]:[current];
    for(const page of base) {
      await history.page(page);
      if(page.status!=='ready' || !page.citations.every(citation=>wikiCitation(citation,root,catalog,Date.now()))) throw new AppError('wiki_evidence_changed');
    }
    const citations=[...new Map(base.flatMap(page=>page.citations).map(citation=>[JSON.stringify([citation.id,citation.version,citation.hash]),citation])).values()];
    if(citations.length>8) throw new AppError('wiki_capacity');
    const updated=auditPage({...current,title:maintainedPageTitle(string(command.title)),body:maintainedBody(string(command.body)),citations,relatedIds:[...new Set(base.flatMap(page=>page.relatedIds))].filter(id=>!base.some(page=>page.id===id)).slice(0,8)},command,base,root,catalog);
    pages=pages.filter(page=>!base.includes(page));
    pages=pages.map(page=>page.scope===other?.scope ? {...page,relatedIds:[...new Set(page.relatedIds.map(id=>id===other.id ? current.id:id))]}:page);
    pages.push(updated);
  } else {
    const key=string(command.proposalKey);
    if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AppError('invalid_input');
    const checkpoint=await store.wiki.get<WikiCheckpoint & {status?:string}>(key);
    if(!checkpoint || checkpoint.status || !Array.isArray(checkpoint.pages) || checkpoint.pages.length>wikiLimits.pages) throw new AppError('wiki_conflict');
    requireIdentity(checkpoint,config);requireWikiPages(checkpoint.pages);
    if(checkpoint.pagesHash!==undefined && checkpoint.pagesHash!==wikiContentHash(checkpoint.pages)) throw new AppError('wiki_evidence_changed');
    if(checkpoint.inputId?.startsWith('wiki-answer#') || checkpoint.approval) throw new AppError('invalid_input');
    const source=root.sources.find(item=>item.work.proposalKey===key);
    const manual=root.manualJobs?.find(item=>item.work.proposalKey===key);
    const work=source?.work ?? manual?.work;
    if(!work || work.status==='processing' || work.humanDecision?.operation==='reject' && work.humanDecision.proposalKey===key || !work.proposalBoundary) throw new AppError('wiki_conflict');
    const scope=source ? scopeKey(source):manual ? scopeKey(catalog.documents.find(document=>document.id===manual.id) ?? {channelIds:[],reviewChannelIds:[]}):undefined;
    if(!scope || work.proposalBoundary!==comparisonBoundary(root,catalog,config,scope)) throw new AppError('wiki_comparison_changed');
    const incoming=source ? {id:`url:${source.id}:${source.revision}`,version:source.version,hash:string(source.hash)}:manual ? {id:`manual:${manual.id}`,version:manual.version,hash:manual.hash}:undefined;
    if(!incoming) throw new AppError('wiki_conflict');
    await history.citation(incoming);
    if(!comparisonCitation(incoming,root,catalog,Date.now())) throw new AppError('wiki_evidence_changed');
    for(const page of checkpoint.pages) {
      await history.page(page);
      if(!page.citations.every(citation=>comparisonCitation(citation,root,catalog,Date.now()))) throw new AppError('wiki_evidence_changed');
    }
    const adopted=command.operation==='confirm';
    if(!adopted && command.operation!=='reject') throw new AppError('invalid_input');
    pages=pages.filter(page=>!checkpoint.pages.some(proposal=>sameCheckpointPage(page,proposal)));
    if(adopted) {
      for(const page of checkpoint.pages) {
        const current=pages.find(item=>item.id===page.id && item.scope===page.scope);
        if(current) await history.page(current);
        const base=current ? [page,current]:[page];
        const citations=[...new Map(base.flatMap(item=>item.citations).map(citation=>[JSON.stringify([citation.id,citation.version,citation.hash]),citation])).values()];
        if(citations.length>8 || !citations.every(citation=>comparisonCitation(citation,root,catalog,Date.now()))) throw new AppError('wiki_evidence_changed');
        const formal=auditPage({...page,citations,status:'ready'},command,base,root,catalog);
        delete formal.reviewReason;
        pages=pages.filter(item=>!(item.id===page.id && item.scope===page.scope));pages.push(formal);
      }
    }
    const changed:WorkState={...work,status:adopted ? 'ready':'review',humanDecision:{actorId:command.actorId,at:new Date().toISOString(),operation:adopted ? 'confirm':'reject',wikiVersion:root.version,proposalKey:key,boundary:work.proposalBoundary},...(adopted ? {organized:{version:incoming.version,hash:incoming.hash,scope,status:'ready',proposalKey:key,comparisonBoundary:work.proposalBoundary}}:{})};
    if(adopted) {delete changed.proposalKey;delete changed.proposal;delete changed.reviewReason;}
    if(source) next.sources=root.sources.map(item=>item.id===source.id ? {...item,work:changed}:item);
    if(manual) next.manualJobs=root.manualJobs!.map(item=>item.id===manual.id ? {...item,work:changed}:item);
    if(adopted) writes.push({item:{pk:key,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,status:'completed',...(checkpoint.previousProposalKey ? {previousProposalKey:checkpoint.previousProposalKey}:{})},checkpoint});
  }
  if(pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(pages))>wikiLimits.wikiBytes) throw new AppError('wiki_capacity');
  next.pages=pages;
  for(const manual of next.manualJobs ?? []) if(manual.work.humanDecision?.proposalKey===command.proposalKey && command.operation==='confirm' && manual.work.organized) manual.work.organized.readyBoundary=comparisonBoundary(next,catalog,config,manual.work.organized.scope);
  for(const source of next.sources) if(source.work.humanDecision?.proposalKey===command.proposalKey && command.operation==='confirm' && source.work.organized) source.work.organized.readyBoundary=comparisonBoundary(next,catalog,config,scopeKey(source));
  if(root.version) next.previousVersion=root.version;else delete next.previousVersion;
  if(root.version) writes.push({item:{pk:`wiki-version#${root.version}`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,version:root.version,pages:root.pages,contentVersion:wikiContentVersion(root),createdAt:new Date().toISOString(),...(root.previousVersion ? {previousVersion:root.previousVersion}:{})}});
  const metadataCommand={...command};delete metadataCommand.title;delete metadataCommand.body;
  writes.push({item:{pk:command.requestId,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,command:metadataCommand,commandHash:wikiContentHash(command),status:'saved',createdAt:new Date().toISOString()}});
  // The immutable snapshot and canonical pages share erasure reservations and the publication fence.
  await store.wiki.save(config,root,next,writes,{catalogVersion:catalog.version,publicationIdle:true});
}
