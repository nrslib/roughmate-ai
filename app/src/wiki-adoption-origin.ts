import { randomBytes } from 'node:crypto';
import { AppError } from './contracts.js';
import { requireIdentity, type GroupConfig, type GroupIdentity } from './groups.js';
import type { Storage } from './storage.js';
import { hashText } from './wiki-model.js';
import type { WikiSession } from './wiki-web-auth.js';

export type WikiAdoptionOrigin =
  | {surface:'slack';nonceKey:string;viewId:string;configVersion:number}
  | {surface:'browser';nonceKey:string;sessionKey:string;deviceKeyHash:string;csrfHash:string;configVersion:number};

export function requireAdoptionOrigin(origin:WikiAdoptionOrigin):void {
  if(!origin || !Number.isSafeInteger(origin.configVersion) || origin.configVersion<1) throw new AppError('forbidden');
  const fields=origin.surface==='slack' ? ['surface','nonceKey','viewId','configVersion']:['surface','nonceKey','sessionKey','deviceKeyHash','csrfHash','configVersion'];
  if(Object.keys(origin).length!==fields.length || Object.keys(origin).some(key=>!fields.includes(key))) throw new AppError('forbidden');
  if(origin.surface==='slack') {
    if(!/^wiki-view#[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(origin.nonceKey) || typeof origin.viewId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(origin.viewId)) throw new AppError('forbidden');
  } else if(origin.surface==='browser') {
    if(!/^wiki-view#browser-[a-f0-9]{32}$/.test(origin.nonceKey) || !/^wiki-session#[a-f0-9]{64}$/.test(origin.sessionKey) || !/^[a-f0-9]{64}$/.test(origin.deviceKeyHash) || !/^[a-f0-9]{64}$/.test(origin.csrfHash)) throw new AppError('forbidden');
  } else throw new AppError('forbidden');
}

interface BrowserProposalView extends GroupIdentity {
  pk:string;user:string;origin:Extract<WikiAdoptionOrigin,{surface:'browser'}>;
  proposalKey:string;proposalHash:string;operation:'confirm'|'reject';edit:boolean;expiresAt:number;
}
function browserOrigin(session:WikiSession,csrf:string,nonceKey:string,configVersion:number):Extract<WikiAdoptionOrigin,{surface:'browser'}> {
  const origin={surface:'browser' as const,nonceKey,sessionKey:session.pk,deviceKeyHash:hashText(session.devicePublicKey),csrfHash:hashText(csrf),configVersion};
  requireAdoptionOrigin(origin);return origin;
}
export async function createBrowserProposalView(store:Storage,config:GroupConfig,session:WikiSession,csrf:string,proposalKey:string,proposalHash:string,operation:'confirm'|'reject',edit:boolean):Promise<string> {
  const nonce=randomBytes(16).toString('hex'),pk='wiki-view#browser-'+nonce;
  const state:BrowserProposalView={pk,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,user:session.userId,origin:browserOrigin(session,csrf,pk,config.version),proposalKey,proposalHash,operation,edit,expiresAt:Math.floor(Date.now()/1000)+900};
  if(!await store.create({...state})) throw new AppError('wiki_conflict');
  return 'wiki-maintenance#'+nonce;
}
export async function acceptBrowserProposalView(store:Storage,config:GroupConfig,session:WikiSession,csrf:string,command:{requestId:string;configVersion:number;proposalKey:string;proposalHash:string;operation:string},edit:boolean):Promise<WikiAdoptionOrigin> {
  if(!/^wiki-maintenance#[a-f0-9]{32}$/.test(command.requestId) || command.configVersion!==config.version) throw new AppError('forbidden');
  const pk='wiki-view#browser-'+command.requestId.split('#')[1],state=await store.get<BrowserProposalView>(pk);
  if(!state || state.pk!==pk || state.user!==session.userId || state.proposalKey!==command.proposalKey || state.proposalHash!==command.proposalHash || state.operation!==command.operation || state.edit!==edit || !Number.isSafeInteger(state.expiresAt) || state.expiresAt<=Math.floor(Date.now()/1000)) throw new AppError('forbidden');
  requireIdentity(state,config);requireAdoptionOrigin(state.origin);
  const current=browserOrigin(session,csrf,pk,config.version);
  if(state.origin.surface!=='browser' || state.origin.configVersion!==current.configVersion || state.origin.sessionKey!==current.sessionKey || state.origin.deviceKeyHash!==current.deviceKeyHash || state.origin.csrfHash!==current.csrfHash) throw new AppError('forbidden');
  return state.origin;
}
