import { AppError } from './contracts.js';
import { wikiContentHash } from './wiki-content.js';
import { requireIdentity, type GroupConfig, type KnowledgeDocument } from './groups.js';
import { pageAccessScope, wikiLimits, type Scope, type WikiPage, type WikiRoot } from './wiki-model.js';
import { WikiAccess, WikiHistoryAccess } from './wiki-access.js';
import type { KnowledgeCatalog } from './groups.js';

export const wikiBrowseNotice='閲覧・原資料・祖先の確認には上限があります。未確認や非表示を含む総件数・残りの版数は表示しません。この画面にない項目が不存在とは限りません。';
export const wikiExploreLabel='過去の履歴を探す';
export function unavailableForBrowsing(error:unknown):boolean {
  if(!(error instanceof AppError) || !['forbidden','settings_conflict','group_boundary_mismatch','bot_not_in_channel','external_channel_not_supported','wiki_membership_incomplete','wiki_history_incomplete'].includes(error.code)) return false;
  return true;
}
export function browseBudgetReached(error:unknown):boolean {
  return error instanceof AppError && ['wiki_membership_incomplete','wiki_history_incomplete'].includes(error.code);
}
export async function browsePages(pages:WikiPage[],offset:number,root:WikiRoot,catalog:KnowledgeCatalog,access:WikiAccess,history:WikiHistoryAccess,old:boolean):Promise<{items:{page:WikiPage;scope:Scope}[];next?:number;resume:number}> {
  const items:{page:WikiPage;scope:Scope}[]=[];
  for(let index=offset;index<pages.length;index++) {
    const page=pages[index];
    try {
      const scope=old ? await history.page(page):pageAccessScope(page,root,catalog);
      if(!old) {await access.require(scope);await history.page(page);}
      if(items.length===5) return {items,next:index,resume:index};
      items.push({page,scope});
    } catch(error) {
      if(!unavailableForBrowsing(error)) throw error;
      // 先行候補で消費した予算は次の利用者操作で回復する。
      if(browseBudgetReached(error) && index>offset) return {items,resume:index};
    }
  }
  return {items,resume:pages.length};
}
export function wikiBrowseContent(pages:WikiPage[]):{id:string;hash:string}[] {
  return pages.map(page=>({id:page.id,hash:wikiContentHash([page.title,page.kind,page.body,page.status,page.citations])}));
}
export interface WikiHistoryCursor { version:number|null; offset:number; }
export async function browseOldWiki(config:GroupConfig,cursor:WikiHistoryCursor,current:{id:string;hash:string}[],history:WikiHistoryAccess):Promise<{version?:number;resume:WikiHistoryCursor}> {
  let {version,offset}=cursor;
  for(let checked=0;version!==null && checked<wikiLimits.historyPage;checked++) {
    let old:Awaited<ReturnType<WikiHistoryAccess['snapshot']>>;
    try {old=await history.snapshot(version);}
    catch(error) {if(!browseBudgetReached(error)) throw error;return {resume:{version,offset}};}
    if(!old) return {resume:{version:null,offset:0}};
    requireIdentity(old,config);
    if(!old.verified) {version=old.previousVersion ?? null;offset=0;continue;}
    if(!Array.isArray(old.pages) || old.pages.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(old.pages))>wikiLimits.wikiBytes || old.previousVersion!==undefined && (!Number.isSafeInteger(old.previousVersion) || old.previousVersion<1 || old.previousVersion>=version)) throw new AppError('missing_wiki_version');
    for(let index=offset;index<old.pages.length;index++) {
      const page=old.pages[index];
      if(current.some(item=>item.id===page.id && item.hash===wikiBrowseContent([page])[0].hash)) continue;
      try {
        await history.page(page);
        return {version,resume:{version:old.previousVersion ?? null,offset:0}};
      } catch(error) {
        if(!unavailableForBrowsing(error)) throw error;
        if(browseBudgetReached(error) && (checked>0 || index>offset)) return {resume:{version,offset:index}};
      }
    }
    version=old.previousVersion ?? null;offset=0;
  }
  return {resume:{version,offset}};
}
export async function browseOldManual(config:GroupConfig,document:KnowledgeDocument,version:number|null|undefined,history:WikiHistoryAccess):Promise<{version?:number;resume:number|null}> {
  if(version===null) return {resume:null};
  for(let checked=0;checked<wikiLimits.historyPage;checked++) {
    let saved:Awaited<ReturnType<WikiHistoryAccess['manualHistory']>>;
    try {saved=await history.manualHistory(document.id,version);}
    catch(error) {if(!browseBudgetReached(error)) throw error;return {resume:version ?? null};}
    if(!saved) return {resume:null};
    requireIdentity(saved,config);
    if(!Number.isSafeInteger(saved.version) || saved.version<1 || saved.version>=document.version || version!==undefined && saved.version!==version || saved.previousVersion!==undefined && (!Number.isSafeInteger(saved.previousVersion) || saved.previousVersion<1 || saved.previousVersion>=saved.version)) throw new AppError('missing_wiki_source');
    try {
      const original=await history.manualOriginal(document.id,saved.version);
      if(!original) throw new AppError('missing_wiki_source');
      await history.citation({id:`manual:${document.id}`,version:saved.version,hash:original.hash});
      return {version:saved.version,resume:saved.previousVersion ?? null};
    } catch(error) {
      if(error instanceof AppError && error.code==='group_boundary_mismatch' || !unavailableForBrowsing(error)) throw error;
      if(browseBudgetReached(error) && checked>0) return {resume:saved.version};
    }
    version=saved.previousVersion;
    if(version===undefined) return {resume:null};
  }
  return {resume:version ?? null};
}
