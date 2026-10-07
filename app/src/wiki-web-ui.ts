import { hashText, type WikiPage } from './wiki-model.js';
import { wikiAtxHeading, wikiFenceDelimiter, type WikiFence } from './wiki-markdown.js';

export function html(text:string):string {return text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
export function pageSlug(page:WikiPage):string {return hashText(page.scope).slice(0,16)+'_'+page.id;}
export function wikiAnchor(url:string,label:string):string {
  const internal=url.startsWith('/wiki/') && !url.startsWith('//');
  let external=false;
  try {const parsed=new URL(url);external=parsed.protocol==='https:' && !parsed.username && !parsed.password;} catch { /* Relative Wiki paths are checked separately. */ }
  return internal || external ? `<a href="${html(url)}"${external ? ' rel="noreferrer noopener"':''}>${html(label)}</a>`:html(label);
}
export function wikiLayout(title:string,content:string,base?:string):string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)} | Roughmate Wiki</title><style>body{font-family:system-ui,sans-serif;line-height:1.8;margin:2rem auto;padding:0 1rem;max-width:58rem;color:#203144;background:#fff}a{color:#185ca0}nav{display:flex;gap:1rem;flex-wrap:wrap;border-bottom:1px solid #ddd;padding-bottom:1rem}article{white-space:normal}pre{white-space:pre-wrap;background:#f3f5f7;padding:1rem;overflow-wrap:anywhere}textarea{width:100%;min-height:20rem}input[type=text]{width:100%}button{padding:.5rem 1rem;margin:.7rem 0}label{display:block}.notice{background:#f3f5f7;padding:.6rem}li{margin:.4rem 0}</style></head><body>${base ? `<nav>${wikiAnchor(base,'目次')}${wikiAnchor(base+'/proposals','要確認の更新案')}${wikiAnchor(base+'/history','変更履歴')}${wikiAnchor('/wiki/archives','Botアーカイブ')}</nav>`:''}<main><h1>${html(title)}</h1>${content}</main></body></html>`;
}
export function renderWikiBody(body:string,page:WikiPage,visible:WikiPage[],base:string):string {
  const inline=(text:string):string=>{
    let result='',at=0;
    const links=/\[\[([a-zA-Z0-9_-]{1,48})(?:\|([^\]\n]{1,120}))?\]\]|\[([^\]\n]{1,120})\]\(([^\s)]+)\)/g;
    for(const match of text.matchAll(links)) {
      result+=html(text.slice(at,match.index));at=match.index!+match[0].length;
      const destination=match[1] ?? match[4],label=match[2] ?? match[3] ?? destination;
      const id=destination.replace(/^wiki:/,'').replace(/^#/,'');
      const target=visible.find(other=>other.id===id && other.scope===page.scope) ?? visible.find(other=>other.id===id);
      if(target) result+=wikiAnchor(base+'/pages/'+pageSlug(target),label);
      else if(/^https:\/\//.test(destination)) {
        try {const url=new URL(destination);result+=url.username || url.password ? html(label):`<a href="${html(url.href)}" rel="noreferrer noopener">${html(label)}</a>`;}
        catch {result+=html(label);}
      } else result+='<span class="notice">閲覧できない、または存在しないリンク</span>';
    }
    return result+html(text.slice(at));
  };
  let fence:WikiFence|undefined;
  const result:string[]=[];
  for(const raw of body.split('\n')) {
    const line=raw.replace(/\r$/,''),delimiter=wikiFenceDelimiter(line,fence);
    if(delimiter!==null) {result.push(fence ? '</pre>':'<pre>');fence=delimiter;continue;}
    if(fence) {result.push(html(line)+'\n');continue;}
    if(/^ {4}/.test(line)) {result.push('<pre>'+html(line)+'\n</pre>');continue;}
    const heading=wikiAtxHeading(line),level=heading && Math.min(6,heading.level+1);
    result.push(heading ? `<h${level}>${inline(heading.title)}</h${level}>` : line ? `<p>${inline(line)}</p>`:'');
  }
  if(fence) result.push('</pre>');
  return result.join('\n');
}
