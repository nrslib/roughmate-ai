import { randomUUID } from 'node:crypto';
import type { KnownBlock, View } from '@slack/web-api';
import { AppError } from './contracts.js';
import { requireIdentity, type GroupConfig, type GroupIdentity } from './groups.js';
import type { Storage } from './storage.js';

interface ViewState extends GroupIdentity { pk:string; user:string; expiresAt:number; values:{action:string; value:string}[]; }

export async function resolveWikiViewValue(store:Storage,config:GroupConfig,user:string,action:string,value:string):Promise<string> {
  const match=/^(wiki-view#[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})#(0|[1-9]\d?)$/.exec(value);
  if(!match) throw new AppError('forbidden');
  const state=await store.get<ViewState>(match[1]);
  if(!state) throw new AppError('forbidden');
  requireIdentity(state,config);
  if(!Array.isArray(state.values) || state.values.length>100 || !Number.isSafeInteger(state.expiresAt) || Buffer.byteLength(JSON.stringify(state))>16384) throw new AppError('forbidden');
  const selected=state.values[Number(match[2])];
  if(state.pk!==match[1] || state.user!==user || state.expiresAt<=Math.floor(Date.now()/1000) || !selected || selected.action!==action || typeof selected.value!=='string') throw new AppError('forbidden');
  return selected.value;
}

export async function protectWikiView(store:Storage,config:GroupConfig,user:string,view:View):Promise<View> {
  const pk=`wiki-view#${randomUUID()}`,values:ViewState['values']=[];
  const reference=(action:string,value:string):string=>{
    if(values.length>=100) throw new AppError('invalid_input');
    values.push({action,value});return `${pk}#${values.length-1}`;
  };
  const blocks=(view.blocks as KnownBlock[]).map(block=>block.type==='actions' ? {...block,elements:block.elements.map(element=>element.type==='button' && element.action_id?.startsWith('wiki_') && element.value ? {...element,value:reference(element.action_id,element.value)}:element)}:block);
  const protectedView={...view,blocks,...(view.type==='modal' && ['wiki_source','wiki_retention','knowledge'].includes(view.callback_id ?? '') && view.private_metadata ? {private_metadata:reference(view.callback_id!,view.private_metadata)}:{})};
  if(values.length) {
    const state:ViewState={pk,user,environmentId:config.environmentId,appId:config.appId,teamId:config.teamId,expiresAt:Math.floor(Date.now()/1000)+900,values};
    if(Buffer.byteLength(JSON.stringify(state))>16384 || !await store.create(state as unknown as Record<string,unknown>)) throw new AppError('wiki_conflict');
  }
  return protectedView;
}
