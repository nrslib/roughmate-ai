import { requireDeviceRequest } from './wiki-web-device.js';
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { WebClient } from '@slack/web-api';
import { AppError, string, type Secrets, type Workspace } from './contracts.js';
import type { Storage } from './storage.js';
import { hashText, type Scope } from './wiki-model.js';
import { requireAdmin, type GroupConfig } from './groups.js';
import { slackClient, requireBotChannel } from './slack.js';

export const wikiReadScopes=['channels:read','groups:read'] as const;
const sessionCookie='__Host-roughmate-wiki', browserCookie='__Host-roughmate-browser';
interface BrowserState { devicePublicKey:string; pk:string; appId:string; teamId:string; ownerId:string; browserHash:string; userAgentHash:string; returnPath:string; expiresAt:number; consumed?:boolean; }
export interface WikiSession { devicePublicKey:string; pk:string; appId:string; teamId:string; ownerId:string; userId:string; browserHash:string; userAgentHash:string; expiresAt:number; cipher:string; iv:string; tag:string; }
export function wikiCookie(name:'session'|'browser',value:string,maxAge:number):string {
  return `${name==='session' ? sessionCookie:browserCookie}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}
export function cookie(event:APIGatewayProxyEventV2,name:'session'|'browser'):string|undefined {
  const key=name==='session' ? sessionCookie:browserCookie;
  const values=(event.cookies ?? []).flatMap(raw=>raw.split(';')).map(raw=>raw.trim()).filter(raw=>raw.startsWith(key+'='));
  if(values.length!==1) return undefined;
  const value=values[0].slice(key.length+1);
  return /^[a-f0-9]{64}$/.test(value) ? value:undefined;
}
function encryptionKey(secrets:Secrets,environment:string):Buffer {
  return Buffer.from(hkdfSync('sha256',secrets.signingSecret,environment,'roughmate-wiki-browser-v1',32));
}
function sessionAad(session:Omit<WikiSession,'cipher'|'iv'|'tag'>):Buffer {
  return Buffer.from(JSON.stringify([session.pk,session.appId,session.teamId,session.ownerId,session.userId,session.browserHash,session.userAgentHash,session.expiresAt,session.devicePublicKey]));
}
export function sealWikiToken(session:Omit<WikiSession,'cipher'|'iv'|'tag'>,token:string,secrets:Secrets,environment:string):WikiSession {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(secrets,environment),iv);
  cipher.setAAD(sessionAad(session));
  return {...session,cipher:Buffer.concat([cipher.update(token,'utf8'),cipher.final()]).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function openWikiToken(session:WikiSession,secrets:Secrets,environment:string):string {
  try {
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey(secrets,environment),Buffer.from(session.iv,'base64'));
    decipher.setAAD(sessionAad(session));decipher.setAuthTag(Buffer.from(session.tag,'base64'));
    return string(Buffer.concat([decipher.update(Buffer.from(session.cipher,'base64')),decipher.final()]).toString('utf8'));
  } catch {throw new AppError('wiki_login_required');}
}
export function wikiReturnPath(path:string):string {
  if(!/^\/wiki\/(?:root|bots\/[a-f0-9]{32}|archives)(?:\/[a-zA-Z0-9_/-]*)?(?:\?[a-zA-Z0-9_%=&.-]*)?$/.test(path) || path.length>1000 || path.includes('//')) throw new AppError('invalid_input');
  return path;
}
export function wikiSessionCsrf(id:string,secrets:Secrets):string {return createHmac('sha256',secrets.signingSecret).update('wiki-csrf-v1:'+id).digest('hex');}
export function requireWikiCsrf(event:APIGatewayProxyEventV2,submitted:string,expected:string,publicUrl:string):void {
  const origin=new URL(publicUrl).origin;
  if(event.headers.origin!==origin || event.headers['sec-fetch-site'] && event.headers['sec-fetch-site']!=='same-origin' || !/^[a-f0-9]{64}$/.test(submitted) || !timingSafeEqual(Buffer.from(submitted),Buffer.from(expected))) throw new AppError('forbidden');
}
export class WikiBrowserAuth {
  private db:DynamoDBDocumentClient;
  constructor(private store:Storage,private table:string,private environment:string,private publicUrl:string,private signal:AbortSignal) {
    this.db=DynamoDBDocumentClient.from(new DynamoDBClient({maxAttempts:1,requestHandler:{requestTimeout:900,throwOnRequestTimeout:true,connectionTimeout:500}}));
  }
  async begin(event:APIGatewayProxyEventV2,returnPath:string,secrets:Secrets,workspace:Workspace):Promise<{url:string;browser:string}> {
    const state=randomBytes(32).toString('hex'),browser=cookie(event,'browser') ?? randomBytes(32).toString('hex');
    const devicePublicKey=requireDeviceRequest(event,secrets);
    const record:BrowserState={devicePublicKey,pk:`wiki-auth#${hashText(state)}`,appId:secrets.appId,teamId:workspace.teamId,ownerId:workspace.ownerId,browserHash:hashText(browser),userAgentHash:hashText(event.headers['user-agent'] ?? ''),returnPath:wikiReturnPath(returnPath),expiresAt:Math.floor(Date.now()/1000)+600};
    if(!await this.store.create({...record})) throw new AppError('wiki_conflict');
    const url=new URL('https://slack.com/oauth/v2/authorize');
    url.search=new URLSearchParams({client_id:secrets.clientId,user_scope:wikiReadScopes.join(','),redirect_uri:this.publicUrl+'/wiki/auth/callback',team:workspace.teamId,state}).toString();
    return {url:url.href,browser};
  }
  async complete(event:APIGatewayProxyEventV2,secrets:Secrets,workspace:Workspace):Promise<{id:string;path:string}> {
    const params=event.queryStringParameters,state=string(params?.state),browser=cookie(event,'browser');
    if(!/^[a-f0-9]{64}$/.test(state) || !browser) throw new AppError('invalid_state');
    const pk=`wiki-auth#${hashText(state)}`,receipt=await this.store.get<BrowserState>(pk),now=Math.floor(Date.now()/1000);
    if(!receipt || typeof receipt.devicePublicKey!=='string' || !receipt.devicePublicKey || receipt.pk!==pk || receipt.consumed || receipt.expiresAt<=now || receipt.appId!==secrets.appId || receipt.teamId!==workspace.teamId || receipt.ownerId!==workspace.ownerId || receipt.browserHash!==hashText(browser) || receipt.userAgentHash!==hashText(event.headers['user-agent'] ?? '')) throw new AppError('invalid_state');
    await this.db.send(new TransactWriteCommand({TransactItems:[
      {Update:{TableName:this.table,Key:{pk},UpdateExpression:'SET #consumed = :yes',ConditionExpression:'attribute_not_exists(#consumed) AND expiresAt > :now AND appId = :app AND teamId = :team AND ownerId = :owner AND browserHash = :browser',ExpressionAttributeNames:{'#consumed':'consumed'},ExpressionAttributeValues:{':yes':true,':now':now,':app':secrets.appId,':team':workspace.teamId,':owner':workspace.ownerId,':browser':receipt.browserHash}}},
      {ConditionCheck:{TableName:this.table,Key:{pk:'workspace'},ConditionExpression:'teamId = :team AND ownerId = :owner',ExpressionAttributeValues:{':team':workspace.teamId,':owner':workspace.ownerId}}}
    ]}),{abortSignal:this.signal});
    if(params?.error!==undefined) throw new AppError('wiki_login_required');
    const result=await slackClient(undefined,this.signal).oauth.v2.access({client_id:secrets.clientId,client_secret:secrets.clientSecret,code:string(params?.code),redirect_uri:this.publicUrl+'/wiki/auth/callback'});
    const user=result.authed_user;
    if(result.ok!==true || 'error' in result || result.app_id!==secrets.appId || result.team?.id!==workspace.teamId || result.is_enterprise_install || !user || user.token_type!=='user' || !/^[UW][A-Z0-9]+$/.test(string(user.id)) || !user.access_token || !user.scope) throw new AppError('forbidden');
    const scopes=user.scope.split(',');
    // Slack grants are additive. Invitation scopes belong to the existing Root flow and are never revoked here.
    if(wikiReadScopes.some(scope=>!scopes.includes(scope)) || scopes.some(scope=>![...wikiReadScopes,'groups:write.invites'].includes(scope))) throw new AppError('wiki_oauth_scopes');
    const auth=await slackClient(user.access_token,this.signal).auth.test();
    if(auth.ok!==true || 'error' in auth || auth.team_id!==workspace.teamId || auth.user_id!==user.id || auth.bot_id) throw new AppError('forbidden');
    if(user.expires_in!==undefined && (!Number.isSafeInteger(user.expires_in) || user.expires_in<=0)) throw new AppError('forbidden');
    const id=randomBytes(32).toString('hex');
    const session=sealWikiToken({devicePublicKey:receipt.devicePublicKey,pk:`wiki-session#${hashText(id)}`,appId:secrets.appId,teamId:workspace.teamId,ownerId:workspace.ownerId,userId:user.id!,browserHash:receipt.browserHash,userAgentHash:receipt.userAgentHash,expiresAt:now+Math.min(3600,user.expires_in ?? 3600)},user.access_token,secrets,this.environment);
    if(!await this.store.create({...session})) throw new AppError('wiki_conflict');
    return {id,path:wikiReturnPath(receipt.returnPath)};
  }
  async session(event:APIGatewayProxyEventV2,secrets:Secrets,workspace:Workspace):Promise<{session:WikiSession;client:WebClient;csrf:string}> {
    const id=cookie(event,'session'),browser=cookie(event,'browser');
    if(!id || !browser) throw new AppError('wiki_login_required');
    const pk=`wiki-session#${hashText(id)}`,session=await this.store.get<WikiSession>(pk);
    if(!session || typeof session.devicePublicKey!=='string' || !session.devicePublicKey || session.pk!==pk || session.expiresAt<=Math.floor(Date.now()/1000) || session.appId!==secrets.appId || session.teamId!==workspace.teamId || session.ownerId!==workspace.ownerId || session.browserHash!==hashText(browser) || session.userAgentHash!==hashText(event.headers['user-agent'] ?? '')) throw new AppError('wiki_login_required');
    requireDeviceRequest(event,secrets,session.devicePublicKey);
    const client=slackClient(openWikiToken(session,secrets,this.environment),this.signal);
    const auth=await client.auth.test();
    if(auth.ok!==true || 'error' in auth || auth.team_id!==workspace.teamId || auth.user_id!==session.userId || auth.bot_id) throw new AppError('wiki_login_required');
    return {session,client,csrf:wikiSessionCsrf(id,secrets)};
  }
  async logout(event:APIGatewayProxyEventV2):Promise<void> {
    const id=cookie(event,'session');if(!id) return;
    await this.db.send(new UpdateCommand({TableName:this.table,Key:{pk:`wiki-session#${hashText(id)}`},UpdateExpression:'SET expiresAt = :zero REMOVE cipher, iv, tag',ExpressionAttributeValues:{':zero':0}}),{abortSignal:this.signal});
  }
}
export interface WikiBrowserBudget { checks:number; }
export class WikiBrowserAccess {
  private channels=new Map<string,Promise<void>>();
  constructor(private client:WebClient,private config:GroupConfig,private user:string,private activeBot?:WebClient,private budget:WikiBrowserBudget={checks:0}) {}
  async require(scope:Scope):Promise<void> {
    if(!scope.channelIds.length || !scope.reviewChannelIds.length) requireAdmin(this.config,this.user);
    const scopes=[scope,...scope.accessScopes ?? []];
    if(scopes.length>65 || scopes.some(item=>item.channelIds.some(channel=>!this.config.intakeChannelIds.includes(channel)) || item.reviewChannelIds.some(channel=>channel!==this.config.reviewChannelId))) throw new AppError('forbidden');
    for(const id of new Set(scopes.flatMap(item=>[...item.channelIds,...item.reviewChannelIds]))) {
      let checked=this.channels.get(id);
      if(!checked) {checked=this.channel(id);this.channels.set(id,checked);}
      await checked;
    }
  }
  private async channel(id:string):Promise<void> {
    if(++this.budget.checks>16) throw new AppError('wiki_membership_incomplete');
    const result=await this.client.conversations.info({channel:id});
    const channel=result.channel;
    if(result.ok!==true || 'error' in result || !channel || channel.id!==id || channel.is_member!==true || channel.is_im || channel.is_mpim || channel.is_ext_shared || channel.is_pending_ext_shared || channel.pending_shared?.length || channel.pending_connected_team_ids?.length) throw new AppError('forbidden');
    if(this.activeBot) {if(++this.budget.checks>16) throw new AppError('wiki_membership_incomplete');await requireBotChannel(this.activeBot,id);}
  }
}
