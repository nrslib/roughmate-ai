import type { WebClient } from '@slack/web-api';
type Manifest = Parameters<WebClient['apps']['manifest']['update']>[0]['manifest'];
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateName } from '../../app/src/groups.js';
import { AppError, object, string } from '../../app/src/contracts.js';
export interface Target { accountId: string; region: string; environment: string; }
export interface Descriptor extends Target { schemaVersion: 1; application: 'roughmate-self-hosted'; publicUrl: string; secretArn: string; tableName: string; queueUrl: string; }
export interface RemovalRecord extends Target { schemaVersion: 1; application: 'roughmate-self-hosted'; publicUrl: string; appId?: string; slackStatus: 'not-created' | 'present' | 'deleted'; awsStatus: 'destroying' | 'destroyed'; }
export type SlackTarget = Target & { publicUrl: string };
export function slackAppIdentifier(target: SlackTarget): string {
  validateTarget(target);
  validatePublicUrl(target.publicUrl, target);
  return 'roughmate-self-hosted:v1:' + createHash('sha256').update(JSON.stringify([target.accountId,target.region,target.environment,target.publicUrl])).digest('hex');
}
export function requireSlackAppTarget(raw: unknown, target: SlackTarget): void {
  const value = object(raw);
  const description = object(value.display_information).description;
  if (typeof description !== 'string' || !description.endsWith(` [${slackAppIdentifier(target)}]`)) throw new AppError('slack_target_mismatch');
  if (value.oauth_config !== undefined) {
    const redirects = object(value.oauth_config).redirect_urls;
    if (redirects !== undefined && (!Array.isArray(redirects) || redirects.some(url => ![target.publicUrl + '/oauth/callback', target.publicUrl + '/channel-authorization/callback', target.publicUrl + '/wiki/auth/callback'].includes(String(url))))) throw new AppError('slack_target_mismatch');
  }
  if (value.settings !== undefined) {
    const settings = object(value.settings);
    for (const [key,path] of [['event_subscriptions','/slack/events'],['interactivity','/slack/interactive']]) {
      if (settings[key] !== undefined) {
        const url = object(settings[key]).request_url;
        if (url !== undefined && url !== target.publicUrl + path) throw new AppError('slack_target_mismatch');
      }
    }
  }
}
export function validateRegion(region: string): string {
  if (!/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*$/.test(region)) throw new AppError('unsupported_region');
  return region;
}
export function validateTarget(value: Target): Target {
  validateRegion(value.region);
  if (!/^\d{12}$/.test(value.accountId) || !/^[a-z]{2}-[a-z]+-\d+$/.test(value.region) || !/^[a-z][a-z0-9-]{0,23}$/.test(value.environment)) throw new AppError('invalid_target');
  return value;
}
export function location(target: Target): { bucket: string; descriptorKey: string; removalKey: string; stateKey: string } {
  validateTarget(target);
  return { bucket: `roughmate-state-${target.accountId}-${target.region}`, descriptorKey: `environments/${target.environment}/setup.json`, removalKey: `environments/${target.environment}/removal.json`, stateKey: `environments/${target.environment}/terraform.tfstate` };
}
export function validateRemovalRecord(raw: unknown, target: Target): RemovalRecord {
  const value = object(raw);
  const keys = ['schemaVersion','application','accountId','region','environment','publicUrl','appId','slackStatus','awsStatus'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.filter(key => key !== 'appId').some(key => !(key in value))) throw new AppError('invalid_removal_record');
  if (value.schemaVersion !== 1 || value.application !== 'roughmate-self-hosted' || value.accountId !== target.accountId || value.region !== target.region || value.environment !== target.environment) throw new AppError('target_mismatch');
  validatePublicUrl(value.publicUrl, target);
  if (!['destroying','destroyed'].includes(string(value.awsStatus)) || !['not-created','present','deleted'].includes(string(value.slackStatus))) throw new AppError('invalid_removal_record');
  if (value.slackStatus === 'not-created' ? value.appId !== undefined : typeof value.appId !== 'string' || !/^A[A-Z0-9]+$/.test(value.appId)) throw new AppError('invalid_removal_record');
  return value as unknown as RemovalRecord;
}
function validatePublicUrl(raw: unknown, target: Target): void {
  const url = new URL(string(raw));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !new RegExp(`^[a-z0-9]+\\.execute-api\\.${target.region}\\.amazonaws\\.com$`).test(url.hostname)) throw new AppError('invalid_descriptor');
}
export function validateDescriptor(raw: unknown, target: Target): Descriptor {
  const value = object(raw);
  const keys = ['schemaVersion','application','accountId','region','environment','publicUrl','secretArn','tableName','queueUrl'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new AppError('invalid_descriptor');
  if (value.schemaVersion !== 1 || value.application !== 'roughmate-self-hosted' || value.accountId !== target.accountId || value.region !== target.region || value.environment !== target.environment) throw new AppError('target_mismatch');
  validatePublicUrl(value.publicUrl, target);
  if (!string(value.secretArn).startsWith(`arn:aws:secretsmanager:${target.region}:${target.accountId}:secret:roughmate-${target.environment}/runtime-`) || value.tableName !== `roughmate-${target.environment}` || string(value.queueUrl) !== `https://sqs.${target.region}.amazonaws.com/${target.accountId}/roughmate-${target.environment}-jobs`) throw new AppError('invalid_descriptor');
  return value as unknown as Descriptor;
}
export async function manifest(descriptor: Descriptor, name?: string, existingBotName?: string): Promise<Manifest> {
  const value = object(JSON.parse(await readFile(new URL('../../slack/manifest.json', import.meta.url), 'utf8')));
  const settings = object(value.settings);
  const display = object(value.display_information);
  const description = `${string(display.description)} [${slackAppIdentifier(descriptor)}]`;
  // Slackの実APIは日本語の短い説明もUTF-8バイト数で上限を判定する。
  if (Buffer.byteLength(description, 'utf8') > 140) throw new AppError('invalid_manifest');
  const selectedName = validateName(name ?? string(display.name));
  const generatedBotName = `roughmate-${descriptor.environment}`;
  if (!/^[a-z0-9._-]{1,80}$/.test(generatedBotName)) throw new AppError('invalid_manifest');
  // 既存名はSlackがexportした値だけを引き継ぐ。新規名は仕様表のASCII制約に合わせる。
  if (existingBotName !== undefined && (!existingBotName.trim() || existingBotName.length > 80 || [...existingBotName].some(character => character.charCodeAt(0) < 32))) throw new AppError('invalid_manifest');
  const features = object(value.features);
  return { ...value, features: { ...features, bot_user: { ...object(features.bot_user), display_name: existingBotName ?? generatedBotName } }, display_information: { ...display, name: selectedName, description }, oauth_config: { ...object(value.oauth_config), redirect_urls: [descriptor.publicUrl + '/oauth/callback', descriptor.publicUrl + '/channel-authorization/callback', descriptor.publicUrl + '/wiki/auth/callback'] }, settings: { ...settings, event_subscriptions: { ...object(settings.event_subscriptions), request_url: descriptor.publicUrl + '/slack/events' }, interactivity: { ...object(settings.interactivity), request_url: descriptor.publicUrl + '/slack/interactive' } } } as Manifest;
}
