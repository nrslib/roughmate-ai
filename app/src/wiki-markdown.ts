export interface WikiFence { character:string; length:number; }
export function wikiFenceDelimiter(line:string,fence:WikiFence|undefined):WikiFence|undefined|null {
  const delimiter=/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
  if(!delimiter) return null;
  if(fence) return delimiter[1][0]===fence.character && delimiter[1].length>=fence.length && /^[ \t]*$/.test(delimiter[2]) ? undefined:null;
  if(delimiter[1][0]==='`' && delimiter[2].includes('`')) return null;
  return {character:delimiter[1][0],length:delimiter[1].length};
}
export function wikiAtxHeading(line:string):{level:number;title:string}|undefined {
  const heading=/^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  return heading ? {level:heading[1].length,title:(heading[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/,'').trim()}:undefined;
}
