import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { AppError } from './contracts.js';

export const sourceLimits = { bytes: 65536, redirects: 3, timeoutMs: 10000, dnsMs: 1500 } as const;
const blocked = new BlockList();
for (const [address, prefix] of [ ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',3] ] as const) blocked.addSubnet(address, prefix, 'ipv4');
const publicIpv6=new BlockList();
// IANA Global Unicast Address Space (2025-10-10): 表にない範囲も予約済み。
for (const [address, prefix] of [
  ['2001:200::',23], ['2001:400::',23], ['2001:600::',23], ['2001:800::',22],
  ['2001:c00::',23], ['2001:e00::',23], ['2001:1200::',23], ['2001:1400::',22],
  ['2001:1800::',23], ['2001:1a00::',23], ['2001:1c00::',22], ['2001:2000::',19],
  ['2001:4000::',23], ['2001:4200::',23], ['2001:4400::',23], ['2001:4600::',23],
  ['2001:4800::',23], ['2001:4a00::',23], ['2001:4c00::',23], ['2001:5000::',20],
  ['2001:8000::',19], ['2001:a000::',20], ['2001:b000::',20], ['2003::',18],
  ['2400::',12], ['2410::',12], ['2600::',12], ['2610::',23], ['2620::',23],
  ['2630::',12], ['2800::',12], ['2a00::',12], ['2a10::',12], ['2c00::',12]
] as const) publicIpv6.addSubnet(address, prefix, 'ipv6');
const ipv6Exceptions = new BlockList();
for (const [address, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]] as const) ipv6Exceptions.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && publicIpv6.check(address,'ipv6') && !ipv6Exceptions.check(address,'ipv6');
}
export function publicSourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('invalid_source_url'); }
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (raw.length > 500 || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host) || isIP(host) && !isPublicAddress(host)) throw new AppError('invalid_source_url');
  return url;
}
export interface PublicSource { url: string; contentType: string; raw: string; text: string; }
export async function resolvePublicHost(host: string, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const timerSignal = AbortSignal.any([signal, AbortSignal.timeout(sourceLimits.dnsMs)]);
  const answers = await new Promise<{address:string;family:number}[]>((resolve,reject) => {
    const abort = () => reject(new AppError('source_timeout'));
    timerSignal.addEventListener('abort',abort,{once:true});
    dns.lookup(host, { all:true, verbatim:true }).then(resolve,reject).finally(() => timerSignal.removeEventListener('abort',abort));
  });
  if (!Array.isArray(answers) || !answers.length || answers.length > 16 || answers.some(answer => !isPublicAddress(answer.address))) throw new AppError('source_address_forbidden');
  return {address:answers[0].address, family:answers[0].family as 4|6};
}
async function readPage(url: URL, signal: AbortSignal): Promise<{ redirect?: string; raw?: string; type?: string }> {
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const address = await resolvePublicHost(host,signal);
  const response = await new Promise<import('node:http').IncomingMessage>((resolve,reject) => {
    const req = https.request(url, { method:'GET', agent:false, family:address.family, signal, headers:{ accept:'text/html,text/plain,text/markdown', 'accept-encoding':'gzip, deflate, br', 'user-agent':'Roughmate-Wiki/1' },
      lookup: (_host,_options,callback) => callback(null,address.address,address.family) },resolve);
    req.on('error',reject);
    req.end();
  });
  try {
    if ([301,302,303,307,308].includes(response.statusCode ?? 0)) {
      if (!response.headers.location) throw new AppError('invalid_source_redirect');
      return {redirect:response.headers.location};
    }
    if (response.statusCode !== 200) throw new AppError('source_fetch_failed');
    const contentType = response.headers['content-type'] ?? '';
    const type = contentType.split(';')[0].trim().toLowerCase();
    const charset=contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
    if (!['text/html','text/plain','text/markdown'].includes(type) || charset && charset.toLowerCase()!=='utf-8') throw new AppError('source_type_unsupported');
    if (Number(response.headers['content-length']) > sourceLimits.bytes) throw new AppError('source_too_large');
    let compressedBytes = 0;
    const limited = Readable.from((async function* () {
      for await (const chunk of response) {
        const buffer = Buffer.from(chunk);
        compressedBytes += buffer.length;
        if (compressedBytes > sourceLimits.bytes) throw new AppError('source_too_large');
        yield buffer;
      }
    })());
    const encoding = response.headers['content-encoding'];
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
    if (encoding && encoding !== 'identity' && !decoder) throw new AppError('source_type_unsupported');
    const stream = decoder ? limited.pipe(decoder) : limited;
    if (decoder) limited.on('error',error => decoder.destroy(error));
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > sourceLimits.bytes) throw new AppError('source_too_large');
        chunks.push(buffer);
      }
    } finally { limited.destroy(); decoder?.destroy(); }
    let raw: string;
    try { raw = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)); } catch { throw new AppError('source_encoding_invalid'); }
    if (!raw.trim() || [...raw].some(character=>character.charCodeAt(0)<32 && !['\t','\r','\n'].includes(character))) throw new AppError('source_encoding_invalid');
    return {raw,type};
  } finally { response.destroy(); }
}
export async function fetchPublicSource(rawUrl: string): Promise<PublicSource> {
  const signal = AbortSignal.timeout(sourceLimits.timeoutMs);
  let url = publicSourceUrl(rawUrl);
  for (let redirects=0; redirects <= sourceLimits.redirects; redirects++) {
    signal.throwIfAborted();
    const page = await readPage(url,signal);
    if (page.redirect) { url = publicSourceUrl(new URL(page.redirect,url).href); continue; }
    const raw = page.raw!;
    const text = page.type === 'text/html' ? raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g,entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[entity]!).replace(/\s+/g,' ').trim() : raw;
    if (!text.trim()) throw new AppError('source_encoding_invalid');
    return {url:url.href,contentType:page.type!,raw,text};
  }
  throw new AppError('source_redirect_limit');
}
