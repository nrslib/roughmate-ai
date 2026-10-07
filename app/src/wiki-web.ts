import { wikiUpdateFailureText } from './wiki-update-failure.js';
import { acceptWikiAdoption, requireAdoptionResultHistory, requireAdoptionResultAccess, requireWikiAdoption, type WikiAdoption } from './wiki-adoption.js';
import { createBrowserProposalView, acceptBrowserProposalView } from './wiki-adoption-origin.js';
import { enqueueWikiAdoption } from './wiki-queue.js';
import { wikiSection } from './wiki-update-plan.js';
import { adoptionPath, answerProposalHash, proposalPagePath, requireAnswerProposal } from './wiki-answer-proposal.js';
import { ChannelAudience } from './channel-audience.js';
import { deviceShell, challengeForTarget, wikiDeviceScriptHash } from './wiki-web-device.js';
import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AppError, env, string, requireInstalledSecrets } from './contracts.js';
import { Registrations } from './registration.js';
import { BotMaintenance } from './bot-maintenance.js';
import { WikiBrowserAuth, WikiBrowserAccess, requireWikiCsrf, wikiCookie } from './wiki-web-auth.js';
import { WikiHistoryAccess } from './wiki-access.js';
import { requireIdentity, requireRunningGroup } from './groups.js';
import { wikiLimits, pageAdopted, requireWikiPages, comparisonCitation, answerCitation, type WikiRoot, type WikiPage, type WikiCheckpoint, type AnswerRecord, type SourceRecord, type Citation, hashText } from './wiki-model.js';
import { wikiContentHash } from './wiki-content.js';
import { answerQuestion } from './answer-question.js';
import { slackClient, requireBotIdentity } from './slack.js';
import { maintainWiki, type WikiMaintenanceCommand } from './wiki-maintenance.js';
import { html, wikiAnchor, wikiLayout, pageSlug, renderWikiBody } from './wiki-web-ui.js';
import { diagnosticCode } from './diagnostics.js';

