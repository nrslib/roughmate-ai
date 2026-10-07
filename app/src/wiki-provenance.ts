import type { KnowledgeDocument } from './groups.js';
import type { Citation, WikiPage } from './wiki-model.js';

export function promptCitation(citation:Citation):Citation {
  const proof=citation.answerProof;
  return {id:citation.id,version:citation.version,hash:citation.hash,...(proof ? {answerProof:{sentAt:proof.sentAt,channelIds:[...proof.channelIds],reviewChannelIds:[...proof.reviewChannelIds],dependencies:proof.dependencies.map(promptCitation),...(proof.questionState ? {questionState:proof.questionState}:{}),...(proof.questionRecoveryHash ? {questionRecoveryHash:proof.questionRecoveryHash}:{})}}:{})};
}
export function promptDocument(document:KnowledgeDocument):KnowledgeDocument {
  return {id:document.id,kind:document.kind,title:document.title,body:document.body,source:document.source,version:document.version,channelIds:[...document.channelIds],reviewChannelIds:[...document.reviewChannelIds],...(document.origins ? {origins:document.origins.map(promptCitation)}:{}),...(document.accessScopes ? {accessScopes:document.accessScopes.map(scope=>({channelIds:[...scope.channelIds],reviewChannelIds:[...scope.reviewChannelIds]}))}:{})};
}
export function promptPage(page:WikiPage):WikiPage {
  return {id:page.id,title:page.title,body:page.body,kind:page.kind,status:page.status,scope:page.scope,citations:page.citations.map(promptCitation),relatedIds:[...page.relatedIds],...(page.comparisons ? {comparisons:page.comparisons.map(check=>({target:check.target,relation:check.relation}))}:{}),...(page.reviewReason ? {reviewReason:page.reviewReason}:{})};
}
