import { createHash } from 'node:crypto';

export const wikiLimits = { urls:12, pages:24, pageBytes:6144, wikiBytes:120000, rootBytes:300000, evidenceBytes:65000, contextBytes:16000, promptBytes:120000, draftPromptBytes:200000, referenceBytes:60000, activeAnswers:20, dependencies:32, proofDepth:4, historyPage:5, pendingPage:5, pendingPageBytes:8192, attempts:3, evidence:20, itemBytes:380000, answerBytes:300000, answerReserveBytes:8192, erasureAnswers:20, erasureTargets:8, erasureNodeBytes:8192, erasurePage:2 } as const;
export function hashText(text:string):string { return createHash('sha256').update(text).digest('hex'); }
export function answerKey(requestId:string):string { return `wiki-answer#${hashText(requestId)}`; }
