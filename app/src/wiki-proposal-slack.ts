import { randomUUID } from 'node:crypto';
import type { KnownBlock, View, WebClient } from '@slack/web-api';
import { AppError, env, object, string } from './contracts.js';
import { requireAdmin, requireIdentity, requireRunningGroup, type GroupConfig, type GroupIdentity } from './groups.js';
import type { Storage } from './storage.js';
import { WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import { ChannelAudience } from './channel-audience.js';
import { answerProposalHash, proposalPagePath, proposalPath, requireAnswerProposal } from './wiki-answer-proposal.js';
import { wikiContentHash } from './wiki-content.js';
import { acceptWikiAdoption, applyWikiAdoption, requireWikiAdoption, type WikiAdoption } from './wiki-adoption.js';
import { wikiSection } from './wiki-update-plan.js';
import { answerRetained, comparisonCitation, requireProposalDelivery, type AnswerRecord, type WikiCheckpoint, type WikiUpdateTarget, type WikiRoot } from './wiki-model.js';

export const proposalActions=['wiki_proposal_confirm','wiki_proposal_edit','wiki_proposal_reject'] as const;
const section=(text:string):KnownBlock=>({type:'section',text:{type:'plain_text',text}});
const button=(action_id:string,text:string,value:string):import('@slack/web-api').Button=>({type:'button',action_id,text:{type:'plain_text',text},value});
function absolute(path:string):string {
  const base=new URL(env('PUBLIC_URL'));
  if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw new AppError('invalid_input');
  return base.origin+path;
}
function link(text:string,path:string):KnownBlock {
  return {type:'actions',elements:[{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text},url:absolute(path)}]};
}
function excerpt(text:string,at=0):string {
  if(text.length<=1000) return text || '（記述なし）';
  return '（抜粋。全文は更新案リンク）\n'+text.slice(Math.max(0,at-150),Math.max(0,at-150)+900);
}
function slackLink(value:unknown,channel:string,messageTs:string):string {
  const url=new URL(string(value)),query=[...url.searchParams];
  if(url.protocol!=='https:' || !url.hostname.endsWith('.slack.com') || url.username || url.password || url.hash || url.pathname!==`/archives/${channel}/p${messageTs.replace('.','')}`) throw new AppError('invalid_input');
  if(query.length && (query.length!==2 || url.searchParams.getAll('cid').length!==1 || url.searchParams.get('cid')!==channel || url.searchParams.getAll('thread_ts').length!==1 || !/^[0-9]+\.[0-9]{6}$/.test(url.searchParams.get('thread_ts')!))) throw new AppError('invalid_input');
  return url.href;
}
export function proposalChangeBlocks(target:WikiUpdateTarget):KnownBlock[] {
  return [section(`${target.title}${target.isNew ? ' / 新規ページ\n既定属性: FAQ / 関連ページなし':''}\n変更箇所: ${target.headingPath.join(' / ') || '本文'}`),section('現在の該当記述\n'+excerpt(target.before)),section('反映する知識\n'+excerpt(target.knowledge)),section('更新方針\n'+excerpt(target.policy)),section('根拠・適用範囲\n'+excerpt(target.rationale))];
}
function currentDisplayTarget(target:WikiUpdateTarget,root:WikiRoot):WikiUpdateTarget {
  if(target.isNew) return target;
  const page=root.pages.find(page=>page.id===target.id && page.scope===target.scope)!;
  return {...target,title:page.title,before:wikiSection(page.body,target.headingPath).text};
}
async function context(store:Storage,client:WebClient,config:GroupConfig,key:string,hash:string,user?:string,publication=false) {
  requireRunningGroup(config);
  const checkpoint=await store.wiki.get<WikiCheckpoint>(key);
  if(!checkpoint) throw new AppError('wiki_conflict');
  const root=await store.wiki.root(config),catalog=await store.knowledge(config);
  const original=await store.wiki.get<AnswerRecord>(string(checkpoint.inputId));
  if(!original) throw new AppError('wiki_conflict');
  const adoptionKey=original.work.proposalKey===key ? original.work.adoptionKey:undefined;
  const receipt=adoptionKey ? await store.wiki.get<WikiAdoption>(adoptionKey):undefined;
  if(adoptionKey && !receipt) throw new AppError('wiki_conflict');
  if(receipt) requireWikiAdoption(receipt,config,receipt.command.actorId);
  const completed=!!receipt?.result;
  if(publication && answerRetained(original,root,Date.now()) && checkpoint.approval!.comparisonCitations.some(citation=>!comparisonCitation(citation,root,catalog,Date.now()))) throw new AppError('wiki_evidence_changed');
  const history=new WikiHistoryAccess(store,config,root,catalog,new WikiAccess(client,config,user ?? original.actorId));
  const answer=await requireAnswerProposal(store,config,catalog,root,checkpoint,history,user,hash,adoptionKey,completed);
  const audience=new ChannelAudience(client,config,[string(config.reviewChannelId)]);
  await requireAnswerProposal(store,config,catalog,root,checkpoint,new WikiHistoryAccess(store,config,root,catalog,audience),user,hash,adoptionKey,completed);
  return {checkpoint,root,catalog,answer};
}
export async function publishAnswerProposal(store:Storage,client:WebClient,config:GroupConfig,answerId:string):Promise<void> {
  let answer=await store.wiki.get<AnswerRecord>(answerId);
  if(!answer || answer.work.status!=='review' || !answer.work.proposalKey || answer.work.humanDecision) return;
  requireIdentity(answer,config);requireProposalDelivery(answer.work.delivery);
  const checkpoint=await store.wiki.get<WikiCheckpoint>(answer.work.proposalKey);
  if(!checkpoint?.approval || !checkpoint.targets?.length) return;
  const hash=answerProposalHash(checkpoint),delivery=answer.work.delivery;
  if(delivery?.status==='sent' || delivery?.status==='blocked') return;
  const save=async(nextDelivery:NonNullable<AnswerRecord['work']['delivery']>,saveConfig:GroupConfig)=>{
    const root=await store.wiki.root(config),current=await store.wiki.get<AnswerRecord>(answerId);
    if(!current || wikiContentHash(current.work)!==wikiContentHash(answer!.work)) throw new AppError('wiki_conflict');
    await store.wiki.save(saveConfig,root,{...root,version:root.version+1},[{item:{...current,work:{...current.work,delivery:nextDelivery}},work:current.work}],{catalogVersion:(await store.knowledge(saveConfig)).version,workOnly:true});
    answer={...current,work:{...current.work,delivery:nextDelivery}};
  };
  if(delivery?.status==='posting') {
    if(delivery.hash!==hash || delivery.until>Date.now()) throw new AppError('wiki_processing');
    let cursor:string|undefined,bytes=0;const cursors=new Set<string>();
    for(let count=0;count<8;count++) {
      const page=await client.conversations.replies({channel:answer.reviewChannel,ts:answer.reviewTs,limit:100,cursor,include_all_metadata:true});
      bytes+=Buffer.byteLength(JSON.stringify(page));
      if(page.ok!==true || page.error || !Array.isArray(page.messages) || bytes>128*1024) throw new AppError('wiki_proposal_delivery_unknown');
      const found=page.messages.find(message=>message.app_id===config.appId && message.metadata?.event_type==='roughmate_wiki_proposal' && object(message.metadata.event_payload).proposal_key===checkpoint.pk && object(message.metadata.event_payload).proposal_hash===hash);
      if(found) {await save({...delivery,status:object(found.metadata?.event_payload).restricted===true ? 'blocked':'sent',ts:string(found.ts)},config);return;}
      cursor=page.response_metadata?.next_cursor;
      if(!cursor || cursors.has(cursor)) break;cursors.add(cursor);
    }
    // 結果不明は不存在とみなさない。再配送では照合だけを行い、自動再送しない。
    throw new AppError('wiki_proposal_delivery_unknown');
  }
  let shared=true;
  try {await context(store,client,config,checkpoint.pk,hash,undefined,true);}
  catch(error) {
    if(!(error instanceof AppError) || !['forbidden','wiki_membership_incomplete','wiki_history_incomplete','bot_not_in_channel','external_channel_not_supported'].includes(error.code)) throw error;
    shared=false;
  }
  const root=await store.wiki.root(config),catalog=await store.knowledge(config),owner=randomUUID();
  await store.reservePublication(config,catalog,owner);
  try {
    let blocks:KnownBlock[];
    if(shared) {
      const ready=await context(store,client,config,checkpoint.pk,hash,undefined,true);
      if(ready.root.version!==root.version) throw new AppError('wiki_conflict');
      const answerLink=await client.chat.getPermalink({channel:answer.sourceChannel,message_ts:answer.answerTs});
      const consultationLink=await client.chat.getPermalink({channel:answer.reviewChannel,message_ts:answer.reviewTs});
      blocks=[section('確定回答からのWiki更新案です。回答送信とは別に、Bot管理者が採用を判断します。'),...checkpoint.targets!.slice(0,4).flatMap(page=>[...proposalChangeBlocks(currentDisplayTarget(page,ready.root)),link(!page.isNew ? 'Wikiページを確認':'新規ページの更新箇所を確認',proposalPagePath(config,checkpoint,page))]),...(checkpoint.targets!.length>4 ? [section('ページ一覧は抜粋です。採用対象の全ページ・全文を更新案リンクで確認してください。')]:[]),section('根拠: 保存済みの確定回答と相談'),{type:'actions',elements:[{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text:'確定回答'},url:slackLink(answerLink.permalink,answer.sourceChannel,answer.answerTs)}]},{type:'actions',elements:[{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text:'相談・対応スレッド'},url:slackLink(consultationLink.permalink,answer.reviewChannel,answer.reviewTs)}]},link('更新箇所・知識・方針・出典の全文',proposalPath(config,checkpoint.pk)),{type:'actions',elements:proposalActions.map((action,index)=>button(action,['採用','方針を編集して採用','見送り'][index],JSON.stringify({key:checkpoint.pk,hash})))}];
    } else {
      // 共有できない案のタイトル・本文・出典リンクはチャンネルへ出さない。
      const latest=await store.group(config);
      if(latest.version!==config.version || latest.lifecycle || (await store.wiki.root(config)).version!==root.version) throw new AppError('wiki_conflict');
      blocks=[section('Wiki更新案は共有先の閲覧権限を確認できません。Bot管理者が本人認証済みのSlack Home / Wikiで確認してください。')];
    }
    const posting={status:'posting' as const,hash,owner,until:Date.now()+150000};
    await save(posting,config);
    try {
      if(shared) await context(store,client,config,checkpoint.pk,hash,undefined,true);
    } catch(error) {
      // API未呼出しが確定したこの経路だけを解除する。保存失敗・プロセス失踪は照合を維持する。
      await save({...posting,status:'not_sent',until:0},await store.group(config));
      throw error;
    }
    const posted=await client.chat.postMessage({channel:string(config.reviewChannelId),thread_ts:answer.reviewTs,text:shared ? 'Wiki更新案（Bot管理者の採用待ち）':'Wiki更新案は管理者の本人認証済みHome / Wikiで確認してください。',blocks,mrkdwn:false,parse:'none',link_names:false,unfurl_links:false,unfurl_media:false,reply_broadcast:false,metadata:{event_type:'roughmate_wiki_proposal',event_payload:{proposal_key:checkpoint.pk,proposal_hash:hash,restricted:!shared}}});
    await save({status:shared ? 'sent':'blocked',hash,owner,until:0,ts:string(posted.ts)},config);
  } finally {await store.releasePublication(owner);}
}

