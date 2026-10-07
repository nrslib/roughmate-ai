import { wikiContentHash } from './wiki-content.js';
import { AppError } from './contracts.js';
import type { GroupConfig, KnowledgeCatalog } from './groups.js';
import type { Storage } from './storage.js';
import { availablePages, wikiCitation, hashText, scopeKey, sourceKey, sourceConsultable, withheldManualIds, wikiLimits, type Evidence, type SourceRecord, type WikiComparison, type WikiPage, type WikiRoot } from './wiki-model.js';

function formalPage(page:WikiPage):boolean {
  return page.status==='ready' && (!!page.human || page.citations.every(citation=>citation.id.startsWith('manual:') || citation.id.startsWith('url:')));
}
function formalPages(root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig,scope:string):WikiPage[] {
  return availablePages(root,catalog,config,Date.now()).filter(page=>page.scope===scope && formalPage(page));
}
export function comparisonTargets(evidence:Evidence[],pages:WikiPage[]):{target:string;kind:'document'|'page';id:string}[] {
  return [...evidence.filter(item=>item.kind==='document').map(item=>({target:`document:${hashText(JSON.stringify([item.id,item.version,item.hash]))}`,kind:'document' as const,id:item.id})),...pages.filter(formalPage).map(page=>({target:`page:${wikiContentHash(page)}`,kind:'page' as const,id:page.id}))];
}
export function comparisonBoundary(root:WikiRoot,catalog:KnowledgeCatalog,config:GroupConfig,scope:string):string {
  return wikiContentHash([
    catalog.documents.filter(item=>scopeKey(item)===scope).map(item=>[item.id,item.version,hashText(item.body)]),
    root.sources.filter(item=>scopeKey(item)===scope).map(item=>[item.id,item.revision,item.version,item.hash]),
    formalPages(root,catalog,config,scope)
  ]);
}
export async function prepareWikiComparison(store:Storage,config:GroupConfig,root:WikiRoot,catalog:KnowledgeCatalog,incoming:Evidence,verifiedPages?:WikiPage[]):Promise<{evidence:Evidence[];existing:WikiPage[];complete:boolean;boundary:string}> {
  const scope=scopeKey(incoming),evidence:Evidence[]=[];
  const normalize=(item:Evidence):Evidence=>({id:item.id,title:item.title,version:item.version,hash:item.hash,text:item.text,kind:item.kind,channelIds:[...item.channelIds],reviewChannelIds:[...item.reviewChannelIds],...(item.answerProof ? {answerProof:item.answerProof}: {})});
  const incomingMinimum=normalize({...incoming,text:''});
  const add=(item:Evidence,reserveIncoming:boolean):boolean=>{
    const normalized=normalize(item);
    if(evidence.some(original=>original.id===item.id)) return true;
    if(scopeKey(item)!==scope || evidence.length>=wikiLimits.evidence-(reserveIncoming ? 1:0) || Buffer.byteLength(JSON.stringify([...evidence,normalized,...(reserveIncoming ? [incomingMinimum]:[])]))>wikiLimits.evidenceBytes) return false;
    evidence.push(normalized);return true;
  };
  let complete=true,reads=0;
  const requiredPages=verifiedPages ? verifiedPages.filter(formalPage):formalPages(root,catalog,config,scope);
  const cited=new Set(requiredPages.flatMap(page=>page.citations.map(citation=>citation.id)));
  const withheld=new Set(incoming.kind==='answer' ? withheldManualIds(root,catalog):[]);
  const documents=catalog.documents.filter(item=>!withheld.has(item.id) && scopeKey(item)===scope && `manual:${item.id}`!==incoming.id).sort((a,b)=>Number(cited.has(`manual:${b.id}`))-Number(cited.has(`manual:${a.id}`)));
  for(const document of documents) if(!add({...document,id:`manual:${document.id}`,hash:hashText(document.body),text:document.body,kind:'document'},true)) complete=false;
  const sources=root.sources.filter(item=>(incoming.kind!=='answer' || sourceConsultable(item)) && scopeKey(item)===scope && `url:${item.id}:${item.revision}`!==incoming.id).sort((a,b)=>Number(cited.has(`url:${b.id}:${b.revision}`))-Number(cited.has(`url:${a.id}:${a.revision}`)));
  for(const source of sources) {
    if(!source.hash || reads>=wikiLimits.evidence || evidence.length>=wikiLimits.evidence-1) {complete=false;continue;}
    reads++;
    const original=await store.wiki.get<SourceRecord>(sourceKey(source));
    if(!original || original.hash!==source.hash || original.version!==source.version || scopeKey(original)!==scope) throw new AppError('missing_wiki_source');
    if(!add(original,true)) complete=false;
  }
  if(!add(incoming,false)) {
    complete=false;
    const normalized=normalize(incoming);
    let low=0,high=normalized.text.length;
    while(low<high) {
      const mid=Math.ceil((low+high)/2);
      if(Buffer.byteLength(JSON.stringify([...evidence,{...normalized,text:normalized.text.slice(0,mid)}]))<=wikiLimits.evidenceBytes) low=mid; else high=mid-1;
    }
    if(!add({...normalized,text:normalized.text.slice(0,low).replace(/[\uD800-\uDBFF]$/,'')},false)) throw new AppError('wiki_prompt_too_large');
  }
  const allPages=verifiedPages ?? availablePages(root,catalog,config,Date.now()).filter(page=>page.scope===scope && (page.human || !page.citations.some(citation=>citation.id.startsWith('wiki-answer#'))));
  const existing:WikiPage[]=[];
  for(const page of [...requiredPages,...allPages.filter(page=>!formalPage(page))]) {
    if(!formalPage(page) && !page.citations.every(citation=>wikiCitation(citation,root,catalog,Date.now()))) continue;
    if(Buffer.byteLength(JSON.stringify([...existing,page]))>wikiLimits.contextBytes) {if(formalPage(page)) complete=false;continue;}
    existing.push(page);
  }
  return {evidence,existing,complete,boundary:comparisonBoundary(root,catalog,config,scope)};
}
export function comparisonVerified(comparisons:WikiComparison[]|undefined,targets:string[]):boolean {
  const checks=comparisons ?? [];
  return checks.length===targets.length && targets.every(target=>checks.some(check=>check.target===target && check.relation==='consistent'));
}
export function assessWikiProposal(proposal:WikiPage[],targets:string[],complete:boolean,incoming:Evidence,existing:WikiPage[]):WikiPage[] {
  return proposal.map(page=>{
    const verified=comparisonVerified(page.comparisons,targets);
    const current=existing.find(old=>old.scope===page.scope && old.id===page.id);
    const old=current && formalPage(current) ? current:undefined;
    const unchanged=old && old.body===page.body && old.title===page.title && old.kind===page.kind && old.citations.length===page.citations.length && old.citations.every(citation=>page.citations.some(next=>next.id===citation.id && next.version===citation.version && next.hash===citation.hash));
    const sameSource=old && incoming.kind==='document' && old.citations.some(citation=>citation.id===incoming.id) && page.citations.some(citation=>citation.id===incoming.id) && old.citations.every(citation=>page.citations.some(next=>next.id===citation.id)) && page.citations.every(citation=>old.citations.some(prior=>prior.id===citation.id));
    const reviewReason=old?.human && !unchanged ? 'formal_replacement' : !complete ? 'comparison_incomplete' : !verified ? 'comparison_unverified' : old && !sameSource && !unchanged ? 'formal_replacement' : undefined;
    const identified=current?.mergeVersion!==undefined ? {...page,mergeVersion:current.mergeVersion}:page;
    return reviewReason ? {...identified,status:'review',reviewReason} : old?.human && unchanged ? {...identified,human:old.human}:identified;
  });
}
