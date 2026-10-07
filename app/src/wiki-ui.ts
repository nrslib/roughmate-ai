import type { KnownBlock, View, WebClient } from '@slack/web-api';
import { AppError, env, object, string } from './contracts.js';
import { adoptionPath } from './wiki-answer-proposal.js';
import { requireWikiAdoption, type WikiAdoption } from './wiki-adoption.js';
import { requireAdmin, requireIdentity, type GroupConfig, type KnowledgeCatalog, type KnowledgeDocument } from './groups.js';
import type { Storage } from './storage.js';
import {  pageAdopted, answerRetained, answerCitation, hashText, availablePages, currentAnswer, wikiCitation, wikiLimits, scopeConfigured, type WikiRoot, type UrlSource, type AnswerRecord, type Scope, type WikiPage } from './wiki-model.js';
import type { WikiReceipt, WikiCommand } from './wiki-worker.js';
import { requireWikiViewer, visibleScopes, viewerKey, WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import { knowledgeView } from './knowledge-ui.js';
import { browsePages, browseOldWiki, browseOldManual, unavailableForBrowsing, browseBudgetReached, wikiBrowseNotice, wikiExploreLabel, wikiBrowseContent } from './wiki-browsing.js';
import { protectWikiView, resolveWikiViewValue } from './wiki-view-state.js';
import { answerQuestion } from './answer-question.js';

export const wikiMembershipNotice='所属確認の上限に達したため、この画面には未確認の資料・選択肢があります。未確認は権限なし・不存在を意味しません。確認できた範囲だけを表示しています。';
export const wikiHistoryNotice='原資料・祖先の確認上限に達したため、未確認の履歴があります。未確認は権限なし・不存在を意味しません。確認できた範囲だけを表示しています。';
const incompleteBlocks=(incomplete:boolean):KnownBlock[]=>incomplete ? [section(wikiMembershipNotice)]:[];
const stateLabels={pending:'処理待ち',processing:'処理中',ready:'整理済み',failed:'失敗・再処理できます',review:'要確認'};
function questionDisplay(answer:AnswerRecord,limit?:number):string {
  const question=answerQuestion(answer);
  if(!question) return '質問: 未取得。送信済みの最終回答は保存しています。元質問を確認できるまでWiki整理を停止しています。';
  const text=limit===undefined ? question:question.slice(0,limit)+(question.length>limit ? '（全文は詳細）':'');
  return `${answer.recoveredQuestion ? '質問（送信確定後にSlack原文を復元）':'質問'}: ${text}`;
}
function answerFailure(answer:AnswerRecord):string {
  if(answer.work.adoptionKey && answer.work.status==='failed') return '\nWiki更新処理を停止しました。同じ採用指示から別の処理は実行しません。';
  return answer.work.failureCode==='question_unavailable' ? '\n整理失敗: 元質問を取得できません。再処理ではSlackの原文を再確認します。質問や編集理由を補作しません。' : answer.work.status==='failed' ? '\nWiki整理に失敗しています。元資料と閲覧範囲を確認して再処理してください。':'';
}
async function answerDelivery(store:Storage,config:GroupConfig,answer:AnswerRecord):Promise<string> {
  if(answer.work.adoptionKey) {
    const receipt=await store.wiki.get<WikiAdoption>(answer.work.adoptionKey);
    if(!receipt?.approval) return '\nWiki更新: 処理記録の期限・権限・状態を確認してください。';
    try {requireWikiAdoption(receipt,config,receipt.command.actorId);} catch(error) {if(!(error instanceof AppError)) throw error;return '\nWiki更新: 処理結果を表示できません。';}
    return '\nWiki更新: '+(receipt.result?.status==='applied' ? '採用した方針の反映が完了しました。':receipt.result?.status==='unchanged' ? '最新Wikiに反映済みのため本文変更はありません。':receipt.result?.status==='rejected' ? '見送りました。Wikiは保持しました。':receipt.result?.status==='failed' ? '処理を停止しました。別の処理は実行しません。':'採用指示を受け付けました。AI更新は処理待ち・処理中です。');
  }
  const delivery=answer.work.delivery;
  if(delivery?.status==='not_sent') return '\nWiki案の配信: 未送信確定。投稿前の検証で停止しました。最新の基点からWiki整理を再処理できます。';
  if(delivery?.status==='posting') return '\nWiki案の配信: 投稿結果不明（処理中を含む）。投稿を照合してください。未解決の間は再生成・再投稿しません。';
  if(delivery?.status==='sent') return '\nWiki案の配信: 送信済み。新案への置換では旧案を無効にして再投稿します。';
  if(delivery?.status==='blocked') return '\nWiki案の配信: 本人認証済みHome / Wikiへの確認案内を送信済み。新案への置換では再投稿します。';
  return '\nWiki案の配信: 未投稿';
}
function adoptionButtons(config:GroupConfig,answer:AnswerRecord):import('@slack/web-api').Button[] {
  return answer.work.adoptionKey ? [{type:'button',action_id:'open_wiki_web',text:{type:'plain_text',text:'Wiki更新の処理結果'},url:new URL(adoptionPath(config,answer.work.adoptionKey),env('PUBLIC_URL')).href}]:[];
}
const reviewLabels={comparison_incomplete:'同じ閲覧範囲の正式資料・正式ページを上限内で比較しきれませんでした。',comparison_unverified:'正式資料・正式ページとの整合を確認できませんでした。',formal_replacement:'別の正式資料による既存正式ページの置換は確認が必要です。'};
function reviewDescription(item:{status:string;reviewReason?:keyof typeof reviewLabels;proposalKey?:string;organized?:{status?:string}}|undefined):string {
  if(item?.status!=='review' && item?.organized?.status!=='review') return '';
  return '\n'+(item.reviewReason ? reviewLabels[item.reviewReason] : '矛盾や根拠を確認してください。')+' 要確認の取込原文・更新案は通常相談の確定知識に使用しません。既存の正式ページは保持します。'+(item.status==='review' && item.proposalKey ? ' 更新案は要確認として保存しています。':'');
}
const button=(action_id:string,text:string,value:string):import('@slack/web-api').Button=>({type:'button',action_id,text:{type:'plain_text',text},...(value ? {value}: {})});
function answerRetryButtons(config:GroupConfig,root:WikiRoot,user:string,answer:AnswerRecord):import('@slack/web-api').Button[] {
  if(!config.adminIds.includes(user) || answer.work.humanDecision || !(['pending','failed','review'].includes(answer.work.status) || answer.work.status==='processing' && (answer.work.until ?? 0)<=Date.now())) return [];
  const delivery=answer.work.delivery;
  if(delivery?.status==='posting') return [button('wiki_retry','Wiki案の投稿を照合',value(config,root,answer.pk))];
  if(delivery?.status==='sent' || delivery?.status==='blocked') return [{...button('wiki_retry','新しいWiki案へ置換',value(config,root,answer.pk)),confirm:{title:{type:'plain_text',text:'新しいWiki案へ置換'},text:{type:'plain_text',text:'送信済みの旧案を無効にして、最新の基点から新案を生成し、再投稿します。正式Wikiは採用するまで変わりません。'},confirm:{type:'plain_text',text:'生成して再投稿'},deny:{type:'plain_text',text:'戻る'}}}];
  return [button('wiki_retry','Wiki整理を再処理',value(config,root,answer.pk))];
}
const originalValue=({id,version,hash}:import('./wiki-model.js').Citation):string=>JSON.stringify({id,version,hash});
const kindLabels={faq:'FAQ',procedure:'手順',term:'用語',example:'回答例',case:'事例'};
const personSection=(text:string,user:string):KnownBlock=>({type:'section',text:{type:'mrkdwn',text:text+' <@'+user+'>'}});
const section=(text:string):KnownBlock=>({type:'section',text:{type:'plain_text',text}});
const chunks=(text:string):KnownBlock[]=>Array.from({length:Math.ceil(text.length/2800)},(_,index)=>section(text.slice(index*2800,(index+1)*2800)));
export function wikiHomeBlocks(admin:boolean):KnownBlock[] {
  return [{type:'divider'},{type:'header',text:{type:'plain_text',text:'このBot専用LLM Wiki'}},section('原資料を整理し、確定回答からのWiki更新は管理者が採用します。閲覧時にあなたのチャンネル所属を確認します。'),
    {type:'actions',elements:[...(admin ? [button('wiki_add','資料を追加','')]:[]),button('wiki_sources','資料一覧',''),button('wiki_pages','SlackでWikiを確認',''),button('wiki_answers','回答集','')]},
    ...(admin ? [{type:'actions' as const,elements:[button('wiki_sync','今すぐ同期',''),button('wiki_retention','保存・アーカイブ設定','')]}]:[])];
}
export function wikiPreparingView():View {
  return {type:'modal',callback_id:'wiki_preparing',title:{type:'plain_text',text:'専用Wiki'},close:{type:'plain_text',text:'閉じる'},blocks:[section('本人の閲覧範囲と最新の資料を確認しています。')]};
}
const explore=(action:string,state:unknown):KnownBlock=>({type:'actions',elements:[button(action,action==='wiki_sources' ? '表示できる資料を探す':action==='wiki_pages' || action==='wiki_version' ? '表示できるページを探す':wikiExploreLabel,JSON.stringify(state))]});
const modal=(blocks:KnownBlock[]):View=>({type:'modal',title:{type:'plain_text',text:'専用Wiki'},close:{type:'plain_text',text:'閉じる'},blocks});
function channelInputs(config:GroupConfig,names:Map<string,string>,source?:Scope):KnownBlock[] {
  return ([['intake','利用を許可する相談受付',config.intakeChannelIds,source?.channelIds ?? []],['review','利用を許可する対応先',config.reviewChannelId ? [config.reviewChannelId]:[],source?.reviewChannelIds ?? []]] as const).flatMap(([id,label,allowed,selected])=>allowed.some(value=>names.has(value)) ? [{type:'input' as const,block_id:id,optional:true,label:{type:'plain_text' as const,text:label},element:{type:'multi_static_select' as const,action_id:'select',options:allowed.filter(value=>names.has(value)).map(value=>({text:{type:'plain_text' as const,text:names.get(value)!},value})),initial_options:allowed.filter(value=>names.has(value) && selected.includes(value)).map(value=>({text:{type:'plain_text' as const,text:names.get(value)!},value}))}}] : [section(allowed.length ? `${label}: 所属を確認できた選択肢がありません。` : `${label}: 未設定（非公開保存）`)]);
}
export function urlView(config:GroupConfig,root:WikiRoot,names:Map<string,string>,source?:UrlSource,extra:KnownBlock[]=[]):View {
  return {type:'modal',callback_id:'wiki_source',private_metadata:JSON.stringify({configVersion:config.version,wikiVersion:root.version,id:source?.id}),title:{type:'plain_text',text:'URL資料を追加・変更'},submit:{type:'plain_text',text:'保存して整理'},close:{type:'plain_text',text:'閉じる'},blocks:[section('公開HTTPSの単一HTML・テキスト・Markdownページに対応します。本文は64KiBまで。認証ページと再帰クロールには対応しません。'),
    ...[['title','タイトル',source?.title,120],['url','公開HTTPS URL',source?.url,500]].map(([id,label,value,max])=>({type:'input' as const,block_id:id as string,label:{type:'plain_text' as const,text:label as string},element:{type:'plain_text_input' as const,action_id:'text',initial_value:value as string|undefined,max_length:max as number}})),...channelInputs(config,names,source),...extra]};
}
function retentionView(config:GroupConfig,root:WikiRoot):View {
  return {type:'modal',callback_id:'wiki_retention',private_metadata:JSON.stringify({configVersion:config.version,wikiVersion:root.version}),title:{type:'plain_text',text:'保存・アーカイブ設定'},submit:{type:'plain_text',text:'保存'},blocks:[section('通常参照は初期90日。件数・容量上限を超えた履歴もアーカイブから閲覧できます。保存日数を空欄にすると永久削除しません。保存日数を明示した場合、その日数を過ぎた回答の本文と、その回答に依存するWiki本文・旧版・保存済み更新案・参照本文コピーを、設定後と同期時の非同期処理で小分けに消去します。送信証跡と出典メタデータは保持します。保存日数を空欄に戻しても消去した知識は復活しません。送信の証跡と連結索引は保持します。既存履歴にも適用されます。'),
    {type:'input',block_id:'normal',label:{type:'plain_text',text:'通常参照日数（1〜3650）'},element:{type:'plain_text_input',action_id:'text',initial_value:String(root.normalDays),max_length:4}},
    {type:'input',block_id:'retention',optional:true,label:{type:'plain_text',text:'本文の保存日数（空欄は永久削除なし）'},element:{type:'plain_text_input',action_id:'text',initial_value:root.retentionDays===undefined ? undefined:String(root.retentionDays),max_length:4}}]};
}
async function channelNames(client:WebClient,config:GroupConfig,user:string,scopes:Scope[],access:WikiAccess):Promise<{names:Map<string,string>;incomplete:boolean}> {
  const names=new Map<string,string>();
  const {visible,incomplete}=await visibleScopes(client,config,user,scopes,access);
  for(const scope of scopes.filter(scope=>visible.has(viewerKey(scope)))) for(const channel of new Set([...scope.channelIds,...scope.reviewChannelIds])) {
    if(names.has(channel)) continue;
    const response=await client.conversations.info({channel});
    names.set(channel,'#'+string(response.channel?.name));
  }
  return {names,incomplete};
}
function scopeLabel(scope:Scope,names:Map<string,string>):string {
  const labels=(channels:string[])=>channels.map(channel=>names.get(channel)!).join(', ') || '非公開保存';
  return `相談受付: ${labels(scope.channelIds)} / 対応先: ${labels(scope.reviewChannelIds)}`;
}
function value(config:GroupConfig,root:WikiRoot,id:string):string {return JSON.stringify({configVersion:config.version,wikiVersion:root.version,id});}
function deleteSourceButton(config:GroupConfig,root:WikiRoot,source:UrlSource):import('@slack/web-api').Button {
  return {...button('wiki_delete','削除',value(config,root,source.id)),confirm:{title:{type:'plain_text',text:'資料を削除'},text:{type:'plain_text',text:`資料ID: ${source.id} / 版: ${source.version} / ${stateLabels[source.work.status]}。この出典に依存するWikiと古い回答案は利用できなくなります。原資料と履歴は保持します。`},confirm:{type:'plain_text',text:'削除'},deny:{type:'plain_text',text:'キャンセル'}}};
}
export async function wikiView(store:Storage,client:WebClient,config:GroupConfig,user:string,action:string,rawValue:string):Promise<View> {
  const root=await store.wiki.root(config),catalog=await store.knowledge(config);
  const input=rawValue.startsWith('wiki-view#') ? await resolveWikiViewValue(store,config,user,action,rawValue):rawValue;
  const view=await buildWikiView(store,client,config,user,action,input,root,catalog,new WikiAccess(client,config,user));
  const latest=await store.group(config),latestCatalog=await store.knowledge(config),latestRoot=await store.wiki.root(config);
  if(latest.version!==config.version || latestCatalog.version!==catalog.version || latestRoot.version!==root.version) throw new AppError('wiki_conflict');
  return protectWikiView(store,config,user,view);
}
async function buildWikiView(store:Storage,client:WebClient,config:GroupConfig,user:string,action:string,rawValue:string,root:WikiRoot,catalog:KnowledgeCatalog,access:WikiAccess):Promise<View> {
  const history=new WikiHistoryAccess(store,config,root,catalog,access);
  if(action==='wiki_add' || action==='wiki_edit_source') {
    requireAdmin(config,user);
    const input=action==='wiki_edit_source' ? object(JSON.parse(rawValue)) : {offset:rawValue ? Number(rawValue):0};
    const offset=input.offset===undefined ? 0:Number(input.offset);
    if(!Number.isSafeInteger(offset) || offset<0 || offset>=Math.max(1,config.intakeChannelIds.length) || offset%6) throw new AppError('invalid_input');
    const source=action==='wiki_edit_source' ? root.sources.find(source=>source.id===string(input.id)):undefined;
    if(action==='wiki_edit_source' && !source) throw new AppError('invalid_wiki_source');
    if(source) await requireWikiViewer(client,config,user,source,access);
    const channels=config.intakeChannelIds.slice(offset,offset+6);
    const choices:Scope[]=[...(config.reviewChannelId ? [{channelIds:[],reviewChannelIds:[config.reviewChannelId]}]:[]),...channels.map(channel=>({channelIds:[channel],reviewChannelIds:[]})),...(source ? [source]:[])];
    const {names,incomplete}=await channelNames(client,config,user,choices,access);
    const navigate=(page:number)=>source ? JSON.stringify({id:source.id,offset:page}):String(page);
    const navigation:KnownBlock[]=[...incompleteBlocks(incomplete),...(config.intakeChannelIds.length>6 ? [section('受付の選択肢を6件ずつ確認します。別の選択肢へ切り替えると未保存の入力は破棄されます。先に利用範囲の画面を選んでから入力してください。'),{type:'actions' as const,elements:[...(offset ? [button(action,'前の選択肢',navigate(offset-6))]:[]),...(config.intakeChannelIds.length>offset+6 ? [button(action,'次の選択肢',navigate(offset+6))]:[])]}]:[])];
    return urlView(config,root,names,source,navigation);
  }
  if(action==='wiki_retention') {requireAdmin(config,user);return retentionView(config,root);}
  if(action==='wiki_sync') {requireAdmin(config,user);return {...modal([section('登録URLを取得し、手入力資料と回答の整理を再処理できます。要確認の資料は、同じ閲覧範囲の正式資料・ページが変わっていれば再比較します。処理中の資料がある場合は完了を待ってください。'),{type:'actions',elements:[button('wiki_do_sync','同期を開始',value(config,root,''))]}])};}
  if(action==='wiki_manual_edit') {
    requireAdmin(config,user);
    const document=catalog.documents.find(document=>document.id===rawValue);
    if(!document) throw new AppError('invalid_knowledge');
    await requireWikiViewer(client,config,user,document,access);return knowledgeView(config,catalog,document);
  }
  if(action==='wiki_sources') {
    const offset=rawValue.startsWith('{') ? Number(object(JSON.parse(rawValue)).offset):rawValue ? Number(rawValue):0;
    if(!Number.isSafeInteger(offset) || offset<0 || offset>24) throw new AppError('invalid_input');
    const all=[...root.sources,...catalog.documents],candidates:Scope[]=[],visible=new Set<string>();
    let next:number|undefined,resume=all.length;
    for(let index=offset;index<all.length;index++) {
      const scope=all[index];
      try {
        await access.require(scope);
        if(candidates.length===5) {next=index;resume=index;break;}
        candidates.push(scope);visible.add(viewerKey(scope));
      } catch(error) {
        if(!unavailableForBrowsing(error)) throw error;
        if(browseBudgetReached(error) && index>offset) {resume=index;break;}
      }
    }
    const sources=root.sources.filter(source=>candidates.includes(source) && visible.has(viewerKey(source)));
    const documents=catalog.documents.filter(document=>candidates.includes(document) && visible.has(viewerKey(document)));
    const outside=config.adminIds.includes(user) ? root.sources.filter(source=>!scopeConfigured(source,config)):[];
    const {names}=await channelNames(client,config,user,[...sources,...documents],access);
    return modal([section('資料一覧。5件ずつ確認し、許可範囲のすべてにあなたが所属している資料を表示します。'),section(wikiBrowseNotice),
      ...sources.flatMap(source=>[section(`${source.title}\nURL: ${source.url}\n${stateLabels[source.work.status]} / 原資料の内容識別子: ${source.hash?.slice(0,12) ?? '未同期'}${reviewDescription(source.work)}\n最終同期: ${source.fetchedAt ?? '未同期'}\n${scopeLabel(source,names)}`),...(source.version ? [{type:'actions' as const,elements:[button('wiki_original','原資料を見る',JSON.stringify({id:`url:${source.id}:${source.revision}`,version:source.version}))]}]:[]),...(config.adminIds.includes(user) ? [{type:'actions' as const,elements:[button('wiki_edit_source','変更',value(config,root,source.id)),deleteSourceButton(config,root,source)]}]:[])]),
      ...documents.flatMap(document=>[section(`${document.title}\n手入力資料の内容識別子: ${hashText(document.body).slice(0,12)} / ${stateLabels[root.manualJobs?.find(job=>job.id===document.id && job.version===document.version)?.work.status ?? 'pending']}${reviewDescription(root.manualJobs?.find(job=>job.id===document.id && job.version===document.version)?.work)}\n出典: ${document.source}`),{type:'actions' as const,elements:[button('wiki_original','原資料を見る',`manual:${document.id}:${document.version}`),button('wiki_manual_history',wikiExploreLabel,JSON.stringify({id:document.id})),...(config.adminIds.includes(user) ? [button('wiki_manual_edit','閲覧・編集',document.id)]:[])]}]),
      ...(next!==undefined ? [{type:'actions' as const,elements:[button('wiki_sources','次の5件',String(next))]}]:[]),explore('wiki_sources',{offset:resume}),
      ...(outside.length ? [section(`現設定の範囲外にあるURL資料: ${outside.length}件（登録枠 ${root.sources.length}/${wikiLimits.urls}）。資料IDと現在状態で対象を確認して削除できます。タイトル・URL・本文は表示しません。`),...outside.flatMap(source=>[section(`資料ID: ${source.id} / 版: ${source.version}\n${stateLabels[source.work.status]} / 最終同期: ${source.fetchedAt ?? '未同期'}`),{type:'actions' as const,elements:[deleteSourceButton(config,root,source)]}])]:[]),
      ...(config.adminIds.includes(user) ? [{type:'actions' as const,elements:[button('knowledge_add','手入力資料を追加','new')]}]:[])]);
  }
  if(action==='wiki_find_version') {
    const input=object(JSON.parse(rawValue)),base=input.base===null ? null:Number(input.base),cursor={version:input.version===null ? null:Number(input.version),offset:Number(input.offset)};
    if(base!==null && (!Number.isSafeInteger(base) || base<1 || base>=root.version) || cursor.version!==null && (!Number.isSafeInteger(cursor.version) || cursor.version<1 || cursor.version>=(base ?? root.version)) || !Number.isSafeInteger(cursor.offset) || cursor.offset<0 || cursor.offset>wikiLimits.pages) throw new AppError('invalid_input');
    if(!Array.isArray(input.content) || input.content.length>wikiLimits.pages) throw new AppError('invalid_input');
    const current=input.content.map(value=>{
      const item=object(value),id=string(item.id),hash=string(item.hash);
      if(!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError('invalid_input');
      return {id,hash};
    });
    const found=await browseOldWiki(config,cursor,current,history);
    return modal([section('Wikiの過去の履歴を探す'),section(wikiBrowseNotice),
      ...(found.version===undefined ? []:[{type:'actions' as const,elements:[button('wiki_version','旧版を見る',String(found.version))]}]),
      explore(action,{base,content:current,...found.resume})]);
  }
  if(action==='wiki_pages' || action==='wiki_version') {
    let pages=availablePages(root,catalog,config,Date.now());
    let previousVersion=root.previousVersion;
    const input=action==='wiki_version' && rawValue.startsWith('{') ? object(JSON.parse(rawValue)) : {version:rawValue};
    const version=Number(input.version);
    if(action==='wiki_version') {
      if(!Number.isSafeInteger(version) || version<1 || version>=root.version) throw new AppError('invalid_input');
      const old=await history.snapshot(version);
      if(!old) return modal([section(wikiBrowseNotice)]);
      requireIdentity(old,config);
      if(!old.verified) return modal([section('完全性を検証できない旧版は表示できません。'),section(wikiBrowseNotice),explore('wiki_find_version',{base:version,version:old.previousVersion ?? null,offset:0,content:[]})]);
      if(!Array.isArray(old.pages) || old.pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(old.pages))>wikiLimits.wikiBytes) throw new AppError('missing_wiki_version');
      previousVersion=old.previousVersion;pages=old.pages;
    }
    const offset=action==='wiki_pages' && rawValue ? rawValue.startsWith('{') ? Number(object(JSON.parse(rawValue)).offset):Number(rawValue) : action==='wiki_version' && input.offset!==undefined ? Number(input.offset):0;
    if(!Number.isSafeInteger(offset) || offset<0 || offset>24) throw new AppError('invalid_input');
    const {items:selected,next,resume}=await browsePages(pages,offset,root,catalog,access,history,action==='wiki_version');
    const related=new Set(selected.map(({page})=>page.id));
    const held=(page:WikiPage)=>action==='wiki_pages' && page.status==='ready' && (!pageAdopted(page) || !page.citations.every(citation=>wikiCitation(citation,root,catalog,Date.now())));
    const {names}=await channelNames(client,config,user,selected.map(item=>item.scope),access);
    return modal([...chunks(`Wiki\n目次: ${selected.map(({page})=>`${kindLabels[page.kind]}: ${page.title}${page.status==='review' ? '（要確認）':held(page) ? '（通常回答への利用を保留）':''}`).join(' / ') || 'この画面で閲覧を確認できたページはありません。'}`),
      section(wikiBrowseNotice),...selected.flatMap(({page,scope})=>[section(`${page.title} / ${kindLabels[page.kind]} / ${held(page) ? '保存内容（通常回答への利用を保留）':stateLabels[page.status]}${reviewDescription(page)}\n${scopeLabel(scope,names)}`),...chunks(page.body),section(`関連ページ: ${page.relatedIds.filter(id=>related.has(id)).join(', ') || 'なし'}`),...page.citations.map(citation=>({type:'actions' as const,elements:[button('wiki_original',`出典 ${citation.hash.slice(0,12)}`,originalValue(citation))]}))]),
      ...(next!==undefined ? [{type:'actions' as const,elements:[button(action,'次のページ',action==='wiki_version' ? JSON.stringify({version,offset:next}):String(next))]}]:[]),
      explore(action,action==='wiki_version' ? {version,offset:resume}:{offset:resume}),explore('wiki_find_version',{base:action==='wiki_version' ? version:null,version:previousVersion ?? null,offset:0,content:wikiBrowseContent(pages)})]);
  }
  if(action==='wiki_answers' || action==='wiki_archive') {
    const items:AnswerRecord[]=[];
    let next:string|undefined;
    const input=rawValue.startsWith('{') ? object(JSON.parse(rawValue)):{cursor:rawValue || (action==='wiki_archive' ? root.historyHead:null)};
    let cursor=input.cursor===null || input.cursor===undefined ? undefined:string(input.cursor);
    const check=async(answer:AnswerRecord):Promise<boolean>=>{
      if(answer.purged || !answerRetained(answer,root,Date.now()) || action==='wiki_answers' && (!currentAnswer(answer,root,Date.now()) || !root.answers.some(item=>item.id===answer.id))) return false;
      await history.citation(answerCitation(answer));return true;
    };
    if(action==='wiki_answers') {
      const start=rawValue ? cursor===undefined ? root.answers.length:root.answers.findIndex(answer=>answer.id===cursor):0;
      if(start<0) throw new AppError('invalid_input');
      cursor=undefined;
      for(let index=start;index<root.answers.length;index++) {
        const summary=root.answers[index];
        try {
          const answer=await history.archived(summary.id);
          if(!answer || !await check(answer)) continue;
          if(items.length===5) {next=answer.id;cursor=answer.id;break;}items.push(answer);
        } catch(error) {
          if(!unavailableForBrowsing(error)) throw error;
          if(browseBudgetReached(error) && index>start) {cursor=summary.id;break;}
        }
      }
    } else {
      const seen=new Set<string>();
      for(let checked=0;cursor && checked<wikiLimits.evidence;checked++) {
        if(seen.has(cursor) || !/^wiki-answer#[a-f0-9]{64}$/.test(cursor)) throw new AppError('invalid_wiki_history');
        seen.add(cursor);
        let answer:AnswerRecord|undefined;
        try {answer=await history.archived(cursor);}
        catch(error) {if(!browseBudgetReached(error)) throw error;break;}
        if(!answer) throw new AppError('missing_wiki_answer');requireIdentity(answer,config);
        try {
          if(await check(answer)) {if(items.length===5) {next=answer.id;break;}items.push(answer);}
        } catch(error) {
          if(!unavailableForBrowsing(error)) throw error;
          if(browseBudgetReached(error) && checked>0) break;
        }
        cursor=answer.next;
      }
    }
    const deliveries=await Promise.all(items.map(answer=>answerDelivery(store,config,answer)));
    return modal([section(action==='wiki_archive' ? 'アーカイブ回答集':'通常参照の回答集'),section(wikiBrowseNotice),...items.flatMap((answer,index)=>[personSection(`${answer.sentAt} / 送信確定 / ${stateLabels[answer.work.status]} / 回答者`,answer.actorId),...chunks(`${questionDisplay(answer,500)}\n最終回答: ${answer.answer.slice(0,1500)}${answer.answer.length>1500 ? '（全文は詳細）':''}${answerFailure(answer)}${deliveries[index]}`),{type:'actions' as const,elements:[button('wiki_original','出典・根拠・下書きを見る',answer.pk),...answerRetryButtons(config,root,user,answer),...adoptionButtons(config,answer)]}]),
      ...(next ? [{type:'actions' as const,elements:[button(action,'次の5件',next)]}]:[]),explore(action,{cursor:cursor ?? null}),{type:'actions',elements:[button('wiki_archive','アーカイブを開く','')]}]);
  }
  if(action==='wiki_manual_history') {
    const input=rawValue.startsWith('{') ? object(JSON.parse(rawValue)) : {id:rawValue};
    const document=catalog.documents.find(document=>document.id===string(input.id));
    if(!document) throw new AppError('missing_wiki_source');
    await requireWikiViewer(client,config,user,document,access);
    const version=input.version===undefined ? undefined:input.version===null ? null:Number(input.version);
    if(version!==undefined && version!==null && (!Number.isSafeInteger(version) || version<1 || version>=document.version)) throw new AppError('invalid_input');
    const selected=await browseOldManual(config,document,version,history);
    const navigation=explore(action,{id:document.id,version:selected.resume});
    if(selected.version===undefined) return modal([section(wikiBrowseNotice),section('現在の閲覧権限で表示を確認できた旧版はありません。異なる閲覧範囲の原文は表示しません。'),navigation]);
    const original=(await history.manualOriginal(document.id,selected.version))!;
    return modal([...chunks(original.raw),section(`${string((original as unknown as {source:unknown}).source)} / 旧版の内容識別子: ${original.hash.slice(0,12)}`),section(wikiBrowseNotice),navigation]);
  }
  if(action==='wiki_original') {
    let id=rawValue,version:number|undefined,hash:string|undefined;
    if(rawValue.startsWith('{')) {const citation=object(JSON.parse(rawValue));id=string(citation.id);version=Number(citation.version);hash=citation.hash===undefined ? undefined:string(citation.hash);}
    if(id.startsWith('wiki-answer#')) {
      const answer=await history.archived(id);
      if(!answer || answer.purged || !answerRetained(answer,root,Date.now())) throw new AppError('missing_wiki_answer');
      requireIdentity(answer,config);
      if(version!==undefined && version!==answer.version || hash!==undefined && hash!==answer.hash) throw new AppError('forbidden');
      await history.citation(answerCitation(answer));
      const sourceLink=await client.chat.getPermalink({channel:answer.sourceChannel,message_ts:answer.mentionTs});
      const reviewLink=await client.chat.getPermalink({channel:answer.reviewChannel,message_ts:answer.reviewTs});
      const evidence=answer.recoveredQuestion ?? answer.questionCapture;
      return modal([personSection('回答者',answer.actorId),...chunks(`${questionDisplay(answer)}\nAI下書き: ${answer.draft}\n最終回答: ${answer.answer}\n送信日時: ${answer.sentAt}\n送信確定 / ${stateLabels[answer.work.status]}${answerFailure(answer)}${await answerDelivery(store,config,answer)}`),...(evidence ? [personSection('取得した元質問の投稿者',evidence.actorId),section(`質問投稿日時: ${new Date(Number(evidence.messageTs)*1000).toISOString()} / 原文確認日時: ${evidence.retrievedAt}`)]:[]),...chunks(`相談スレッド: ${string(sourceLink.permalink)}\n対応スレッド: ${string(reviewLink.permalink)}\n使用資料: ${answer.references.map(reference=>reference.kind==='wiki' ? `${reference.title} (Wiki)`:`${reference.title} / 内容識別子: ${hashText(reference.body).slice(0,12)} (${reference.source})`).join('\n') || 'なし'}`),...(answer.dependencies ?? []).map(citation=>({type:'actions' as const,elements:[button('wiki_original',`根拠 ${citation.hash.slice(0,12)}`,originalValue(citation))]})),...([...answerRetryButtons(config,root,user,answer),...adoptionButtons(config,answer)].length ? [{type:'actions' as const,elements:[...answerRetryButtons(config,root,user,answer),...adoptionButtons(config,answer)]}]:[])]);
    }
    if(id.startsWith('manual:')) {
      const [,documentId,idVersion]=id.split(':');version ??=Number(idVersion);
      const document=catalog.documents.find(document=>document.id===documentId);
      if(!document) throw new AppError('missing_wiki_source');await requireWikiViewer(client,config,user,document,access);
      if(!Number.isSafeInteger(version) || version!<1 || version!>document.version) throw new AppError('missing_wiki_source');
      if(document.version===version) {
        if(hash!==undefined && hash!==hashText(document.body)) throw new AppError('forbidden');
        return modal([...chunks(document.body),section(`${document.source} / 内容識別子: ${hashText(document.body).slice(0,12)}`),section(wikiBrowseNotice),explore('wiki_manual_history',{id:document.id})]);
      }
      const old=await history.manualOriginal(documentId,version!);
      if(!old) throw new AppError('missing_wiki_source');
      await history.citation({id:`manual:${documentId}`,version:version!,hash:hash ?? old.hash});
      const source=string((old as unknown as {source:unknown}).source);
      return modal([...chunks(old.raw),section(`${source} / 旧版の内容識別子: ${old.hash.slice(0,12)}`)]);
    }
    const [prefix,sourceId,revision]=id.split(':');
    const source=root.sources.find(source=>source.id===sourceId);
    if(prefix!=='url' || !source || !/^[a-f0-9]{24}$/.test(revision) || !Number.isSafeInteger(version) || version!<1) throw new AppError('missing_wiki_source');
    await requireWikiViewer(client,config,user,source,access);
    const original=await history.urlOriginal(source.id,revision,version!);
    if(!original) throw new AppError('missing_wiki_source');
    await history.citation({id,version:version!,hash:hash ?? original.hash});
    return modal([...chunks(original.raw),section(`${original.url} / 内容識別子: ${original.hash.slice(0,12)} / ${original.fetchedAt}`)]);
  }
  throw new AppError('invalid_input');
}
export function submittedWikiCommand(config:GroupConfig,user:string,id:string,callback:string,metadata:Record<string,unknown>,values:Record<string,unknown>):WikiCommand {
  requireAdmin(config,user);
  const input=(id:string)=>values[id]===undefined ? undefined:object(object(values[id]).text).value;
  const channels=(id:string):string[]=>{if(values[id]===undefined)return[];const options=object(object(values[id]).select).selected_options;if(options===undefined || options===null)return[];if(!Array.isArray(options))throw new AppError('invalid_input');return options.map(option=>string(object(option).value));};
  const command:WikiCommand={requestId:id,actorId:user,configVersion:Number(metadata.configVersion),wikiVersion:Number(metadata.wikiVersion),operation:callback==='wiki_source' ? 'put':'retention'};
  if(callback==='wiki_source') {
    const sourceId=metadata.id===undefined ? 'url-'+hashText(id).slice(0,32):string(metadata.id);
    command.source={id:sourceId,title:string(input('title')),url:string(input('url')),channelIds:channels('intake'),reviewChannelIds:channels('review'),revision:'',version:0,work:{status:'pending',attempts:0}};
  } else {
    command.normalDays=Number(input('normal'));
    const retention=input('retention');if(retention)command.retentionDays=Number(retention);
    for(const days of [command.normalDays,command.retentionDays]) if(days!==undefined && (!Number.isInteger(days)||days<1||days>3650)) throw new AppError('invalid_wiki_retention');
  }
  return command;
}
export async function acceptWikiCommand(store:Storage,config:GroupConfig,command:WikiCommand):Promise<WikiReceipt> {
  requireAdmin(config,command.actorId);
  if(command.configVersion!==config.version) throw new AppError('wiki_conflict');
  const now=Math.floor(Date.now()/1000);
  const receipt:WikiReceipt={pk:`wiki-command#${command.requestId}`,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,command,work:{status:'pending',attempts:0},commandExpiresAt:now+86400,expiresAt:now+21*86400};
  if(!await store.create(receipt as unknown as Record<string,unknown>)) {
    const saved=await store.get<WikiReceipt>(receipt.pk);
    if(!saved) throw new AppError('wiki_conflict');requireIdentity(saved,config);
    if(JSON.stringify(saved.command)!==JSON.stringify(command)) throw new AppError('forbidden');
    return saved;
  }
  return receipt;
}
export async function readableManualDocuments(store:Storage,client:WebClient,config:GroupConfig,user:string):Promise<{documents:KnowledgeDocument[];incomplete:boolean}> {
  const documents=(await store.knowledge(config)).documents;
  const {visible,incomplete}=await visibleScopes(client,config,user,documents);
  return {documents:documents.filter(document=>visible.has(viewerKey(document))),incomplete};
}
