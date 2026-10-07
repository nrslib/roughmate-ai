import { BotMaintenance } from './bot-maintenance.js';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import type { WebClient } from '@slack/web-api';
import { AppError, env, object, string, requireInstalledSecrets } from './contracts.js';
import { Storage, requireSettingsExpiry } from './storage.js';
import { Registrations } from './registration.js';
import { authorizeWorkspace } from './security.js';
import { requireIdentity, requireAdmin } from './groups.js';
import { slackClient, publishHome, requireBotIdentity } from './slack.js';
import { wikiHomeBlocks, wikiView, wikiMembershipNotice, wikiHistoryNotice } from './wiki-ui.js';
import { processWiki, applyWikiCommand, type WikiReceipt } from './wiki-worker.js';
import { enqueueWiki } from './wiki-queue.js';
import { publishAnswerProposal, answerProposalView, applyProposalSubmission, proposalActions } from './wiki-proposal-slack.js';
import { diagnosticCode } from './diagnostics.js';
import type { WikiAdoption } from './wiki-adoption.js';
import type { AnswerRecord } from './wiki-model.js';

async function processJob(raw:string):Promise<void> {
  const job=object(JSON.parse(raw));
  if(!['wiki','wiki_ui','wiki_command','wiki_adoption','wiki_archive_retention'].includes(string(job.kind))) throw new AppError('invalid_input');
  const payload=object(job.payload),signal=AbortSignal.timeout(105000);
  const registrations=new Registrations(env('TABLE_NAME'),env('SECRET_ARN'),signal);
  if(job.kind==='wiki_archive_retention') {
    const id=string(job.botId),maintenance=new BotMaintenance(registrations,signal),archived=await maintenance.archive(id),resolved=await maintenance.browserBot(id);
    if(!resolved.archived) throw new AppError('registration_boundary');
    const identity={environmentId:string(archived.entry.secretArn),appId:string(archived.entry.appId),teamId:archived.entry.teamId};requireIdentity(payload as unknown as typeof identity,identity);
    const config=await resolved.store.group(identity);
    if(config.lifecycle!=='archived' || config.stopId!==archived.entry.deletion?.id) throw new AppError('registration_boundary');
    if(payload.step!==undefined && (typeof payload.step!=='number' || !Number.isSafeInteger(payload.step) || payload.step<0)) throw new AppError('invalid_input');
    await resolved.store.wiki.purgeArchiveHistory(config,payload.step as number|undefined);
    return;
  }
  if(job.botId!==undefined) {
    const registry=await registrations.read(),id=string(job.botId),entry=registry.entries.find(item=>item.id===id);
    if(entry?.deletion) {requireIdentity(payload as unknown as import('./groups.js').GroupIdentity,{environmentId:string(entry.secretArn),appId:string(entry.appId),teamId:entry.teamId});return;}
    if(!entry) {const archived=await new BotMaintenance(registrations,signal).archive(id);requireIdentity(payload as unknown as import('./groups.js').GroupIdentity,{environmentId:string(archived.entry.secretArn),appId:string(archived.entry.appId),teamId:archived.entry.teamId});return;}
  }
  const child=job.botId===undefined ? undefined:await registrations.child(string(job.botId),true);
  const store=child?.store ?? new Storage(env('TABLE_NAME'),env('SECRET_ARN'),signal);
  const workspace=await store.workspace();authorizeWorkspace(workspace,string(payload.teamId));
  const secrets=requireInstalledSecrets(await store.readSecrets());
  const identity={environmentId:child ? string(child.entry.secretArn):env('SECRET_ARN'),appId:secrets.appId,teamId:workspace.teamId};
  requireIdentity(payload as unknown as typeof identity,identity);
  const client=slackClient(secrets.botToken,signal);
  await requireBotIdentity(client,workspace.teamId,secrets.botUserId);
  const config=await store.group(identity);
  if(config.lifecycle) return;
  switch(job.kind) {
    case 'wiki': {
      const key=string(payload.key);
      if(key.startsWith('pending:')) {
        const page=await store.wiki.pending(config,key.slice('pending:'.length));
        for(const task of page.keys) await enqueueWiki(identity,job.botId,task);
        if(page.next!==undefined) await enqueueWiki(identity,job.botId,`pending:${page.next}`);
      } else if(key.startsWith('legacy-pending:')) {
        throw new AppError('wiki_task_index_unsupported');
      } else if(key.startsWith('retention:')) {
        const next=await store.wiki.purgeHistory(config,key.slice('retention:'.length));
        if(next) await enqueueWiki(identity,job.botId,`retention:${next}`);
      } else {
        const answer=key.startsWith('wiki-answer#') ? await store.wiki.get<AnswerRecord>(key):undefined;
        if(answer?.work.adoptionKey) {
          requireIdentity(answer,config);
          const receipt=await store.wiki.get<WikiAdoption>(answer.work.adoptionKey);
          if(!receipt?.approval) {
            if(answer.work.status==='review') {
              const root=await store.wiki.root(config),catalog=await store.knowledge(config);
              await store.wiki.save(config,root,{...root,version:root.version+1},[{item:{...answer,work:{...answer.work,status:'failed',failureCode:receipt ? 'wiki_retention_expired':'missing_wiki_adoption'}},work:answer.work}],{catalogVersion:catalog.version,workOnly:true});
            }
            break;
          }
          requireIdentity(receipt,config);
          if(receipt.inputId!==key || receipt.command.proposalKey!==answer.work.proposalKey) throw new AppError('forbidden');
          await applyProposalSubmission(store,client,config,receipt.command.actorId,receipt.pk);
        } else {await processWiki(store,config,key,client);if(answer) await publishAnswerProposal(store,client,config,key);}
      }
      break;
    }
    case 'wiki_ui': {
      let view:Parameters<WebClient['views']['update']>[0]['view'];
      try { view=proposalActions.includes(String(payload.action) as typeof proposalActions[number]) ? await answerProposalView(store,client,config,string(payload.userId),string(payload.action),string(payload.value),string(payload.viewId),{channel:string(payload.channelId),ts:string(payload.messageTs)}):await wikiView(store,client,config,string(payload.userId),string(payload.action),typeof payload.value==='string' ? payload.value:''); }
      catch(error) {
        if(!(error instanceof AppError)) throw error;
        view={type:'modal',title:{type:'plain_text',text:'専用Wiki'},close:{type:'plain_text',text:'閉じる'},blocks:[{type:'section',text:{type:'plain_text',text:error.code==='wiki_membership_incomplete' ? wikiMembershipNotice : error.code==='wiki_history_incomplete' ? wikiHistoryNotice : 'この資料を閲覧できないか、資料・設定が更新されています。Homeから一覧を開き直してください。'}}]};
      }
      try { await client.views.update({view_id:string(payload.viewId),hash:string(payload.viewHash),view}); }
      catch(error) {if(!['slack_hash_conflict','slack_not_found'].includes(diagnosticCode(error))) throw error;}
      break;
    }
    case 'wiki_adoption': {
      await applyProposalSubmission(store,client,config,string(payload.userId),string(payload.key));
      break;
    }
    case 'wiki_command': {
      let receipt=await store.get<WikiReceipt>(`wiki-command#${string(payload.requestId)}`);
      if(!receipt || receipt.command.actorId!==payload.userId) throw new AppError('forbidden');
      requireIdentity(receipt,identity);
      if(receipt.work.status==='pending') {
        try { requireSettingsExpiry(receipt.commandExpiresAt);requireAdmin(config,receipt.command.actorId);await applyWikiCommand(store,client,config,receipt); }
        catch(error) {
          if(error instanceof AppError && error.code==='forbidden') throw error;
          const current=await store.get<WikiReceipt>(receipt.pk);
          if(current?.work.status!=='ready') {
            const root=await store.wiki.root(config);
            if(!(error instanceof AppError) || error.code==='wiki_conflict' && root.version===receipt.command.wikiVersion && config.version===receipt.command.configVersion || error.code==='wiki_processing') throw error;
            await store.wiki.save(config,root,{...root,version:root.version+1},[{item:{...receipt,work:{status:'failed',attempts:0,failureCode:error.code}},work:receipt.work}]);
          }
        }
        receipt=(await store.get<WikiReceipt>(receipt.pk))!;
      }
      requireAdmin(config,receipt.command.actorId);
      for(const key of receipt.tasks ?? []) await enqueueWiki(identity,job.botId,key);
      await publishHome(client,workspace,receipt.command.actorId,receipt.work.failureCode==='settings_request_expired' ? 'Wiki操作の受付期限が切れました。Homeから最新の内容を開き直し、もう一度操作してください。' : receipt.work.failureCode==='question_unavailable' ? '元質問を取得できないためWiki整理を停止しています。送信済み回答は回答集に保存しています。原文を確認できる状態になったら回答集から再処理してください。' : receipt.work.failureCode==='invalid_question_evidence' ? '元質問の投稿者・日時・スレッドを確認できないためWiki整理を再開していません。回答集の送信済み回答は保持しています。' : receipt.work.failureCode==='wiki_membership_incomplete' ? wikiMembershipNotice+' 同期操作は保存していません。資料一覧から範囲を確認してください。' : receipt.work.status==='failed' ? 'Wikiの操作を保存できませんでした。資料・権限・設定が更新された可能性があります。Homeから最新の内容を開き直してください。':'Wikiの操作を受け付けました。資料一覧と回答集で処理状況を確認できます。',config,wikiHomeBlocks(true));
      break;
    }
    default: throw new AppError('invalid_input');
  }
}
export async function handler(event:SQSEvent):Promise<SQSBatchResponse> {
  const failures:{itemIdentifier:string}[]=[];
  for(const record of event.Records) {
    try {await processJob(record.body);}
    catch(error) {process.stderr.write(JSON.stringify({event:'roughmate_wiki_worker_failed',code:diagnosticCode(error),messageId:record.messageId})+'\n');failures.push({itemIdentifier:record.messageId});}
  }
  return {batchItemFailures:failures};
}
