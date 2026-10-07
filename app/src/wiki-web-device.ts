import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AppError, type Secrets } from './contracts.js';

export const wikiDeviceCookie='__Host-roughmate-wiki';
function sessionId(event:APIGatewayProxyEventV2):string {
  const values=(event.cookies ?? []).flatMap(value=>value.split(';')).map(value=>value.trim()).filter(value=>value.startsWith(wikiDeviceCookie+'='));
  const value=values.length===1 ? values[0].slice(wikiDeviceCookie.length+1):undefined;
  return value && /^[a-f0-9]{64}$/.test(value) ? value:'anonymous';
}
function bodyHash(event:APIGatewayProxyEventV2):string {
  const body=event.isBase64Encoded ? Buffer.from(event.body ?? '','base64'):Buffer.from(event.body ?? '');
  if(body.length>32000) throw new AppError('invalid_input');
  return createHash('sha256').update(body).digest('hex');
}
function requestBinding(event:APIGatewayProxyEventV2):string {
  return JSON.stringify([event.requestContext.http.method,event.rawPath,event.rawQueryString,bodyHash(event),createHash('sha256').update(sessionId(event)).digest('hex')]);
}
function mac(text:string,secrets:Secrets):string {return createHmac('sha256',secrets.signingSecret).update('wiki-device-v1:'+text).digest('hex');}
export function deviceChallenge(event:APIGatewayProxyEventV2,secrets:Secrets):string {
  const payload=Buffer.from(JSON.stringify([Math.floor(Date.now()/1000),requestBinding(event)])).toString('base64url');
  return payload+'.'+mac(payload,secrets);
}
export function requireDeviceRequest(event:APIGatewayProxyEventV2,secrets:Secrets,expectedKey?:string):string {
  const key=event.headers['x-wiki-device-key'],challenge=event.headers['x-wiki-device-challenge'],signature=event.headers['x-wiki-device-signature'];
  if(!key || key.length>300 || expectedKey && key!==expectedKey || !challenge || challenge.length>2000 || !signature || !/^[A-Za-z0-9_-]{86}$/.test(signature)) throw new AppError('wiki_device_required');
  try {
    const [payload,digest,...rest]=challenge.split('.');
    if(rest.length || !/^[a-f0-9]{64}$/.test(digest) || !timingSafeEqual(Buffer.from(digest),Buffer.from(mac(payload,secrets)))) throw new Error('invalid');
    const [issued,binding]=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as unknown[];
    if(!Number.isSafeInteger(issued) || Number(issued)>Math.floor(Date.now()/1000)+5 || Number(issued)<Math.floor(Date.now()/1000)-60 || binding!==requestBinding(event)) throw new Error('invalid');
    const publicKey=createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'});
    if(publicKey.asymmetricKeyType!=='ec' || publicKey.asymmetricKeyDetails?.namedCurve!=='prime256v1' || !verify('sha256',Buffer.from(challenge),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'))) throw new Error('invalid');
    return key;
  } catch {throw new AppError('wiki_device_required');}
}
// A non-extractable IndexedDB key survives reloads and new tabs, while copied cookies cannot sign requests.
export const wikiDeviceScript=`(async()=>{
 const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))),urlEncode=bytes=>encode(bytes).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
 const database=await new Promise((resolve,reject)=>{const open=indexedDB.open('roughmate-wiki-device',1);open.onupgradeneeded=()=>open.result.createObjectStore('keys');open.onerror=()=>reject(open.error);open.onsuccess=()=>resolve(open.result);});
 const read=()=>new Promise((resolve,reject)=>{const transaction=database.transaction('keys','readonly'),request=transaction.objectStore('keys').get('device');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 let pair=await read();
 if(!pair){const generated=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);pair=await new Promise((resolve,reject)=>{const transaction=database.transaction('keys','readwrite'),store=transaction.objectStore('keys'),request=store.get('device');let chosen;request.onsuccess=()=>{chosen=request.result||generated;if(!request.result)store.put(chosen,'device');};transaction.oncomplete=()=>resolve(chosen);transaction.onerror=()=>reject(transaction.error);});}
 const publicKey=encode(await crypto.subtle.exportKey('spki',pair.publicKey));
 const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(value=>value.toString(16).padStart(2,'0')).join('');
 const signed=async(path,method,body)=>{
  const challengeResponse=await fetch('/wiki/device/challenge?'+new URLSearchParams({path,method,hash:await digest(body||'')}),{credentials:'same-origin',cache:'no-store'});
  if(!challengeResponse.ok)throw new Error('challenge');const challenge=await challengeResponse.text();
  const signature=urlEncode(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(challenge)));
  return fetch(path,{method,body:method==='POST'?body:undefined,credentials:'same-origin',cache:'no-store',headers:{'x-wiki-device-key':publicKey,'x-wiki-device-challenge':challenge,'x-wiki-device-signature':signature,...(method==='POST'?{'content-type':'application/x-www-form-urlencoded'}:{})}});
 };
 const forms=()=>{window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});for(const form of document.querySelectorAll('form[method="post"]'))form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');if(button)button.disabled=true;try{const path=new URL(form.action).pathname,body=new URLSearchParams(new FormData(form)).toString();await show(await signed(path,'POST',body));}catch{if(button)button.disabled=false;document.getElementById('wiki-device-status')?.replaceChildren(document.createTextNode('本人確認を完了できません。Slack Homeから開き直してください。'));}});};
 const show=async response=>{const redirect=response.headers.get('x-wiki-location');if(redirect){location.assign(redirect);return;}const text=await response.text();document.open();document.write(text);document.close();forms();};
 await show(await signed(location.pathname+location.search,'GET'));
})().catch(()=>{document.getElementById('wiki-device-status')?.replaceChildren(document.createTextNode('このブラウザで本人確認を完了できません。HTTPSで開き、Cookieとブラウザ内の保存を許可してから、Slack Homeで開き直してください。'));});`;
export const wikiDeviceScriptHash=createHash('sha256').update(wikiDeviceScript).digest('base64');
export function deviceShell():string {return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wikiを開いています</title><p id="wiki-device-status">本人確認をしています。しばらくお待ちください。</p><script>${wikiDeviceScript}</script></html>`;}
function deviceTarget(path:string):URL {
  if(path.length>1500 || !/^\/wiki\/(?:root|bots\/[a-f0-9]{32}|archives|login|logout)(?:\/[a-zA-Z0-9_%=&./-]*)?(?:\?[a-zA-Z0-9_%=&./-]*)?$/.test(path) || path.includes('//')) throw new AppError('invalid_input');
  const url=new URL(path,'https://wiki.invalid');
  let decoded:string;
  try {decoded=decodeURIComponent(path);} catch {throw new AppError('invalid_input');}
  // URL normalization must not change the encoded target that the browser signs and fetches.
  if(url.pathname+url.search!==path || /\p{Cc}/u.test(decoded) || /%(?:2f|5c|3f|23|25)/i.test(url.pathname) || decodeURIComponent(url.pathname).split('/').some(segment=>segment==='.' || segment==='..')) throw new AppError('invalid_input');
  return url;
}
export function challengeForTarget(event:APIGatewayProxyEventV2,secrets:Secrets):string {
  const path=event.queryStringParameters?.path,method=event.queryStringParameters?.method,hash=event.queryStringParameters?.hash;
  if(!path || !['GET','POST'].includes(method ?? '') || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError('invalid_input');
  const url=deviceTarget(path);
  if(url.pathname==='/wiki/login' && url.searchParams.has('return')) {
    const returns=url.searchParams.getAll('return');
    if(returns.length!==1 || !/^\/wiki\/(?:root|bots\/[a-f0-9]{32}|archives)(?:[/?]|$)/.test(returns[0])) throw new AppError('invalid_input');
    deviceTarget(returns[0]);
  }
  const binding=JSON.stringify([method,url.pathname,url.search.slice(1),hash,createHash('sha256').update(sessionId(event)).digest('hex')]),payload=Buffer.from(JSON.stringify([Math.floor(Date.now()/1000),binding])).toString('base64url');
  return payload+'.'+mac(payload,secrets);
}
