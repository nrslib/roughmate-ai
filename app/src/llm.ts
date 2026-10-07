import OpenAI from 'openai';
import { WikiUpdateError } from './wiki-update-failure.js';
import type { GroupConfig, KnowledgeDocument } from './groups.js';
import { AppError } from './contracts.js';
import { composePrompt, consultationPersona, draftInstruction, draftContract, wikiPersona, ingestInstruction, wikiContract, answerPlanInstruction, answerPlanContract, adoptedUpdateInstruction, adoptedUpdateContract } from './prompt-facets.js';
import { promptCitation, promptDocument, promptPage } from './wiki-provenance.js';
import { comparisonTargets } from './wiki-comparison.js';
import { validateWikiProposal, wikiLimits, type Evidence, type WikiProposal, type WikiPage, type WikiUpdateTarget } from './wiki-model.js';
import { updateFragments, validateUpdatePlan, wikiSection } from './wiki-update-plan.js';
export async function generateDraft(apiKey: string, model: string, conversation: string, config: GroupConfig, documents: KnowledgeDocument[]): Promise<string> {
  const prompt=composePrompt(consultationPersona,draftInstruction,{roughmate:{name:config.name,description:config.description},conversation,referenceDocuments:documents.map(promptDocument)},draftContract);
  if(Buffer.byteLength(prompt.input)>wikiLimits.draftPromptBytes) throw new AppError('conversation_too_large');
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 60000 });
  const response = await client.responses.create({ model, store: false, max_output_tokens: 1200,
    ...prompt });
  const answer = response.output_text.trim();
  if (!answer || answer.length > 3000) throw new AppError('invalid_draft');
  return answer;
}
const comparisonSchema={type:'array',items:{type:'object',additionalProperties:false,required:['target','relation'],properties:{target:{type:'string'},relation:{type:'string',enum:['consistent','conflict','unresolved']}}}};
const wikiSchema={type:'object',additionalProperties:false,required:['pages','comparisons'],properties:{comparisons:comparisonSchema,pages:{type:'array',items:{type:'object',additionalProperties:false,required:['id','title','kind','body','citations','relatedIds','status','comparisons'],properties:{comparisons:comparisonSchema,id:{type:'string'},title:{type:'string'},kind:{type:'string',enum:['faq','procedure','term','example','case']},body:{type:'string'},status:{type:'string',enum:['ready','review']},relatedIds:{type:'array',items:{type:'string'}},citations:{type:'array',items:{type:'object',additionalProperties:false,required:['id','version','hash'],properties:{id:{type:'string'},version:{type:'integer'},hash:{type:'string'}}}}}}}}};
export async function organizeWiki(apiKey:string,model:string,evidence:Evidence[],pages:WikiPage[],scope:string,incomingId:string):Promise<WikiProposal> {
  const prompt=composePrompt(wikiPersona,ingestInstruction,{originalEvidence:evidence.map(item=>({...item,...(item.answerProof ? {answerProof:promptCitation(item).answerProof}: {})})),incomingEvidenceId:incomingId,existingWikiContext:pages.map(promptPage),comparisonTargets:comparisonTargets(evidence,pages),scope},wikiContract);
  if(Buffer.byteLength(prompt.input)>wikiLimits.promptBytes) throw new AppError('wiki_prompt_too_large');
  const client=new OpenAI({apiKey,maxRetries:0,timeout:60000});
  const response=await client.responses.create({model,store:false,max_output_tokens:6000,...prompt,text:{format:{type:'json_schema',name:'wiki_update',strict:true,schema:wikiSchema}}});
  if(response.status && response.status!=='completed' || Buffer.byteLength(response.output_text)>wikiLimits.wikiBytes) throw new AppError('invalid_wiki_output');
  let parsed:unknown;
  try { parsed=JSON.parse(response.output_text); } catch { throw new AppError('invalid_wiki_output'); }
  return validateWikiProposal(parsed,evidence,scope,pages.map(page=>page.id));
}
const citationSchema={type:'array',items:{type:'object',additionalProperties:false,required:['id','version','hash'],properties:{id:{type:'string'},version:{type:'integer'},hash:{type:'string'}}}};
const planSchema={type:'object',additionalProperties:false,required:['targets'],properties:{targets:{type:'array',items:{type:'object',additionalProperties:false,required:['id','title','isNew','headingPath','knowledge','policy','rationale','citations'],properties:{id:{type:'string'},title:{type:'string'},isNew:{type:'boolean'},headingPath:{type:'array',items:{type:'string'}},knowledge:{type:'string'},policy:{type:'string'},rationale:{type:'string'},citations:citationSchema}}}}};
const updateSchema={type:'object',additionalProperties:false,required:['operations','comparisonChecks','evidenceChecks'],properties:{evidenceChecks:{type:'array',items:{type:'object',additionalProperties:false,required:['evidence','relation'],properties:{evidence:{type:'integer'},relation:{type:'string',enum:['consistent','conflict','unresolved']}}}},comparisonChecks:{type:'array',items:{type:'object',additionalProperties:false,required:['page','relation'],properties:{page:{type:'integer'},relation:{type:'string',enum:['consistent','conflict','unresolved']}}}},operations:{type:'array',items:{type:'object',additionalProperties:false,required:['target','edits'],properties:{target:{type:'integer'},edits:{type:'array',items:{type:'object',additionalProperties:false,required:['fragment','before','after'],properties:{fragment:{type:['integer','null']},before:{type:'string'},after:{type:'string'}}}}}}}}};
function adoptedOutputText(response:unknown):string {
  if(!response || typeof response!=='object' || Array.isArray(response) || !('status' in response) || !('output_text' in response) || typeof response.output_text!=='string') throw new WikiUpdateError('output_shape');
  switch(response.status) {
    case 'completed':return response.output_text;
    case 'failed':case 'in_progress':case 'cancelled':case 'queued':case 'incomplete':throw new WikiUpdateError('generation_incomplete');
    default:throw new WikiUpdateError('output_shape');
  }
}
async function wikiJson(apiKey:string,model:string,prompt:{instructions:string;input:string},name:string,schema:Record<string,unknown>,timeout:number):Promise<unknown> {
  if(Buffer.byteLength(prompt.input)>wikiLimits.promptBytes) throw new AppError('wiki_prompt_too_large');
  const adopted=name==='wiki_adopted_update';
  const fail=(reason:ConstructorParameters<typeof WikiUpdateError>[0])=>adopted ? new WikiUpdateError(reason):new AppError('invalid_wiki_output');
  let response;
  try {response=await new OpenAI({apiKey,maxRetries:0,timeout}).responses.create({model,store:false,max_output_tokens:6000,...prompt,text:{format:{type:'json_schema',name,strict:true,schema}}});}
  catch(error) {if(adopted) throw new WikiUpdateError('generation_request_failed');throw error;}
  const text=adopted ? adoptedOutputText(response):response.output_text;
  if(!adopted && response.status && response.status!=='completed') throw fail('generation_incomplete');
  if(Buffer.byteLength(text)>wikiLimits.wikiBytes) throw fail('output_too_large');
  try {return JSON.parse(text);} catch {throw fail('json_invalid');}
}
export async function proposeWikiUpdate(apiKey:string,model:string,evidence:Evidence[],pages:WikiPage[],scope:string,incomingId:string,answer:{question:string;draft:string;answer:string}):Promise<WikiUpdateTarget[]> {
  const prompt=composePrompt(wikiPersona,answerPlanInstruction,{originalEvidence:evidence.map(item=>({id:item.id,title:item.title,version:item.version,hash:item.hash,text:item.text,kind:item.kind,channelIds:item.channelIds,reviewChannelIds:item.reviewChannelIds,...(item.answerProof ? {answerProof:promptCitation(item).answerProof}:{})})),incomingEvidenceId:incomingId,existingWikiContext:pages.map(promptPage),scope,confirmedAnswer:answer},answerPlanContract);
  return validateUpdatePlan(await wikiJson(apiKey,model,prompt,'wiki_update_plan',planSchema,60000),evidence,pages,scope,incomingId);
}
export async function generateAdoptedUpdate(apiKey:string,model:string,evidence:Evidence[],pages:WikiPage[],comparisonPages:WikiPage[],targets:WikiUpdateTarget[],timeout:number,growthBudget:number):Promise<unknown> {
  const prompt=composePrompt(wikiPersona,adoptedUpdateInstruction,{resultCapacity:{maxAddedJsonUtf8Bytes:growthBudget},originalEvidence:evidence.map((item,index)=>({evidence:index,id:item.id,title:item.title,version:item.version,hash:item.hash,text:item.text,kind:item.kind,channelIds:item.channelIds,reviewChannelIds:item.reviewChannelIds,...(item.answerProof ? {answerProof:promptCitation(item).answerProof}:{})})),latestWiki:pages.map(promptPage),latestComparisonWiki:comparisonPages.map((page,index)=>({...promptPage(page),page:index})),adoptedTargets:targets.map((target,index)=>{
    const current=pages.find(page=>page.id===target.id && page.scope===target.scope);
    const section=target.isNew ? {text:'',end:0}:wikiSection(current!.body,target.headingPath);
    const latestText=section.text;
    const appendBoundary={leadingNewline:!!latestText && !latestText.endsWith('\n'),trailingNewline:!!current && section.end<current.body.length};
    return {...target,target:index,latestText,appendBoundary,fragments:updateFragments(latestText).map(({fragment,text})=>({fragment,text})),citations:target.citations.map(promptCitation)};
  })},adoptedUpdateContract+' 変更後の直下本文のJSON UTF8 byte増分合計（escapingを含む）はresultCapacity.maxAddedJsonUtf8Bytes以内。容量に収めるために採用知識・既存本文・対象を省略しない。');
  return wikiJson(apiKey,model,prompt,'wiki_adopted_update',updateSchema,timeout);
}