const headers={'content-type':'text/html; charset=utf-8','cache-control':'private, no-store, max-age=0','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'permissions-policy':'camera=(), microphone=(), geolocation=()'};
const response=(body:string,statusCode=200):APIGatewayProxyStructuredResultV2=>({statusCode,headers,body});
const redirect=(location:string,cookies?:string[]):APIGatewayProxyStructuredResultV2=>({statusCode:303,headers:{...headers,location},cookies,body:''});
function unavailable(error:unknown):boolean {
  return error instanceof AppError && ['forbidden','missing_wiki_source','missing_wiki_answer','group_boundary_mismatch','wiki_retention_expired','wiki_membership_incomplete','wiki_history_incomplete','bot_not_in_channel'].includes(error.code) || ['slack_channel_not_found','slack_not_in_channel'].includes(diagnosticCode(error));
}
function number(value:string|undefined):number {if(!value || !/^\d{1,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AppError('invalid_input');return Number(value);}
function form(fields:Record<string,string>):string {return Object.entries(fields).map(([key,value])=>`<input type="hidden" name="${html(key)}" value="${html(value)}">`).join('');}
async function visiblePages(pages:WikiPage[],history:WikiHistoryAccess,state?:{incomplete:boolean}):Promise<WikiPage[]> {
  const visible:WikiPage[]=[];
  for(const page of pages) {try {await history.page(page);visible.push(page);} catch(error) {if(!unavailable(error)) throw error;if(state && error instanceof AppError && ['wiki_membership_incomplete','wiki_history_incomplete'].includes(error.code)) state.incomplete=true;}}
  return visible;
}
export async function wikiWeb(event:APIGatewayProxyEventV2):Promise<APIGatewayProxyStructuredResultV2> {
  const signal=AbortSignal.timeout(8500),registrations=new Registrations(env('TABLE_NAME'),env('SECRET_ARN'),signal),maintenance=new BotMaintenance(registrations,signal);
  const method=event.requestContext.http.method;
  try {
    const workspace=await registrations.root.workspace(),secrets=await registrations.root.readSecrets(),baseUrl=env('PUBLIC_URL');
    const auth=new WikiBrowserAuth(registrations.root,env('TABLE_NAME'),env('SECRET_ARN'),baseUrl,signal);
    if(event.rawPath==='/wiki/auth/callback' && method==='GET') {
      const result=await auth.complete(event,secrets,workspace);
      return redirect(result.path,[wikiCookie('session',result.id,3600)]);
    }
    if(event.rawPath==='/wiki/device/challenge' && method==='GET') return {statusCode:200,headers:{...headers,'content-type':'text/plain; charset=utf-8'},body:challengeForTarget(event,secrets)};
    if(method==='GET' && !event.headers['x-wiki-device-signature']) return {statusCode:200,headers:{...headers,'content-security-policy':headers['content-security-policy']+`; script-src 'sha256-${wikiDeviceScriptHash}'; connect-src 'self'`},body:deviceShell()};
    if(event.rawPath==='/wiki/login' && method==='GET') {
      const started=await auth.begin(event,event.queryStringParameters?.return ?? '/wiki/root',secrets,workspace);
      return {statusCode:200,headers:{...headers,'x-wiki-location':started.url},cookies:[wikiCookie('browser',started.browser,86400)],body:''};
    }
    const authenticated=await auth.session(event,secrets,workspace),user=authenticated.session.userId,visibility={incomplete:false};
    const incompleteNotice=()=>visibility.incomplete ? '<p class="notice">一部の所属・出典を確認できていません。少し待ってページを開き直してください。</p>':'';
    if(event.rawPath==='/wiki/logout' && method==='POST') {
      const values=readForm(event);requireWikiCsrf(event,string(values.get('csrf')),authenticated.csrf,baseUrl);
      await auth.logout(event);return {...response(wikiLayout('ログアウトしました','<p>Slack HomeからWikiを開いてください。</p>'),200),cookies:[wikiCookie('session','',0)]};
    }
    if(event.rawPath==='/wiki/archives' && method==='GET') {
      const answerBot=event.queryStringParameters?.answerBot,answerCursor=event.queryStringParameters?.answerCursor;
      if(answerCursor && !answerBot || answerBot && !/^[a-f0-9]{32}$/.test(answerBot) || answerCursor && !/^wiki-answer#[a-f0-9]{64}$/.test(answerCursor)) throw new AppError('invalid_input');
      const listing=answerBot ? {items:[await maintenance.archive(answerBot)],next:undefined}:await maintenance.archives(event.queryStringParameters?.cursor);
      const links:string[]=[],budget={checks:0};
      for(const archived of listing.items) {
        const resolved=await maintenance.browserBot(archived.entry.id);
        if(!await resolved.store.get('roughmate')) {if(user===workspace.ownerId) links.push(`<li>${wikiAnchor('/wiki/bots/'+archived.entry.id,archived.entry.name)}</li>`);continue;}
        const config=await resolved.store.group({environmentId:string(archived.entry.secretArn),appId:string(archived.entry.appId),teamId:workspace.teamId});
        if(!resolved.archived || config.lifecycle!=='archived') throw new AppError('registration_boundary');
        const catalog=await resolved.store.manualKnowledge(config),root=await resolved.store.wiki.root(config),access=new WikiBrowserAccess(authenticated.client,config,user,undefined,budget),history=new WikiHistoryAccess(resolved.store,config,root,catalog,access);
        const pages=answerBot ? []:await visiblePages(root.pages,history,visibility);
        let visible=pages.length>0;
        if(!visible) {
          let incomplete=false;
          const answers=await resolved.store.wiki.history(config,answerBot ? answerCursor:undefined);
          for(const answer of answers.items) {
            try {await history.answer({id:answer.id,version:answer.version,hash:answer.hash});visible=true;break;}
            catch(error) {if(!unavailable(error)) throw error;if(error instanceof AppError && ['wiki_membership_incomplete','wiki_history_incomplete'].includes(error.code)) {visibility.incomplete=true;incomplete=true;}}
          }
          if(!visible && answers.next) links.push(`<li>${wikiAnchor('/wiki/archives?'+new URLSearchParams({answerBot:archived.entry.id,answerCursor:answers.next}),'回答履歴の続きを確認')}</li>`);
          if(!visible && incomplete && !answerBot) links.push(`<li>${wikiAnchor('/wiki/archives?'+new URLSearchParams({answerBot:archived.entry.id}),'回答履歴の所属を再確認')}</li>`);
        }
        if(visible) links.push(`<li>${wikiAnchor('/wiki/bots/'+archived.entry.id,config.name+' (@'+archived.entry.botName+')')}</li>`);
      }
      return response(wikiLayout('Botアーカイブ',`${incompleteNotice()}<p>Wikiと確定回答を読み取り専用で参照できます。</p><ul>${links.join('')}</ul>${listing.next ? wikiAnchor('/wiki/archives?cursor='+encodeURIComponent(listing.next),'次のアーカイブ'):''}${answerBot ? wikiAnchor('/wiki/archives','アーカイブ一覧へ戻る'):''}`));
    }
    const route=/^\/wiki\/(root|bots\/([a-f0-9]{32}))(.*)$/.exec(event.rawPath);
    if(!route || !['GET','POST'].includes(method)) return response(wikiLayout('ページを開けません','<p>Slack HomeからWikiを開き直してください。</p>'),404);
    const base='/wiki/'+route[1],tail=route[3] || '',resolved=route[2] ? await maintenance.browserBot(route[2]):undefined,store=resolved?.store ?? registrations.root;
    const identity={environmentId:resolved ? string(resolved.entry.secretArn):env('SECRET_ARN'),appId:resolved ? string(resolved.entry.appId):secrets.appId,teamId:workspace.teamId};
    const contextCsrf=hashText(authenticated.csrf+base+identity.environmentId+identity.appId);
    const rawConfig=await store.get('roughmate');
    if(!rawConfig && resolved?.archived===true && user===workspace.ownerId) return response(wikiLayout(string(resolved!.entry.name),'<p>削除したBotのアーカイブです。このBotにはWikiと確定回答がありません。</p>'));
    const config=await store.group(identity),root=await store.wiki.root(identity),catalog=await store.manualKnowledge(identity);
    const archived=resolved?.archived===true;
    if(archived && config.lifecycle!=='archived' || !archived && config.lifecycle==='archived') throw new AppError('registration_boundary');
    let activeBot;
    if(!archived && !config.lifecycle) {
      const installed=requireInstalledSecrets(resolved ? await store.readSecrets():secrets);
      if(installed.appId!==identity.appId || installed.appId!==config.appId) throw new AppError('registration_boundary');
      activeBot=slackClient(installed.botToken,signal);
      await requireBotIdentity(activeBot,config.teamId,installed.botUserId);
    }
    const access=new WikiBrowserAccess(authenticated.client,config,user,activeBot),history=new WikiHistoryAccess(store,config,root,catalog,access);
    const admin=!archived && !config.lifecycle && config.adminIds.includes(user);
    const notice=archived ? '<p class="notice">削除したBotのアーカイブです。編集・相談・送信はできません。設定済みの保存期限は継続します。</p>':config.lifecycle ? '<p class="notice">Botは停止しています。削除結果は登録窓口のSlack Homeで確認してください。</p>':'';
    const output=(title:string,body:string)=>response(wikiLayout(title,notice+incompleteNotice()+body,base));
    if(method==='POST') {
      const values=readForm(event);requireWikiCsrf(event,string(values.get('csrf')),contextCsrf,baseUrl);requireRunningGroup(config);
      if(!admin || tail!=='/maintain') throw new AppError('forbidden');
      const command:WikiMaintenanceCommand={requestId:string(values.get('requestId')),actorId:user,configVersion:number(values.get('configVersion') ?? undefined),wikiVersion:number(values.get('wikiVersion') ?? undefined),operation:string(values.get('operation')) as WikiMaintenanceCommand['operation'],...(values.has('pageId') ? {pageId:string(values.get('pageId')),pageHash:string(values.get('pageHash'))}:{}),...(values.has('otherId') ? {otherId:string(values.get('otherId'))}:{}),...(values.has('proposalKey') ? {proposalKey:string(values.get('proposalKey'))}:{}),...(values.has('title') ? {title:string(values.get('title')),body:string(values.get('body'))}:{}),...(values.has('proposalHash') ? {proposalHash:string(values.get('proposalHash'))}:{})};
      if(command.proposalKey) {
        const checkpoint=await store.wiki.get<WikiCheckpoint>(command.proposalKey);
        if(checkpoint?.approval) {
          if(!activeBot) throw new AppError('bot_stopped');
          const policies=values.has('editProposal') ? checkpoint.targets!.map((_,index)=>string(values.get('policy_'+index))):undefined;
          const origin=await acceptBrowserProposalView(store,config,authenticated.session,contextCsrf,{...command,proposalKey:command.proposalKey,proposalHash:string(command.proposalHash)},values.has('editProposal'));
          const key=await acceptWikiAdoption(store,config,user,command.proposalKey,string(command.proposalHash),command.operation as 'confirm'|'reject',origin,policies);
          const location=base+'/adoption?key='+encodeURIComponent(key);
          try {await enqueueWikiAdoption(config,route[2],user,key);}
          catch {
            return {...output('Wiki更新指示の受付','<p>指示は保存済みで、検査・更新待ちです。配送結果を確認できません。再採用せず、処理結果を確認し、Homeの「今すぐ同期」で同じ指示を再開してください。</p>'),headers:{...headers,'x-wiki-location':location}};
          }
          return {statusCode:200,headers:{...headers,'x-wiki-location':location},body:''};
        }
      }
      await maintainWiki(store,config,catalog,history,command);return {statusCode:200,headers:{...headers,'x-wiki-location':base+'?saved=1'},body:''};
    }
    if(!tail || tail==='/') {
      const cursor=event.queryStringParameters?.cursor ? number(event.queryStringParameters.cursor):0;
      if(cursor>root.pages.length) throw new AppError('invalid_input');
      const pages=await visiblePages(root.pages.slice(cursor,cursor+6),history,visibility);
      const next=cursor+6<root.pages.length ? wikiAnchor(base+'?cursor='+(cursor+6),'次のページ'):'';
      return output(config.name,`<p>原資料と確定回答を整理した、このBot専用のWikiです。</p>${event.queryStringParameters?.saved==='1' ? '<p class="notice">変更を保存しました。</p>':''}<ul>${pages.map(page=>`<li>${wikiAnchor(base+'/pages/'+pageSlug(page),page.title)}${page.status==='review' ? '（要確認）':''}</li>`).join('')}</ul>${next}${pages.length || visibility.incomplete ? '':'<p>閲覧できるWikiページはまだありません。管理者はSlack Homeから資料を追加・同期してください。</p>'}<p>${wikiAnchor(base+'/answers','確定回答の履歴')}</p><p>${wikiAnchor(base+'/proposals','要確認・容量保留の更新案')}</p>`);
    }
    const pageRoute=/^\/pages\/([a-f0-9]{16}_[a-zA-Z0-9_-]{1,48})(?:\/(edit|merge))?$/.exec(tail);
    if(pageRoute) {
      const page=root.pages.find(item=>pageSlug(item)===pageRoute[1]);if(!page) throw new AppError('forbidden');
      await history.page(page);
      const visible=await visiblePages(root.pages,history,visibility);
      if(pageRoute[2]) {
        if(!admin || page.status!=='ready') throw new AppError('forbidden');
        const merge=pageRoute[2]==='merge';
        const fields={csrf:contextCsrf,requestId:'wiki-maintenance#'+randomBytes(16).toString('hex'),configVersion:String(config.version),wikiVersion:String(root.version),operation:merge ? 'merge':'edit',pageId:page.id,pageHash:wikiContentHash(page)};
        return output(merge ? 'Wikiページを統合':'Wiki本文を編集',`<p>元の出典と閲覧範囲を保持します。追加の原情報はSlackの資料追加から登録してください。</p><form method="post" action="${html(base+'/maintain')}">${form(fields)}${merge ? `<label>統合するページ<select name="otherId">${visible.filter(item=>item.status==='ready' && pageSlug(item)!==pageSlug(page)).map(item=>`<option value="${html(pageSlug(item))}">${html(item.title)}</option>`).join('')}</select></label>`:''}<label>タイトル<input type="text" name="title" maxlength="120" required value="${html(page.title)}"></label><label>本文<textarea name="body" required>${html(page.body)}</textarea></label><button type="submit">保存する</button></form>`);
      }
      const sourceLinks=page.citations.map(citation=>wikiAnchor(base+'/source?'+new URLSearchParams({id:citation.id,version:String(citation.version),hash:citation.hash}),'出典 v'+citation.version)).join(' ・ ');
      return output(page.title,`<p>${page.status==='review' ? '要確認の更新案です。':!pageAdopted(page) ? '管理者の採用前の保存内容です。通常回答への利用を保留しています。':'確認済みの知識です。'}${page.human ? ` 最終確認者: ${html(page.human.actorId)} / ${html(page.human.at)}`:''}</p><article>${renderWikiBody(page.body,page,visible,base)}</article><p>${sourceLinks}</p><h2>関連ページ</h2><ul>${page.relatedIds.map(id=>visible.find(item=>item.id===id && item.scope===page.scope) ?? visible.find(item=>item.id===id)).map(item=>item ? `<li>${wikiAnchor(base+'/pages/'+pageSlug(item),item.title)}</li>`:'<li>閲覧できない、または存在しないリンク</li>').join('')}</ul>${admin && page.status==='ready' ? `<p>${wikiAnchor(base+'/pages/'+pageSlug(page)+'/edit','本文を編集')} ・ ${wikiAnchor(base+'/pages/'+pageSlug(page)+'/merge','他のページと統合')}</p>`:''}`);
    }
    if(tail==='/source') {
      const q=event.queryStringParameters,citation:Citation={id:string(q?.id),version:number(q?.version),hash:string(q?.hash)};
      await history.citation(citation);
      if(citation.id.startsWith('wiki-answer#')) {
        const answer=await history.answer(citation);return output('出典：確定回答',`<h2>元の質問</h2><pre>${html(answerQuestion(answer) || '元質問は取得されていません。')}</pre><h2>AIの下書き</h2><pre>${html(answer.draft)}</pre><h2>最終回答</h2><pre>${html(answer.answer)}</pre><p>採用者: ${html(answer.actorId)} / 送信日時: ${html(answer.sentAt)}</p><p>送信済み投稿: ${html(answer.answerTs)}</p>`);
      }
      let original:SourceRecord|undefined;
      if(citation.id.startsWith('manual:')) original=await history.manualOriginal(citation.id.slice(7),citation.version);
      else {
        const match=/^url:([a-zA-Z0-9_-]+):([a-f0-9]{24})$/.exec(citation.id);
        if(match) original=await history.urlOriginal(match[1],match[2],citation.version);
      }
      if(!original) throw new AppError('missing_wiki_source');
      return output(original.title,`<p>原資料 v${citation.version}</p><pre>${html(original.raw)}</pre>${original.url ? wikiAnchor(original.url,'公開元のページ'):''}`);
    }
    if(tail==='/answers') {
      const listing=await store.wiki.history(config,event.queryStringParameters?.cursor),items:string[]=[];
      for(const answer of listing.items) {
        try {await history.answer({id:answer.id,version:answer.version,hash:answer.hash});items.push(`<li>${wikiAnchor(base+'/source?'+new URLSearchParams({id:answer.id,version:String(answer.version),hash:answer.hash}),answer.sentAt+' の確定回答')}</li>`);} catch(error) {if(!unavailable(error)) throw error;}
      }
      return output('確定回答の履歴',`<ul>${items.join('')}</ul>${listing.next ? wikiAnchor(base+'/answers?cursor='+encodeURIComponent(listing.next),'次の履歴'):''}`);
    }
    if(tail==='/history') {
      let version=event.queryStringParameters?.version ? number(event.queryStringParameters.version):root.previousVersion;
      let unverified=false;
      const entries:string[]=[];
      for(let count=0;version && count<5;count++) {
        const snapshot=await history.snapshot(version);if(!snapshot) throw new AppError('missing_wiki_version');requireIdentity(snapshot,config);
        if(!snapshot.verified) {unverified=true;version=snapshot.previousVersion;continue;}
        if(snapshot.pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(snapshot.pages))>wikiLimits.wikiBytes || snapshot.previousVersion!==undefined && snapshot.previousVersion>=version) throw new AppError('invalid_wiki');
        const pages=await visiblePages(snapshot.pages,history,visibility);
        for(const page of pages) entries.push(`<li>${wikiAnchor(base+'/history/'+version+'/'+pageSlug(page),page.title+' / 版 '+version)}</li>`);
        version=snapshot.previousVersion;
      }
      return output('Wiki変更履歴',`${unverified ? '<p class="notice">完全性を検証できない旧版は表示できません。</p>':''}<ul>${entries.join('')}</ul>${version ? wikiAnchor(base+'/history?version='+version,'次の履歴'):''}`);
    }
    const old=/^\/history\/(\d+)\/([a-f0-9]{16}_[a-zA-Z0-9_-]{1,48})$/.exec(tail);
    if(old) {
      const snapshot=await history.snapshot(number(old[1]));if(!snapshot) throw new AppError('forbidden');requireIdentity(snapshot,config);
      if(!snapshot.verified) throw new AppError('forbidden');
      const page=snapshot.pages.find(item=>pageSlug(item)===old[2]);if(!page) throw new AppError('forbidden');await history.page(page);
      const visible=await visiblePages(snapshot.pages,history,visibility);
      return output(page.title+' / 版 '+old[1],`<article>${renderWikiBody(page.body,page,visible,base)}</article><p>${page.citations.map(citation=>wikiAnchor(base+'/source?'+new URLSearchParams({id:citation.id,version:String(citation.version),hash:citation.hash}),'出典 v'+citation.version)).join(' ・ ')}</p>`);
    }
    if(tail==='/adoption') {
      const key=string(event.queryStringParameters?.key);
      if(!/^wiki-proposal#submission-[a-f0-9]{32}$/.test(key)) throw new AppError('invalid_input');
      const receipt=await store.wiki.get<WikiAdoption>(key);
      if(!receipt) throw new AppError('forbidden');requireIdentity(receipt,config);
      if(!receipt.approval || receipt.result?.status==='failed') {
        if(!admin) throw new AppError('forbidden');
        await access.require({channelIds:[],reviewChannelIds:[string(config.reviewChannelId)]});
        const reason=wikiUpdateFailureText(receipt.result?.failureReason) || (receipt.result?.failureCode==='wiki_result_capacity_exceeded' ? '変更前後の履歴・保存ページ・最新比較を含む結果全体が保存容量の上限を超えるため停止しました。Wiki本文と採用した対象・方針は保持しています。':receipt.result?.failureCode==='wiki_target_review' ? '対象ページは要確認のため、部分採用では更新できません。ページの未解決事項を確認してください。':receipt.result?.failureCode==='wiki_prompt_too_large' ? '最新の同じ閲覧範囲の資料・Wikiを上限内で全件比較できないため停止しました。対象と方針は保持しています。':'対象・根拠・権限・期限または生成結果を確認できませんでした。別の対象へ自動で処理はしていません。');
        return output('Wiki更新処理を停止しました','<p>'+reason+'</p>');
      }
      requireWikiAdoption(receipt,config,receipt.command.actorId);
      const current=await requireAdoptionResultHistory(receipt,root,[history]);
      if(activeBot) {
        await requireAdoptionResultAccess(store,activeBot,config,receipt);
      }
      const status=receipt.result?.status==='applied' ? '採用した方針をWikiへ反映しました。':receipt.result?.status==='unchanged' ? '最新Wikiに反映済みです。本文の変更はありません。':receipt.result?.status==='rejected' ? '見送りました。Wikiは保持しました。':'採用指示を受け付けました。検査・更新待ち、または処理中です。';
      return output('Wiki更新の処理結果',`<p>${status}</p><p>${receipt.result?.status==='rejected' ? '見送り判断者':'採用者'}: ${html(receipt.command.actorId)} / 受付日時: ${html(receipt.acceptedAt)}${receipt.result ? ' / 結果日時: '+html(receipt.result.at):''}</p>`+receipt.targets!.map((target,index)=>{
        const changes=receipt.result?.changes.filter(change=>change.target===index) ?? [];
        const path=proposalPagePath(config,{...receipt,pk:receipt.command.proposalKey},{...target,isNew:target.isNew && !changes.length});
        const page=current.find(page=>page.id===target.id && page.scope===target.scope);
        return `<h2>${html(page ? page.title:target.title)}</h2><p>更新箇所: ${html(target.headingPath.join(' / ') || '本文')}</p><p>${wikiAnchor(path,'Wiki・保存済み提案')}</p><h3>${receipt.result?.status==='rejected' ? '見送った方針':'採用方針'}</h3><pre>${html(target.policy)}</pre>`+changes.map(change=>`<h3>実際の変更前</h3><pre>${html(change.before)}</pre><h3>実際の変更後</h3><pre>${html(change.after)}</pre>`).join('');
      }).join(''));
    }
    if(tail==='/proposals') {
      let key=event.queryStringParameters?.cursor ?? root.proposalHead;const entries:string[]=[];
      for(let count=0;key && count<5;count++) {
        if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AppError('invalid_input');
        const checkpoint=await store.wiki.get<WikiCheckpoint & {status?:string}>(key);if(!checkpoint) throw new AppError('missing_wiki_proposal');requireIdentity(checkpoint,config);
        if(!checkpoint.status) {
          requireWikiPages(checkpoint.pages);if(checkpoint.pagesHash!==undefined && checkpoint.pagesHash!==wikiContentHash(checkpoint.pages)) throw new AppError('invalid_wiki');
          if(checkpoint.approval) {try {await requireAnswerProposal(store,config,catalog,root,checkpoint,history);} catch(error) {if(error instanceof AppError && ['wiki_comparison_changed','wiki_conflict','wiki_evidence_changed'].includes(error.code)) {key=checkpoint.previousProposalKey;continue;}if(!unavailable(error)) throw error;key=checkpoint.previousProposalKey;continue;}}
          if(checkpoint.approval) {entries.push(`<li>${wikiAnchor(base+'/proposal?key='+encodeURIComponent(key),checkpoint.targets!.map(target=>target.title).join(' / '))}</li>`);key=checkpoint.previousProposalKey;continue;}
          const pages=await visiblePages(checkpoint.pages,history,visibility);
          if(pages.length===checkpoint.pages.length && (pages.length || await emptyProposalVisible(checkpoint,root,catalog,history))) entries.push(`<li>${wikiAnchor(base+'/proposal?key='+encodeURIComponent(key),pages.map(page=>page.title).join(' / ') || '原資料の比較を確認')}</li>`);
        }
        key=checkpoint.previousProposalKey;
      }
      return output('要確認・容量保留の更新案',`<p>原資料と正式ページの比較で確認が必要な案です。既存の正式ページは保持されています。</p><ul>${entries.join('')}</ul>${key ? wikiAnchor(base+'/proposals?cursor='+encodeURIComponent(key),'次の更新案'):''}`);
    }
    if(tail==='/proposal') {
      const key=string(event.queryStringParameters?.key);if(!/^wiki-proposal#[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new AppError('invalid_input');
      const checkpoint=await store.wiki.get<WikiCheckpoint & {status?:string}>(key);if(!checkpoint || checkpoint.status) throw new AppError('forbidden');requireIdentity(checkpoint,config);requireWikiPages(checkpoint.pages);if(checkpoint.pagesHash!==undefined && checkpoint.pagesHash!==wikiContentHash(checkpoint.pages)) throw new AppError('invalid_wiki');
      if(checkpoint.approval) {
        const answer=await store.wiki.get<AnswerRecord>(checkpoint.inputId!),adoptedKey=answer?.work.proposalKey===key ? answer.work.adoptionKey:undefined;
        const receipt=adoptedKey ? await store.wiki.get<WikiAdoption>(adoptedKey):undefined;
        if(receipt) requireWikiAdoption(receipt,config,receipt.command.actorId);
        const completed=!!receipt?.result;
        await requireAnswerProposal(store,config,catalog,root,checkpoint,history,undefined,undefined,adoptedKey,completed);
        if(activeBot) {
          await requireAnswerProposal(store,config,catalog,root,checkpoint,new WikiHistoryAccess(store,config,root,catalog,new ChannelAudience(activeBot,config,[string(config.reviewChannelId)])),undefined,undefined,adoptedKey,completed);
          if(completed) await requireAdoptionResultAccess(store,activeBot,config,receipt!);
        }
        const editable=admin && !adoptedKey && event.queryStringParameters?.edit==='1';
        const fields=async(operation:'confirm'|'reject')=>form({csrf:contextCsrf,requestId:await createBrowserProposalView(store,config,authenticated.session,contextCsrf,key,answerProposalHash(checkpoint),operation,editable),configVersion:String(config.version),wikiVersion:String(root.version),operation,proposalKey:key,proposalHash:answerProposalHash(checkpoint)});
        const changes=checkpoint.targets!.map(target=>{
          const current=root.pages.find(page=>page.id===target.id && page.scope===target.scope),before=adoptedKey ? target.before:current ? wikiSection(current.body,target.headingPath).text:'';
          return `<h2>${html(adoptedKey ? target.title:current?.title ?? target.title)}${target.isNew ? '（新規ページ / FAQ / 関連ページなし）':''}</h2><p>更新箇所: ${html(target.headingPath.join(' / ') || '本文')}</p><p>${wikiAnchor(proposalPagePath(config,checkpoint,target),target.isNew ? '保存済み提案':'現在のWikiページ')}</p><h3>${adoptedKey ? '提案時の該当記述':'現在の該当記述'}</h3><pre>${html(before || '記述なし')}</pre><h3>反映する知識</h3><pre>${html(target.knowledge)}</pre><h3>更新方針</h3><pre>${html(target.policy)}</pre><h3>根拠・適用範囲</h3><pre>${html(target.rationale)}</pre>`;
        }).join('');
        const sources=checkpoint.approval.comparisonCitations.map(citation=>wikiAnchor(base+'/source?'+new URLSearchParams({id:citation.id,version:String(citation.version),hash:citation.hash}),'出典 v'+citation.version)).join(' ・ ');
        const editor=editable ? `<form method="post" action="${html(base+'/maintain')}">${await fields('confirm')}${form({editProposal:'1'})}${checkpoint.targets!.map((target,index)=>`<label>更新方針 ${index+1}<textarea name="policy_${index}" required>${html(target.policy)}</textarea></label>`).join('')}<button type="submit">方針を編集して採用</button></form>`:'';
        let controls='';
        if(admin && !adoptedKey && !editable) {
          for(const operation of ['confirm','reject'] as const) controls+=`<form method="post" action="${html(base+'/maintain')}">${await fields(operation)}<button type="submit">${operation==='confirm' ? '採用':'見送り'}</button></form>`;
          controls+=`<p>${wikiAnchor(base+'/proposal?'+new URLSearchParams({key,edit:'1'}),'方針を編集して採用')}</p>`;
        }
        return output('Wiki更新箇所・方針を確認',`<p>${adoptedKey ? '判断済みの保存提案です。'+wikiAnchor(adoptionPath(config,adoptedKey),'採用した方針と実際の処理結果'):'採用受付後にAIが最新Wikiを読み、採用した対象・方針の範囲で更新します。'}</p><p>根拠: ${sources}</p>`+changes+(editable ? editor:controls));
      }
      if(!checkpoint.pages.length && !await emptyProposalVisible(checkpoint,root,catalog,history)) throw new AppError('forbidden');
      for(const page of checkpoint.pages) await history.page(page);
      const citations=[...new Map([...checkpoint.pages.flatMap(page=>page.citations),...[]].map(citation=>[JSON.stringify([citation.id,citation.version,citation.hash]),citation])).values()];
      if(!citations.length) {
        const source=root.sources.find(item=>item.work.proposalKey===key),manual=root.manualJobs?.find(item=>item.work.proposalKey===key),document=manual && catalog.documents.find(item=>item.id===manual.id);
        if(source?.hash) citations.push({id:`url:${source.id}:${source.revision}`,version:source.version,hash:source.hash});
        else if(document) citations.push({id:`manual:${document.id}`,version:document.version,hash:hashText(document.body)});
        else if(checkpoint.inputId) {const answer=await history.archived(checkpoint.inputId);if(answer) citations.push(answerCitation(answer));}
      }
      const comparisonCounts=(['consistent','conflict','unresolved'] as const).map(relation=>({relation,count:checkpoint.comparisons?.filter(comparison=>comparison.relation===relation).length ?? 0}));
      const comparisonSummary=`<p>モデルの比較: 一致 ${comparisonCounts[0].count}件 / 相違 ${comparisonCounts[1].count}件 / 判断できない ${comparisonCounts[2].count}件。採用する前に出典と現在の正式ページを確認してください。</p>`;
      const sourceLinks=citations.map(citation=>wikiAnchor(base+'/source?'+new URLSearchParams({id:citation.id,version:String(citation.version),hash:citation.hash}),'出典 v'+citation.version)).join(' ・ ');
      const fields=(operation:string)=>form({csrf:contextCsrf,requestId:'wiki-maintenance#'+randomBytes(16).toString('hex'),configVersion:String(config.version),wikiVersion:String(root.version),operation,proposalKey:key});
      const controls=admin ? ['confirm','reject'].map(operation=>`<form method="post" action="${html(base+'/maintain')}">${fields(operation)}<button type="submit">${operation==='confirm' ? '採用':'見送り'}</button></form>`).join(''):'';
      return output('更新案を確認',comparisonSummary+`<p>根拠：${sourceLinks}</p>`+(checkpoint.pages.length ? '':'<p>新しいWiki本文はありません。原資料の比較結果を確認してください。</p>')+checkpoint.pages.map(page=>`<h2>${html(page.title)}</h2><pre>${html(page.body)}</pre>`).join('')+controls);
    }
    return response(wikiLayout('ページを開けません','<p>目次からページを選び直してください。</p>',base),404);
  } catch(error) {
    const code=error instanceof AppError ? error.code:diagnosticCode(error);
    if(['wiki_login_required','wiki_device_required'].includes(code) && method==='GET' && !event.rawPath.includes('/auth/')) return response(wikiLayout('Slackで本人確認',`<p>現在のSlack所属を確認してWikiを表示します。</p><p>${wikiAnchor('/wiki/login?return='+encodeURIComponent(event.rawPath+(event.rawQueryString ? '?'+event.rawQueryString:'')),'Slackでログイン')}</p>`),401);
    const retry=['wiki_conflict','wiki_comparison_changed','wiki_evidence_changed','registration_conflict','wiki_processing'].includes(code);
    return response(wikiLayout(retry ? '内容を再確認してください':'Wikiを開けません',`<p>${retry ? '資料またはWikiが更新されました。最新のページを開き直して、内容を確認してから再操作してください。':code==='wiki_capacity' ? '保存容量に収まりません。既存ページと更新案は保持しています。本文を短くするか、不要な重複を統合してください。':code==='bot_stopped' ? 'Botは停止しています。アーカイブは読み取り専用です。':code==='wiki_login_required' || code==='wiki_device_required' || code==='invalid_state' ? '本人確認の期限が切れたか、認証を確認できません。Slack HomeからWikiを開き直してください。':'閲覧権限または資料の有効性を確認できません。Slack HomeからWikiを開き直してください。'}</p>`),retry ? 409:unavailable(error) ? 404:code==='wiki_login_required' || code==='wiki_device_required' ? 401:400);
  }
}
function readForm(event:APIGatewayProxyEventV2):URLSearchParams {
  if(!event.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new AppError('invalid_input');
  const raw=event.isBase64Encoded ? Buffer.from(string(event.body),'base64').toString('utf8'):string(event.body);
  if(Buffer.byteLength(raw)>wikiLimits.wikiBytes*3+16384) throw new AppError('invalid_input');
  const values=new URLSearchParams(raw);for(const key of values.keys()) if(values.getAll(key).length!==1) throw new AppError('invalid_input');return values;
}

async function emptyProposalVisible(checkpoint:WikiCheckpoint,root:WikiRoot,catalog:import('./groups.js').KnowledgeCatalog,history:WikiHistoryAccess):Promise<boolean> {
  const key=checkpoint.pk;
  if(checkpoint.inputId?.startsWith('wiki-answer#')) {try{const record=await history.archived(checkpoint.inputId);if(!record)return false;const answer=await history.answer({id:record.id,version:record.version,hash:record.hash});return answer.work.proposalKey===key && comparisonCitation(answerCitation(answer),root,catalog,Date.now());}catch(error){if(unavailable(error))return false;throw error;}}
  const source=root.sources.find(item=>item.work.proposalKey===key),manual=root.manualJobs?.find(item=>item.work.proposalKey===key),document=manual && catalog.documents.find(item=>item.id===manual.id);
  const citation=source?.hash ? {id:`url:${source.id}:${source.revision}`,version:source.version,hash:source.hash}:document ? {id:`manual:${document.id}`,version:document.version,hash:hashText(document.body)}:undefined;
  if(!citation || source && source.work.proposalBoundary===undefined) return false;
  try {await history.citation(citation);return comparisonCitation(citation,root,catalog,Date.now());} catch(error) {if(unavailable(error)) return false;throw error;}
}
