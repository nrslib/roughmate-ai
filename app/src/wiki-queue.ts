import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env, string } from './contracts.js';
import type { GroupIdentity } from './groups.js';
const queue=new SQSClient({maxAttempts:1,requestHandler:{requestTimeout:900,throwOnRequestTimeout:true,connectionTimeout:500}});
export async function enqueueWiki(identity:GroupIdentity,botId:unknown,key:string,destination?:{url:string;region:string}):Promise<void> {
  const client=destination ? new SQSClient({region:destination.region,maxAttempts:1,requestHandler:{requestTimeout:900,throwOnRequestTimeout:true,connectionTimeout:500}}):queue;
  await client.send(new SendMessageCommand({QueueUrl:destination ? destination.url:env('WIKI_QUEUE_URL'),MessageBody:JSON.stringify({kind:'wiki',...(botId===undefined ? {}:{botId:string(botId)}),payload:{...identity,key}})}));
}

export async function enqueueArchiveRetention(identity:GroupIdentity,botId:string,step:number):Promise<void> {
  await queue.send(new SendMessageCommand({QueueUrl:env('WIKI_QUEUE_URL'),MessageBody:JSON.stringify({kind:'wiki_archive_retention',botId,payload:{...identity,step}})}));
}
export async function enqueueWikiAdoption(identity:GroupIdentity,botId:string|undefined,userId:string,key:string):Promise<void> {
  await queue.send(new SendMessageCommand({QueueUrl:env('WIKI_QUEUE_URL'),MessageBody:JSON.stringify({kind:'wiki_adoption',...(botId ? {botId}:{}),payload:{...identity,userId,key}})}));
}
