import type { WebClient } from '@slack/web-api';
import { AppError } from './contracts.js';
import type { GroupConfig } from './groups.js';
import type { Scope } from './wiki-model.js';

export const audienceLimits = { calls:32, members:3200, bytes:128*1024, milliseconds:10000, page:200, scopes:65 } as const;

// この集合は一つの検証フェーズだけで使う。生成中や別操作をまたいで所属を再利用しない。
export class ChannelAudience {
  private channels = new Map<string,Promise<Set<string>>>();
  private calls = 0;
  private members = 0;
  private bytes = 0;
  private elapsed = 0;
  constructor(private client:WebClient, private config:GroupConfig, private targets:string[]) {}
  private async request<T>(operation:()=>Promise<T>):Promise<T> {
    const started=Date.now(),remaining=audienceLimits.milliseconds-this.elapsed;
    if(remaining<=0 || this.calls>=audienceLimits.calls || this.bytes>=audienceLimits.bytes) throw new AppError('wiki_membership_incomplete');
    this.calls++;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const response = await Promise.race([operation(),new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new AppError('wiki_membership_incomplete')),remaining);
      })]);
      this.bytes+=Buffer.byteLength(JSON.stringify(response));
      if(this.bytes>audienceLimits.bytes || Date.now()-started>=remaining) throw new AppError('wiki_membership_incomplete');
      return response;
    } finally { this.elapsed+=Date.now()-started;clearTimeout(timer); }
  }
  requireConfig(config:GroupConfig):void {
    if(config.environmentId!==this.config.environmentId || config.appId!==this.config.appId || config.teamId!==this.config.teamId || config.version!==this.config.version || config.reviewChannelId!==this.config.reviewChannelId || JSON.stringify([...config.intakeChannelIds].sort())!==JSON.stringify([...this.config.intakeChannelIds].sort())) throw new AppError('settings_conflict');
  }
  refresh():this { this.channels.clear();return this; }
  private async load(channel:string):Promise<Set<string>> {
    const result=await this.request(()=>this.client.conversations.info({channel}));
    const info=result.channel;
    if(result.ok!==true || result.error!==undefined || !info || info.id!==channel || info.context_team_id!==this.config.teamId || typeof info.is_private!=='boolean' || typeof info.is_archived!=='boolean' || typeof info.is_ext_shared!=='boolean' || typeof info.is_pending_ext_shared!=='boolean' || info.is_channel!==true && info.is_group!==true || info.is_group===true && info.is_private!==true || [info.pending_shared,info.pending_connected_team_ids].some(ids=>ids!==undefined && (!Array.isArray(ids) || ids.some(id=>typeof id!=='string')))) throw new AppError('wiki_membership_incomplete');
    if(info.is_ext_shared || info.is_pending_ext_shared || info.pending_shared?.length || info.pending_connected_team_ids?.length) throw new AppError('external_channel_not_supported');
    if(info.is_member!==true || info.is_archived || info.is_im || info.is_mpim) throw new AppError('bot_not_in_channel');
    const members=new Set<string>(),cursors=new Set<string>();
    let cursor:string|undefined;
    do {
      const limit=Math.min(audienceLimits.page,audienceLimits.members-this.members);
      if(limit<=0) throw new AppError('wiki_membership_incomplete');
      const page=await this.request(()=>this.client.conversations.members({channel,limit,cursor}));
      if(page.ok!==true || page.error!==undefined || !Array.isArray(page.members) || page.members.length>limit || page.members.some(id=>typeof id!=='string' || id.length>64 || !/^[UW][A-Z0-9]+$/.test(id)) || page.response_metadata!==undefined && (!page.response_metadata || typeof page.response_metadata!=='object' || Array.isArray(page.response_metadata))) throw new AppError('wiki_membership_incomplete');
      this.members+=page.members.length;
      if(this.members>audienceLimits.members) throw new AppError('wiki_membership_incomplete');
      for(const id of page.members) {
        if(members.has(id)) throw new AppError('wiki_membership_incomplete');
        members.add(id);
      }
      const next=page.response_metadata?.next_cursor;
      if(next!==undefined && next!==null && (typeof next!=='string' || next.length>1024 || next.trim()!==next)) throw new AppError('wiki_membership_incomplete');
      cursor=next || undefined;
      if(cursor && cursors.has(cursor)) throw new AppError('wiki_membership_incomplete');
      if(cursor) cursors.add(cursor);
    } while(cursor);
    if(!members.size) throw new AppError('wiki_membership_incomplete');
    return members;
  }
  private channel(channel:string):Promise<Set<string>> {
    if(!/^[CG][A-Z0-9]+$/.test(channel)) throw new AppError('forbidden');
    let pending=this.channels.get(channel);
    if(!pending) { pending=this.load(channel);this.channels.set(channel,pending); }
    return pending;
  }
  async require(scope:Scope):Promise<void> {
    const scopes=[scope,...scope.accessScopes ?? []];
    if(!this.targets.length || this.targets.length>2 || scopes.length>audienceLimits.scopes || scopes.some(item=>!item.channelIds.length || !item.reviewChannelIds.length || item!==scope && item.accessScopes?.length || item.channelIds.some(channel=>!this.config.intakeChannelIds.includes(channel)) || item.reviewChannelIds.some(channel=>channel!==this.config.reviewChannelId))) throw new AppError('forbidden');
    const audiences: Set<string>[]=[];
    for(const target of new Set(this.targets)) audiences.push(await this.channel(target));
    for(const channel of new Set(scopes.flatMap(item=>[...item.channelIds,...item.reviewChannelIds]))) {
      const allowed=await this.channel(channel);
      if(audiences.some(audience=>[...audience].some(member=>!allowed.has(member)))) throw new AppError('forbidden');
    }
  }
}