interface ProposalViewState extends GroupIdentity { pk:string; user:string; viewId:string; configVersion:number; wikiVersion:number; key:string; hash:string; action:string; expiresAt:number; }
export async function answerProposalView(store:Storage,client:WebClient,config:GroupConfig,user:string,action:string,value:string,viewId:string,origin?:{channel:string;ts:string}):Promise<View> {
  requireAdmin(config,user);
  if(!proposalActions.includes(action as typeof proposalActions[number])) throw new AppError('invalid_input');
  const selected=object(JSON.parse(value)),key=string(selected.key),hash=string(selected.hash);
  const {checkpoint,answer,root}=await context(store,client,config,key,hash,user);
  if(origin && (origin.channel!==answer.reviewChannel || answer.work.delivery?.status!=='sent' || answer.work.delivery.ts!==origin.ts || answer.work.delivery.hash!==hash)) throw new AppError('forbidden');
  const edit=action==='wiki_proposal_edit',editable=checkpoint.targets!.length<=4 && checkpoint.targets!.every(target=>target.policy.length<=3000);
  const targets=checkpoint.targets!.map(target=>currentDisplayTarget(target,root));
  const blocks:KnownBlock[]=[section('更新箇所・知識・方針を採用します。受付後にAIが最新Wikiを読み、採用した範囲を更新します。'),link('全対象と方針・根拠を確認',proposalPath(config,key)),...targets.slice(0,4).flatMap(target=>proposalChangeBlocks(target))];
  if(edit && editable) targets.forEach((target,index)=>blocks.push({type:'input',block_id:'policy_'+index,label:{type:'plain_text',text:'更新方針 '+(index+1)},element:{type:'plain_text_input',action_id:'text',multiline:true,initial_value:target.policy,max_length:3000}}));
  if(edit && !editable) return {type:'modal',title:{type:'plain_text',text:'Wiki更新方針を編集'},close:{type:'plain_text',text:'閉じる'},blocks:[section('Slackの編集上限を超えています。本人認証済みのブラウザで全文を確認し方針を編集して採用してください。'),link('更新方針をブラウザで編集',proposalPath(config,key)+'&edit=1')]};
  const state:ProposalViewState={pk:'wiki-view#'+randomUUID(),environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,user,viewId,configVersion:config.version,wikiVersion:root.version,key,hash,action,expiresAt:Math.floor(Date.now()/1000)+900};
  if(!await store.create(state as unknown as Record<string,unknown>)) throw new AppError('wiki_conflict');
  return {type:'modal',callback_id:'wiki_proposal_submit',private_metadata:state.pk,title:{type:'plain_text',text:'Wiki更新案の判断'},close:{type:'plain_text',text:'閉じる'},submit:{type:'plain_text',text:action==='wiki_proposal_reject' ? '見送り':edit ? '方針を編集して採用':'採用'},blocks};
}
export async function acceptProposalSubmission(store:Storage,config:GroupConfig,user:string,viewId:string,stateKey:string,values:Record<string,unknown>):Promise<string> {
  requireRunningGroup(config);requireAdmin(config,user);
  if(!/^wiki-view#[a-f0-9-]{36}$/.test(stateKey)) throw new AppError('forbidden');
  const state=await store.get<ProposalViewState>(stateKey);
  if(!state || state.pk!==stateKey || state.user!==user || state.viewId!==viewId || !Number.isSafeInteger(state.expiresAt) || state.expiresAt<=Math.floor(Date.now()/1000) || state.configVersion!==config.version || !proposalActions.includes(state.action as typeof proposalActions[number])) throw new AppError('forbidden');requireIdentity(state,config);
  const checkpoint=await store.wiki.get<WikiCheckpoint>(state.key);
  if(!checkpoint || answerProposalHash(checkpoint)!==state.hash) throw new AppError('wiki_conflict');
  const policies=state.action==='wiki_proposal_edit' ? checkpoint.targets!.map((_,index)=>string(object(object(values['policy_'+index]).text).value)):undefined;
  return acceptWikiAdoption(store,config,user,state.key,state.hash,state.action==='wiki_proposal_reject' ? 'reject':'confirm',{surface:'slack',nonceKey:state.pk,viewId:state.viewId,configVersion:state.configVersion},policies);
}
export const applyProposalSubmission=applyWikiAdoption;
