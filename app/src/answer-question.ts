import type { WebClient } from '@slack/web-api';
import { AppError } from './contracts.js';
import { diagnosticCode } from './diagnostics.js';
import { hashText, type AnswerRecord, type QuestionEvidence } from './wiki-model.js';

type QuestionLocation=Pick<AnswerRecord,'sourceChannel'|'sourceTs'|'mentionTs'|'requesterId'>;
function evidenceHash(evidence:Omit<QuestionEvidence,'hash'>):string {
  return hashText(JSON.stringify([evidence.text,evidence.actorId,evidence.messageTs,evidence.channelId,evidence.threadTs,evidence.retrievedAt]));
}
export function validateQuestionEvidence(evidence:QuestionEvidence,location:QuestionLocation):void {
  if(typeof evidence.text!=='string' || !evidence.text.trim() || evidence.text.length>40000 || Buffer.byteLength(evidence.text)>120000 || !/^[UW][A-Z0-9]+$/.test(evidence.actorId) || location.requesterId && evidence.actorId!==location.requesterId || evidence.messageTs!==location.mentionTs || !/^[0-9]+(?:\.[0-9]+)?$/.test(evidence.messageTs) || !Number.isFinite(new Date(Number(evidence.messageTs)*1000).getTime()) || evidence.channelId!==location.sourceChannel || evidence.threadTs!==location.sourceTs || !Number.isFinite(Date.parse(evidence.retrievedAt)) || evidence.hash!==evidenceHash(evidence)) throw new AppError('invalid_question_evidence');
}
export function answerQuestion(answer:AnswerRecord):string {
  if(typeof answer.question!=='string') throw new AppError('invalid_question_evidence');
  if(answer.questionState!==undefined && answer.questionState!==(answer.question ? 'captured':'unavailable')) throw new AppError('invalid_question_evidence');
  if(answer.questionCapture) {
    validateQuestionEvidence(answer.questionCapture,answer);
    if(answer.questionCapture.text!==answer.question) throw new AppError('invalid_question_evidence');
  }
  if(answer.recoveredQuestion) {
    validateQuestionEvidence(answer.recoveredQuestion,answer);
    if(answer.question || answer.questionState!=='unavailable' || answer.questionRecoveryHash!==answer.recoveredQuestion.hash) throw new AppError('invalid_question_evidence');
    return answer.recoveredQuestion.text;
  }
  if(answer.questionRecoveryHash!==undefined) throw new AppError('invalid_question_evidence');
  return answer.question;
}
export async function fetchOriginalQuestion(client:WebClient,location:QuestionLocation):Promise<QuestionEvidence|undefined> {
  let page;
  try {
    page=location.sourceTs===location.mentionTs
      ? await client.conversations.history({channel:location.sourceChannel,oldest:location.mentionTs,latest:location.mentionTs,inclusive:true,limit:1})
      : await client.conversations.replies({channel:location.sourceChannel,ts:location.sourceTs,oldest:location.mentionTs,latest:location.mentionTs,inclusive:true,limit:2});
  } catch(error) {
    // 原質問の不可用は送信確定とは別の事実。送信結果の照合を妨げない。
    if(['slack_thread_not_found','slack_channel_not_found','slack_not_in_channel','slack_no_permission','slack_missing_scope','slack_not_found'].includes(diagnosticCode(error))) return undefined;
    throw error;
  }
  if(Buffer.byteLength(JSON.stringify(page.messages ?? []))>160000) throw new AppError('invalid_question_evidence');
  const message=page.messages?.find(message=>message.ts===location.mentionTs);
  if(!message || typeof message.text!=='string' || !message.text.trim()) return undefined;
  if(message.bot_id || 'subtype' in message && message.subtype || typeof message.user!=='string' || location.sourceTs!==location.mentionTs && message.thread_ts!==location.sourceTs) throw new AppError('invalid_question_evidence');
  const content={text:message.text,actorId:message.user,messageTs:location.mentionTs,channelId:location.sourceChannel,threadTs:location.sourceTs,retrievedAt:new Date().toISOString()};
  const evidence={...content,hash:evidenceHash(content)};
  validateQuestionEvidence(evidence,location);
  return evidence;
}
