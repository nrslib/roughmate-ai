import { AppError } from './contracts.js';
import { hashText } from './wiki-contract.js';

// 比較証跡ではMap順を除外し、JSONでは消えるundefinedフィールドも区別する。
function contentText(value:unknown):string {
  if(value===null) return 'null';
  switch(typeof value) {
    case 'undefined': return 'undefined';
    case 'string': return JSON.stringify(value);
    case 'boolean': return String(value);
    case 'number': return Object.is(value,-0) ? '-0':String(value);
    case 'object': {
      if(Array.isArray(value)) return `[${Array.from(value,contentText).join(',')}]`;
      const prototype=Object.getPrototypeOf(value);
      if(prototype!==Object.prototype && prototype!==null) throw new AppError('invalid_wiki');
      const record=value as Record<string,unknown>;
      return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${contentText(record[key])}`).join(',')}}`;
    }
    default: throw new AppError('invalid_wiki');
  }
}
export function wikiContentHash(value:unknown):string {return hashText(contentText(value));}
