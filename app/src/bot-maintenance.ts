import { c, type DocumentOperation } from './document-store.js';
import { runtime } from './runtime.js';
import { randomBytes } from 'node:crypto';
import { ErrorCode, type View, type WebClient } from '@slack/web-api';
import { AppError, string, workerDrainSeconds } from './contracts.js';
import { authorizeOwner } from './security.js';
import { requireAdmin, requireIdentity, validateGroup, type GroupConfig } from './groups.js';
import { Registrations, childResources, type Registration, type Registry } from './registration.js';
import { Storage } from './storage.js';

export interface BotDeletion { id:string; actor:string; status:'queued'|'unknown'|'failed'; requestedAt:number; notBefore:number; configVersion?:number; failureCode?:string; checkedAt?:number; verifyAfter?:number; }
export interface BotArchive { pk:string; entry:Registration; rootOwner:string; parentSecret:string; deletedAt:string; next?:string; }
interface DeletionConfirmation { pk:string; botId:string; actor:string; teamId:string; rootAppId:string; targetAppId:string; payloadAppId:string; registryVersion:number; configVersion?:number; expiresAt:number; }
const deletionKey=(id:string)=>`bot-delete#${id}`;
export const archiveKey=(id:string)=>`bot-archive#${id}`;
function rootCheck(table:string,owner:string,team:string) {
  return {check:{namespace:table,key:{pk:'workspace'},condition: c.all(c.compare("ownerId","=",":owner"),c.compare("teamId","=",":team")),parameters:{':owner':owner,':team':team}}};
}
function registryPut(table:string,previous:Registry,next:Registry) {
  return {put:{namespace:table,item:next,condition: c.all(c.compare("#v","=",":v"),c.compare("parentSecret","=",":parent"),c.group(c.any(c.absent("homeNoticeUntil"),c.compare("homeNoticeUntil","<=",":now")))),fields:{'#v':'version'},parameters:{':v':previous.version,':parent':previous.parentSecret,':now':Math.floor(Date.now()/1000)}}};
}
export class BotMaintenance {
  private db=runtime().documents();
  constructor(private registrations:Registrations,private signal?:AbortSignal) {}
  private async target(registry:Registry,id:string,actor:string):Promise<{entry:Registration;config?:GroupConfig;store?:Storage}> {
    const [workspace,secrets]=await Promise.all([this.registrations.root.workspace(),this.registrations.root.readSecrets()]);
    authorizeOwner(workspace,workspace.teamId,actor);
    const entry=registry.entries.find(item=>item.id===id);
    if(!entry || registry.deleting || entry.actor!==actor || entry.teamId!==workspace.teamId || entry.parentAppId!==secrets.appId || !entry.appId || entry.appId===secrets.appId || !entry.secretArn || entry.installOwner && entry.phase!=='available' || entry.phase==='creating') throw new AppError('forbidden');
    const store=new Storage(childResources(this.registrations.parentTable,this.registrations.parentSecret,id).tableName,entry.secretArn,this.signal);
    const raw=await store.get<GroupConfig>('roughmate');
    const config=raw ? validateGroup(raw):undefined;
    if(config) requireIdentity(config,{environmentId:entry.secretArn,appId:entry.appId,teamId:entry.teamId});
    if(entry.phase==='available' && !config) throw new AppError('registration_boundary');
    if(config) {requireAdmin(config,actor);if(config.lifecycle==='archived') throw new AppError('forbidden');}
    return {entry,config,store};
  }
  async confirmation(botId:string,actor:string,payloadAppId:string):Promise<View> {
    const registry=await this.registrations.read(),{entry,config}=await this.target(registry,botId,actor);
    if(payloadAppId!==entry.parentAppId && payloadAppId!==entry.appId || entry.deletion && entry.deletion.status!=='failed') throw new AppError('forbidden');
    const id=randomBytes(16).toString('hex');
    const confirmation:DeletionConfirmation={pk:deletionKey(id),botId,actor,teamId:entry.teamId,rootAppId:entry.parentAppId,targetAppId:entry.appId!,payloadAppId,registryVersion:registry.version,...(config ? {configVersion:config.version}:{}),expiresAt:Math.floor(Date.now()/1000)+600};
    if(!await this.registrations.root.create({...confirmation})) throw new AppError('registration_conflict');
    return {type:'modal',callback_id:'delete_bot',private_metadata:id,title:{type:'plain_text',text:'Botを削除'},submit:{type:'plain_text',text:'停止して削除'},close:{type:'plain_text',text:'キャンセル'},blocks:[
      {type:'section',text:{type:'plain_text',text:`${entry.name} (@${entry.botName})\nSlack App ID: ${entry.appId}\nこの専用Slack Appを永久に削除します。新しい相談と送信を停止し、Wiki・原資料・確定回答・変更履歴を読み取り専用で残します。設定済みの保存期限は継続します。登録窓口Botは削除しません。`}}
    ]};
  }
  async accept(id:string,actor:string,teamId:string,payloadAppId:string):Promise<Registration> {
    if(!/^[a-f0-9]{32}$/.test(id)) throw new AppError('invalid_state');
    const [receipt,registry]=await Promise.all([this.registrations.root.get<DeletionConfirmation>(deletionKey(id)),this.registrations.read()]);
    if(!receipt || receipt.actor!==actor || receipt.teamId!==teamId || receipt.payloadAppId!==payloadAppId || receipt.expiresAt<=Math.floor(Date.now()/1000)) throw new AppError('forbidden');
    const {entry,config}=await this.target(registry,receipt.botId,actor);
    if(entry.deletion?.id===id) return entry;
    if(registry.version!==receipt.registryVersion || config?.version!==receipt.configVersion || entry.parentAppId!==receipt.rootAppId || entry.appId!==receipt.targetAppId || entry.deletion && entry.deletion.status!=='failed') throw new AppError('registration_conflict');
    const now=Math.floor(Date.now()/1000),deletion:BotDeletion={id,actor,status:'queued',requestedAt:now,notBefore:now+workerDrainSeconds,...(config ? {configVersion:config.version}:{})};
    const stopped={...entry,deletion};
    const transaction:DocumentOperation[]=[rootCheck(this.registrations.parentTable,actor,teamId),registryPut(this.registrations.parentTable,registry,{...registry,version:registry.version+1,entries:registry.entries.map(item=>item.id===entry.id ? stopped:item)}),
      {check:{namespace:this.registrations.parentTable,key:{pk:receipt.pk},condition: c.all(c.compare("actor","=",":actor"),c.compare("teamId","=",":team"),c.compare("payloadAppId","=",":app"),c.compare("expiresAt",">",":now")),parameters:{':actor':actor,':team':teamId,':app':payloadAppId,':now':now}}}
    ];
    if(config) transaction.push({update:{namespace:childResources(this.registrations.parentTable,this.registrations.parentSecret,entry.id).tableName,key:{pk:'roughmate'},changes: [c.set("lifecycle",":stop"),c.set("stopId",":id"),c.set("stoppedAt",":now")],condition: c.all(c.compare("#v","=",":v"),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.group(c.any(c.absent("lifecycle"),c.compare("lifecycle","=",":stop")))),fields:{'#v':'version'},parameters:{':v':config.version,':env':config.environmentId,':app':config.appId,':team':config.teamId,':actor':actor,':stop':'stopping',':id':id,':now':now}}});
    await this.transaction(transaction);return stopped;
  }
  async checkRequest(botId:string,actor:string,teamId:string,appId:string):Promise<Registration> {
    const registry=await this.registrations.read(),{entry}=await this.target(registry,botId,actor);
    if(!entry.deletion || entry.teamId!==teamId || appId!==entry.parentAppId && appId!==entry.appId) throw new AppError('forbidden');
    return entry;
  }
  async archives(cursor?:string):Promise<{items:BotArchive[];next?:string}> {
    let pk=cursor ?? (await this.registrations.read()).archiveHead;
    const items:BotArchive[]=[],seen=new Set<string>();
    for(let count=0;pk && count<5;count++) {
      if(!/^bot-archive#[a-f0-9]{32}$/.test(pk) || seen.has(pk)) throw new AppError('registration_boundary');seen.add(pk);
      const record=await this.archive(pk.slice('bot-archive#'.length));items.push(record);pk=record.next;
    }
    return {items,...(pk ? {next:pk}:{})};
  }
  async archive(id:string):Promise<BotArchive> {
    childResources(this.registrations.parentTable,this.registrations.parentSecret,id);
    const saved=await this.registrations.root.get<BotArchive>(archiveKey(id));
    const [workspace,secrets]=await Promise.all([this.registrations.root.workspace(),this.registrations.root.readSecrets()]);
    if(!saved || saved.pk!==archiveKey(id) || saved.entry.id!==id || saved.parentSecret!==this.registrations.parentSecret || saved.rootOwner!==workspace.ownerId || saved.entry.actor!==workspace.ownerId || saved.entry.teamId!==workspace.teamId || saved.entry.parentAppId!==secrets.appId || !saved.entry.appId || saved.entry.appId===secrets.appId || !saved.entry.secretArn || !Number.isFinite(Date.parse(saved.deletedAt)) || Buffer.byteLength(JSON.stringify(saved))>8192) throw new AppError('registration_boundary');
    const resources=childResources(this.registrations.parentTable,this.registrations.parentSecret,id);
    if(!runtime().children.validSecret(resources, saved.entry.secretArn)) throw new AppError('registration_boundary');
    return saved;
  }
  async browserBot(id:string):Promise<{entry:Registration;store:Storage;archived:boolean}> {
    const registry=await this.registrations.read(),workspace=await this.registrations.root.workspace(),secrets=await this.registrations.root.readSecrets();
    const entry=registry.entries.find(item=>item.id===id) ?? (await this.archive(id)).entry;
    const archived=!registry.entries.some(item=>item.id===id);
    if(entry.actor!==workspace.ownerId || entry.teamId!==workspace.teamId || entry.parentAppId!==secrets.appId || !entry.secretArn || !entry.appId || entry.appId===secrets.appId || !archived && entry.phase!=='available') throw new AppError('registration_boundary');
    const store=new Storage(childResources(this.registrations.parentTable,this.registrations.parentSecret,id).tableName,entry.secretArn,this.signal,undefined,entry.credentialVersion);
    return {entry,store,archived};
  }
  private async update(registry:Registry,entry:Registration,deletion:BotDeletion,deleteNextAt?:number):Promise<void> {
    await this.transaction([rootCheck(this.registrations.parentTable,entry.actor,entry.teamId),registryPut(this.registrations.parentTable,registry,{...registry,version:registry.version+1,entries:registry.entries.map(item=>item.id===entry.id ? {...item,deletion}:item),...(deleteNextAt ? {deleteNextAt}:{})})]);
  }
  async process(botId:string,actor:string,teamId:string,rootAppId:string,client:WebClient):Promise<void> {
    let registry=await this.registrations.read();
    if(!registry.entries.some(entry=>entry.id===botId)) {const archived=await this.archive(botId);if(archived.entry.actor!==actor || archived.entry.teamId!==teamId || archived.entry.parentAppId!==rootAppId) throw new AppError('forbidden');return;}
    const target=await this.target(registry,botId,actor),config=target.config;
    let entry=target.entry;
    if(!entry.deletion || entry.teamId!==teamId || entry.parentAppId!==rootAppId || config && (config.lifecycle!=='stopping' || config.stopId!==entry.deletion.id || config.version!==entry.deletion.configVersion)) throw new AppError('forbidden');
    const now=Math.floor(Date.now()/1000);
    if(config?.publicationOwner && config.postingUntil!==undefined && config.postingUntil<=now && config.stoppedAt!==undefined && config.stoppedAt+workerDrainSeconds<=now && ['draft','settings','knowledge'].includes(config.publicationKind ?? '')) {
      // Drain has outlived the worker and lease. Final/unknown answer leases are never cleared here.
      await this.transaction([rootCheck(this.registrations.parentTable,actor,teamId),{update:{namespace:childResources(this.registrations.parentTable,this.registrations.parentSecret,botId).tableName,key:{pk:'roughmate'},changes: [c.set("postingUntil",":zero"),c.remove("publicationOwner"),c.remove("publicationKind")],condition: c.all(c.compare("#v","=",":v"),c.compare("environmentId","=",":env"),c.compare("appId","=",":app"),c.compare("teamId","=",":team"),c.contains("adminIds",":actor"),c.compare("lifecycle","=",":stop"),c.compare("stopId","=",":id"),c.compare("publicationOwner","=",":owner"),c.compare("publicationKind","=",":kind"),c.compare("postingUntil","=",":until"),c.compare("postingUntil","<=",":now")),fields:{'#v':'version'},parameters:{':v':config.version,':env':config.environmentId,':app':config.appId,':team':config.teamId,':actor':actor,':stop':'stopping',':id':entry.deletion.id,':owner':config.publicationOwner,':kind':config.publicationKind,':until':config.postingUntil,':now':now,':zero':0}}}]);delete config.publicationOwner;delete config.publicationKind;config.postingUntil=0;
    }
    if(config?.publicationOwner || config?.postingUntil && config.postingUntil>Math.floor(Date.now()/1000)) {
      if(config.publicationKind==='answer' && entry.deletion.status==='queued' && entry.deletion.failureCode!=='answer_reconciliation_required') await this.update(registry,entry,{...entry.deletion,failureCode:'answer_reconciliation_required'});
      throw new AppError('bot_deletion_waiting');
    }
    if(entry.deletion.status==='failed') return;
    if(entry.deletion.notBefore>Math.floor(Date.now()/1000)) throw new AppError('bot_deletion_waiting');
    const exists=async():Promise<boolean>=>{
      try {
        const result=await client.apps.manifest.export({app_id:string(entry.appId)});
        if(result.ok!==true || 'error' in result || !result.manifest) throw new AppError('bot_delete_unknown');
        const marker=`Registration: ${process.env.PUBLIC_URL}/bots/${entry.id}`;
        if(result.manifest.features?.bot_user?.display_name!==entry.botName || !result.manifest.display_information?.long_description?.endsWith(marker)) throw new AppError('registration_boundary');
        return true;
      } catch(error) {
        const code=slackDeletionCode(error);
        if(code==='app_not_found') return false;
        throw error;
      }
    };
    if(entry.deletion.status==='unknown' && (entry.deletion.verifyAfter ?? 0)>Math.floor(Date.now()/1000)) throw new AppError('bot_deletion_waiting');
    let present:boolean;
    try {present=await exists();}
    catch(error) {
      const code=error instanceof AppError ? error.code:slackDeletionCode(error);
      if(entry.deletion.status==='queued' && ['registration_boundary','app_not_owned_by_manager_app','access_denied','missing_scope','invalid_auth','not_allowed_token_type','no_permission'].includes(code ?? '')) await this.update(registry,entry,{...entry.deletion,status:'failed',failureCode:code,checkedAt:Math.floor(Date.now()/1000)});
      throw error;
    }
    if(entry.deletion.status==='unknown' && present) {
      await this.update(registry,entry,{...entry.deletion,status:'failed',failureCode:'app_still_present',checkedAt:Math.floor(Date.now()/1000)});return;
    }
    if(present) {
      const now=Math.floor(Date.now()/1000);
      if((registry.deleteNextAt ?? 0)>now) throw new AppError('bot_deletion_waiting');
      // Persist unknown before the irreversible call; any replay is read-only verification.
      await this.update(registry,entry,{...entry.deletion,status:'unknown',verifyAfter:now+90},now+60);
      registry=await this.registrations.read();entry=registry.entries.find(item=>item.id===botId)!;
      try {
        const result=await client.apps.manifest.delete({app_id:string(entry.appId)});
        if(result.ok!==true || 'error' in result) throw new AppError('bot_delete_unknown');
      } catch(error) {
        const code=slackDeletionCode(error);
        if(['app_not_owned_by_manager_app','access_denied','missing_scope','invalid_auth','not_allowed_token_type','no_permission'].includes(code ?? '')) {
          await this.update(registry,entry,{...entry.deletion!,status:'failed',failureCode:code});return;
        }
        // Timeout, fatal_error, ratelimit and app_not_found never prove this deletion succeeded.
        throw new AppError('bot_delete_unknown');
      }
      present=await exists();
    }
    if(present) throw new AppError('bot_delete_unknown');
    registry=await this.registrations.read();entry=registry.entries.find(item=>item.id===botId)!;
    if(!entry?.deletion || config && entry.deletion.id!==config.stopId) throw new AppError('registration_conflict');
    const archived:BotArchive={pk:archiveKey(botId),entry,rootOwner:actor,parentSecret:this.registrations.parentSecret,deletedAt:new Date().toISOString(),...(registry.archiveHead ? {next:registry.archiveHead}:{})};
    const transaction:DocumentOperation[]=[rootCheck(this.registrations.parentTable,actor,teamId),registryPut(this.registrations.parentTable,registry,{...registry,version:registry.version+1,archiveHead:archived.pk,entries:registry.entries.filter(item=>item.id!==botId)}),{put:{namespace:this.registrations.parentTable,item:archived,condition: c.absent("pk")}}];
    if(config) transaction.push({update:{namespace:childResources(this.registrations.parentTable,this.registrations.parentSecret,botId).tableName,key:{pk:'roughmate'},changes: [c.set("lifecycle",":archive")],condition: c.all(c.compare("#v","=",":v"),c.compare("lifecycle","=",":stop"),c.compare("stopId","=",":id"),c.contains("adminIds",":actor"),c.absent("publicationOwner")),fields:{'#v':'version'},parameters:{':v':config.version,':stop':'stopping',':id':entry.deletion.id,':actor':actor,':archive':'archived'}}});
    await this.transaction(transaction);
  }
  private async transaction(items:DocumentOperation[]):Promise<void> {
    try {await this.db.transaction({operations:items}, {abortSignal:this.signal});}
    catch(error) {if(error instanceof Error && error.name==='TransactionCanceledException') throw new AppError('registration_conflict');throw error;}
  }
}
export function slackDeletionCode(error:unknown):string|undefined {
  const value=error as {code?:string;data?:{ok?:boolean;error?:unknown}};
  return value?.code===ErrorCode.PlatformError && value.data?.ok===false && typeof value.data.error==='string' ? value.data.error:undefined;
}
