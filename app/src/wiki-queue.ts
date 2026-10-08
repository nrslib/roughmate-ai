import { runtime } from './runtime.js';
import { env, string } from './contracts.js';
import type { GroupIdentity } from './groups.js';
const queue=runtime().queue();
export async function enqueueWiki(identity:GroupIdentity,botId:unknown,key:string,destination?:{url:string;region:string}):Promise<void> {
  const client=destination ? runtime().queue(destination.region):queue;
  await client.enqueue({destination:destination ? destination.url:env('WIKI_QUEUE_URL'),body:JSON.stringify({kind:'wiki',...(botId===undefined ? {}:{botId:string(botId)}),payload:{...identity,key}})});
}

export async function enqueueArchiveRetention(identity:GroupIdentity,botId:string,step:number):Promise<void> {
  await queue.enqueue({destination:env('WIKI_QUEUE_URL'),body:JSON.stringify({kind:'wiki_archive_retention',botId,payload:{...identity,step}})});
}
export async function enqueueWikiAdoption(identity:GroupIdentity,botId:string|undefined,userId:string,key:string,abortSignal?:AbortSignal):Promise<void> {
  await runtime().queue().enqueue({destination:env('WIKI_QUEUE_URL'),body:JSON.stringify({kind:'wiki_adoption',...(botId ? {botId}:{}),payload:{...identity,userId,key}})},{abortSignal});
}
