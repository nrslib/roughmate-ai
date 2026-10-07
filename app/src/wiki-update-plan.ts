import { WikiUpdateError, type WikiUpdateFailureReason } from './wiki-update-failure.js';
import { AppError, object, string } from './contracts.js';
import { wikiContentHash } from './wiki-content.js';
import { requireWikiPages, scopeKey, wikiLimits, type Evidence, type WikiPage, type WikiUpdateTarget } from './wiki-model.js';
import { wikiAtxHeading, wikiFenceDelimiter, type WikiFence } from './wiki-markdown.js';

function wikiSections(body:string):{path:string[];start:number;end:number}[] {
  const sections:{path:string[];start:number;end:number}[]=[{path:[],start:0,end:body.length}];
  let offset=0,fence:WikiFence|undefined;const ancestors:{level:number;title:string}[]=[];
  for(const line of body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text=line.replace(/\r?\n$/,''),delimiter=wikiFenceDelimiter(text,fence);
    if(delimiter!==null) fence=delimiter;
    const heading=!fence && delimiter===null && wikiAtxHeading(text);
    if(heading) {
      sections.at(-1)!.end=offset;
      while(ancestors.length && ancestors.at(-1)!.level>=heading.level) ancestors.pop();
      ancestors.push(heading);
      sections.push({path:ancestors.map(item=>item.title),start:offset+line.length,end:body.length});
    }
    offset+=line.length;
  }
  return sections;
}
export function wikiSection(body:string,path:string[]):{start:number;end:number;text:string} {
  const found=wikiSections(body).filter(section=>wikiContentHash(section.path)===wikiContentHash(path));
  if(found.length!==1) throw new AppError('wiki_target_changed');
  return {...found[0],text:body.slice(found[0].start,found[0].end)};
}
export function requireUpdateTargets(targets:WikiUpdateTarget[]):void {
  if(!Array.isArray(targets) || targets.length>wikiLimits.pages || Buffer.byteLength(JSON.stringify(targets))>wikiLimits.wikiBytes) throw new AppError('invalid_wiki_output');
  const keys=new Set<string>();
  for(const target of targets) {
    if(!target) throw new AppError('invalid_wiki_output');
    if(target.mergeVersion!==undefined && (target.isNew || !Number.isSafeInteger(target.mergeVersion) || target.mergeVersion<1)) throw new AppError('invalid_wiki_output');
    const key=wikiContentHash([target.id,target.scope,target.headingPath]);
    if(!target || !/^[a-zA-Z0-9_-]{1,48}$/.test(target.id) || typeof target.scope!=='string' || typeof target.isNew!=='boolean' || !Array.isArray(target.headingPath) || target.headingPath.length>6 || target.headingPath.some(part=>typeof part!=='string' || !part.trim() || part.length>120) || [target.title,target.knowledge,target.policy,target.rationale].some(text=>typeof text!=='string' || !text.trim()) || target.title.length>120 || [target.before,target.knowledge,target.policy,target.rationale].some(text=>typeof text!=='string' || text.includes('\u0000') || Buffer.byteLength(text)>wikiLimits.pageBytes) || !Array.isArray(target.citations) || !target.citations.length || target.citations.length>8 || target.isNew && (target.before!=='' || target.headingPath.length) || keys.has(key)) throw new AppError('invalid_wiki_output');
    keys.add(key);
  }
  if(targets.some(target=>targets.some(other=>other!==target && other.id===target.id && other.scope===target.scope && (other.isNew || target.isNew)))) throw new AppError('invalid_wiki_output');
}
export function requireUpdateTargetIdentity(target:WikiUpdateTarget,page:WikiPage):void {
  if(page.id!==target.id || page.scope!==target.scope || page.mergeVersion!==target.mergeVersion) throw new AppError('wiki_target_changed');
}
export function validateUpdatePlan(raw:unknown,evidence:Evidence[],pages:WikiPage[],scope:string,incomingId:string):WikiUpdateTarget[] {
  const value=object(raw);
  if(Object.keys(value).some(key=>key!=='targets') || !Array.isArray(value.targets)) throw new AppError('invalid_wiki_output');
  const targets=value.targets.map(raw=>{
    const item=object(raw);
    if(Object.keys(item).some(key=>!['id','title','isNew','headingPath','knowledge','policy','rationale','citations'].includes(key))) throw new AppError('invalid_wiki_output');
    const id=string(item.id),page=pages.find(page=>page.id===id && page.scope===scope);
    if(typeof item.isNew!=='boolean' || item.isNew===!!page || !Array.isArray(item.headingPath) || item.headingPath.some(part=>typeof part!=='string') || !Array.isArray(item.citations)) throw new AppError('invalid_wiki_output');
    const citations=item.citations.map(raw=>{
      const citation=object(raw),original=evidence.find(item=>item.id===citation.id);
      if(!original || scopeKey(original)!==scope || original.version!==citation.version || original.hash!==citation.hash) throw new AppError('invalid_wiki_citation');
      return {id:original.id,version:original.version,hash:original.hash,...(original.answerProof ? {answerProof:original.answerProof}:{})};
    });
    if(!citations.some(citation=>citation.id===incomingId)) throw new AppError('invalid_wiki_citation');
    const headingPath=item.headingPath as string[];
    return {id,title:page ? page.title:string(item.title),scope,isNew:item.isNew,...(page?.mergeVersion!==undefined ? {mergeVersion:page.mergeVersion}:{}),headingPath,before:page ? wikiSection(page.body,headingPath).text:'',knowledge:string(item.knowledge),policy:string(item.policy),rationale:string(item.rationale),citations};
  });
  requireUpdateTargets(targets);return targets;
}
export function updateFragments(text:string):{fragment:number;start:number;end:number;text:string}[] {
  const lines=text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let offset=0;
  return lines.map((line,fragment)=>{
    const start=offset;offset+=line.length;
    return {fragment,start,end:offset,text:line.replace(/\r?\n$/,'')};
  });
}
interface WikiUpdateOperation { target:number; edits:{fragment:number|null;before:string;after:string}[]; }
export function updatePageCitations(current:WikiPage|undefined,targets:WikiUpdateTarget[],comparisonPages:WikiPage[],evidence:Evidence[]) {
  const citations=[...new Map([...(current?.citations ?? []),...targets.flatMap(target=>target.citations),...comparisonPages.flatMap(page=>page.citations),...evidence.map(({id,version,hash,answerProof})=>({id,version,hash,...(answerProof ? {answerProof}:{})}))].map(citation=>[wikiContentHash(citation),citation])).values()];
  return citations;
}
function updateObject(value:unknown,reason:WikiUpdateFailureReason):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new WikiUpdateError(reason);
  return value as Record<string,unknown>;
}
export function applyUpdateOperations(raw:unknown,targets:WikiUpdateTarget[],pages:WikiPage[],comparisonPages:WikiPage[],evidence:Evidence[]=[]):{pages:WikiPage[];changes:{target:number;title:string;before:string;after:string}[]} {
  const value=updateObject(raw,'output_shape');
  if(Buffer.byteLength(JSON.stringify(raw))>wikiLimits.wikiBytes) throw new WikiUpdateError('output_too_large');
  if(Object.keys(value).some(key=>!['operations','comparisonChecks','evidenceChecks'].includes(key)) || !Array.isArray(value.operations) || value.operations.length!==targets.length) throw new WikiUpdateError('output_shape');
  if(!Array.isArray(value.comparisonChecks) || value.comparisonChecks.length!==comparisonPages.length) throw new WikiUpdateError('comparison_check');
  const checked=new Set<number>();
  for(const raw of value.comparisonChecks) {
    const check=updateObject(raw,'comparison_check');
    if(Object.keys(check).some(key=>!['page','relation'].includes(key)) || !Number.isInteger(check.page) || Number(check.page)<0 || Number(check.page)>=comparisonPages.length || checked.has(Number(check.page)) || !['consistent','conflict','unresolved'].includes(String(check.relation))) throw new WikiUpdateError('comparison_check');
    if(check.relation!=='consistent') throw new WikiUpdateError('comparison_conflict');
    checked.add(Number(check.page));
  }
  const documents=evidence.map((item,index)=>({item,index})).filter(({item})=>item.kind==='document');
  const evidenceChecks=value.evidenceChecks;
  if(!Array.isArray(evidenceChecks) || evidenceChecks.length!==documents.length) throw new WikiUpdateError('evidence_check');
  const checkedEvidence=new Set<number>();
  for(const raw of evidenceChecks) {
    const check=updateObject(raw,'evidence_check');
    if(Object.keys(check).some(key=>!['evidence','relation'].includes(key)) || !Number.isInteger(check.evidence) || !documents.some(({index})=>index===check.evidence) || checkedEvidence.has(Number(check.evidence)) || !['consistent','conflict','unresolved'].includes(String(check.relation))) throw new WikiUpdateError('evidence_check');
    if(check.relation!=='consistent') throw new WikiUpdateError('evidence_conflict');
    checkedEvidence.add(Number(check.evidence));
  }
  const operations=value.operations.map(raw=>{
    const op=updateObject(raw,'operation_shape');
    if(Object.keys(op).some(key=>!['target','edits'].includes(key)) || !Number.isInteger(op.target) || Number(op.target)<0 || Number(op.target)>=targets.length || !Array.isArray(op.edits) || op.edits.length>wikiLimits.pages) throw new WikiUpdateError('operation_shape');
    const fragments=new Set<number|null>();
    for(const raw of op.edits) {
      const edit=updateObject(raw,'edit_shape');
      if(Object.keys(edit).some(key=>!['fragment','before','after'].includes(key)) || edit.fragment!==null && (!Number.isInteger(edit.fragment) || Number(edit.fragment)<0) || [edit.before,edit.after].some(text=>typeof text!=='string' || text.includes('\u0000') || Buffer.byteLength(text)>wikiLimits.pageBytes) || fragments.has(edit.fragment as number|null)) throw new WikiUpdateError('edit_shape');
      fragments.add(edit.fragment as number|null);
    }
    return op as unknown as WikiUpdateOperation;
  });
  if(new Set(operations.map(op=>op.target)).size!==targets.length) throw new WikiUpdateError('operation_shape');
  const changes:{target:number;title:string;before:string;after:string}[]=[];
  let updated=[...pages];
  for(const id of new Set(targets.map(target=>target.id))) {
    const selected=operations.filter(op=>targets[op.target].id===id),target=targets[selected[0].target];
    const current=pages.find(page=>page.id===id && page.scope===target.scope);
    if(target.isNew ? !!current:!current) throw new AppError('wiki_target_changed');
    if(current) for(const op of selected) requireUpdateTargetIdentity(targets[op.target],current);
    const ranges=selected.map(op=>{
      const section=current ? wikiSection(current.body,targets[op.target].headingPath):{start:0,end:0,text:''};
      const fragments=updateFragments(section.text);
      const edits=op.edits.map(edit=>{
        if(edit.fragment===null) {
          if(edit.before!=='' || section.text && !section.text.endsWith('\n') && edit.after && !edit.after.startsWith('\n')) throw new WikiUpdateError('append_boundary');
          return {start:section.text.length,end:section.text.length,after:edit.after};
        }
        const fragment=fragments.find(item=>item.fragment===edit.fragment);
        if(!fragment || target.isNew || !edit.before || /[\r\n]/.test(edit.before)) throw new WikiUpdateError('fragment_mismatch');
        const start=fragment.text.indexOf(edit.before);
        if(start<0 || fragment.text.indexOf(edit.before,start+1)!==-1) throw new WikiUpdateError('fragment_mismatch');
        return {start:fragment.start+start,end:fragment.start+start+edit.before.length,after:edit.after};
      }).sort((a,b)=>b.start-a.start);
      let after=section.text;
      for(const edit of edits) after=after.slice(0,edit.start)+edit.after+after.slice(edit.end);
      if(!target.isNew && section.end<current!.body.length && after!=='' && !after.endsWith('\n')) throw new WikiUpdateError('section_boundary');
      return {...section,op,after};
    }).sort((a,b)=>b.start-a.start);
    let body=current?.body ?? '';
    for(const range of ranges) {
      body=body.slice(0,range.start)+range.after+body.slice(range.end);
      if(range.text!==range.after) changes.push({target:range.op.target,title:current?.title ?? target.title,before:range.text,after:range.after});
    }
    if(!body.trim()) throw new WikiUpdateError('body_invalid');
    if(current && wikiContentHash(wikiSections(current.body).map(section=>section.path))!==wikiContentHash(wikiSections(body).map(section=>section.path))) throw new WikiUpdateError('heading_changed');
    if(!changes.some(change=>targets[change.target].id===id)) continue;
    const citations=updatePageCitations(current,selected.map(op=>targets[op.target]),comparisonPages,evidence);
    if(citations.length>8) throw new AppError('wiki_prompt_too_large');
    const page:WikiPage=current ? {...current,body,citations}:{id,title:target.title,scope:target.scope,kind:'faq',relatedIds:[],status:'ready',body,citations};
    updated=current ? updated.map(item=>item===current ? page:item):[...updated,page];
  }
  try {requireWikiPages(updated);} catch(error) {
    if(error instanceof AppError && error.code==='invalid_wiki') throw new WikiUpdateError('page_invalid');
    throw error;
  }
  return {pages:updated,changes};
}
