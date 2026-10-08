import { AppError } from './contracts.js';
import { requireAdmin, requireIdentity, requireRunningGroup, type GroupConfig, type KnowledgeCatalog } from './groups.js';
import type { Storage } from './storage.js';
import type { WikiAdoption } from './wiki-adoption.js';
import { WikiHistoryAccess } from './wiki-access.js';
import { wikiContentHash } from './wiki-content.js';
import { requireUpdateTargetIdentity, requireUpdateTargets, wikiSection } from './wiki-update-plan.js';
import { answerCitation, answerRetained, requireWikiPages, requireProposalDelivery, scopeKey, hashText, wikiLimits, type AnswerRecord, type WikiCheckpoint, type WikiUpdateTarget, type WikiRoot } from './wiki-model.js';

export function answerProposalHash(checkpoint:WikiCheckpoint):string {
  return wikiContentHash([checkpoint.pk,checkpoint.environmentId,checkpoint.appId,checkpoint.teamId,checkpoint.inputId,checkpoint.targets,checkpoint.approval]);
}
function wikiBotPath(config:GroupConfig):string {
  const child=/(?:\/bots\/|-bot-)([a-f0-9]{32})(?:\/runtime-|-runtime$)/.exec(config.environmentId);
  return '/wiki/'+(child ? 'bots/'+child[1]:'root');
}
export function proposalPath(config:GroupConfig,key:string):string {
  if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AppError('invalid_input');
  return wikiBotPath(config)+'/proposal?key='+encodeURIComponent(key);
}
export function adoptionPath(config:GroupConfig,key:string):string {
  if(!/^wiki-proposal#submission-[a-f0-9]{32}$/.test(key)) throw new AppError('invalid_input');
  return wikiBotPath(config)+'/adoption?key='+encodeURIComponent(key);
}
export function proposalPagePath(config:GroupConfig,checkpoint:WikiCheckpoint,target:WikiUpdateTarget):string {
  return target.isNew ? proposalPath(config,checkpoint.pk):wikiBotPath(config)+'/pages/'+hashText(target.scope).slice(0,16)+'_'+target.id;
}
function requireAnswerProposalShape(checkpoint:WikiCheckpoint,config:GroupConfig):void {
  requireIdentity(checkpoint,config);requireWikiPages(checkpoint.pages);
  const approval=checkpoint.approval;
  if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(checkpoint.pk) || checkpoint.pages.length || !approval || approval.schema!==2 || !Number.isSafeInteger(approval.configVersion) || approval.configVersion<1 || !Number.isSafeInteger(approval.baseVersion) || approval.baseVersion<0 || !/^[a-f0-9]{64}$/.test(approval.boundary) || !/^wiki-answer#[a-f0-9]{64}$/.test(checkpoint.inputId ?? '') || !Array.isArray(approval.comparisonCitations) || !approval.comparisonCitations.length || approval.comparisonCitations.length>wikiLimits.evidence || approval.comparisonCitations.some(citation=>!citation || typeof citation.id!=='string' || !Number.isSafeInteger(citation.version) || citation.version<1 || !/^[a-f0-9]{64}$/.test(citation.hash)) || Buffer.byteLength(JSON.stringify(checkpoint))>wikiLimits.itemBytes) throw new AppError('wiki_evidence_changed');
  requireWikiPages(approval.comparisonPages);requireUpdateTargets(checkpoint.targets!);
  if(!checkpoint.targets!.length) throw new AppError('wiki_evidence_changed');
}
export async function requireProposalIntake(store:Storage,config:GroupConfig,root:WikiRoot,checkpoint:WikiCheckpoint,actor?:string,expectedHash?:string,adoptionKey?:string,completed=false):Promise<AnswerRecord> {
  requireRunningGroup(config);requireAnswerProposalShape(checkpoint,config);
  if(actor) requireAdmin(config,actor);
  const approval=checkpoint.approval!;
  const answer=await store.wiki.get<AnswerRecord>(checkpoint.inputId!);
  if(!answer) throw new AppError('wiki_conflict');requireIdentity(answer,config);requireProposalDelivery(answer.work.delivery);
  const accepted=answer.work.adoptionKey===adoptionKey && !!adoptionKey;
  if(completed) {
    const receipt=accepted ? await store.wiki.get<WikiAdoption>(adoptionKey!):undefined;
    if(!receipt || !receipt.result || !['ready','failed'].includes(receipt.work.status) || receipt.command.proposalKey!==checkpoint.pk || receipt.command.proposalHash!==answerProposalHash(checkpoint) || receipt.command.actorId!==answer.work.humanDecision?.actorId) throw new AppError('wiki_comparison_changed');
    requireIdentity(receipt,config);requireAdmin(config,receipt.command.actorId);
  }
  if((!completed && (answer.work.status!=='review' || approval.configVersion!==config.version)) || answer.work.proposalKey!==checkpoint.pk || answer.work.proposalHash!==answerProposalHash(checkpoint) || (answer.work.humanDecision && !accepted) || answer.reviewChannel!==config.reviewChannelId || answer.work.proposalBoundary!==approval.boundary || expectedHash!==undefined && expectedHash!==answerProposalHash(checkpoint)) throw new AppError('wiki_comparison_changed');
  if(!approval.comparisonCitations.some(citation=>citation.id===answer.id) || checkpoint.targets!.some(target=>target.scope!==scopeKey(answer) || !target.citations.some(citation=>citation.id===answer.id))) throw new AppError('wiki_evidence_changed');
  if(!answerRetained(answer,root,Date.now())) throw new AppError('forbidden');
  if(!completed) for(const target of checkpoint.targets!) {
    const current=root.pages.find(page=>page.id===target.id && page.scope===target.scope);
    if(target.isNew ? !!current:!current) throw new AppError('wiki_target_changed');
    if(current) requireUpdateTargetIdentity(target,current);
  }
  return answer;
}
export async function requireAnswerProposal(store:Storage,config:GroupConfig,catalog:KnowledgeCatalog,root:WikiRoot,checkpoint:WikiCheckpoint,history:WikiHistoryAccess,actor?:string,expectedHash?:string,adoptionKey?:string,completed=false):Promise<AnswerRecord> {
  const answer=await requireProposalIntake(store,config,root,checkpoint,actor,expectedHash,adoptionKey,completed),approval=checkpoint.approval!;
  const citationAccess=(citation:Parameters<WikiHistoryAccess['citation']>[0])=>history.comparison(citation,!completed);
  await citationAccess(answerCitation(answer));
  for(const page of approval.comparisonPages) {
    await history.pageComparison(page);
  }
  for(const citation of [...approval.comparisonCitations,...checkpoint.targets!.flatMap(target=>target.citations)]) {
    await citationAccess(citation);
  }
  for(const target of checkpoint.targets!) {
    const current=root.pages.find(page=>page.id===target.id && page.scope===target.scope);
    if(!completed && current?.status==='review') throw new AppError('wiki_target_review');
    if(current) {
      await history.pageComparison(current);
      if(!completed) wikiSection(current.body,target.headingPath);
    }
  }
  const latest=await store.group(config),latestCatalog=await store.knowledge(config),latestRoot=await store.wiki.root(config);
  if(latest.version!==config.version || latest.lifecycle || latestCatalog.version!==catalog.version || latestRoot.version!==root.version) throw new AppError('wiki_conflict');
  return answer;
}
