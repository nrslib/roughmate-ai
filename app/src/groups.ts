import { isDeepStrictEqual } from 'node:util';
import { answerDependencies } from './answer-evidence.js';
import { AppError, object, string, type Consultation } from './contracts.js';
export interface GroupIdentity { environmentId: string; appId: string; teamId: string; }
export interface GroupConfig extends GroupIdentity {
  lastRequestId?: string; pk: 'roughmate'; version: number; name: string; description: string;
  adminIds: string[]; notifyUserIds: string[]; intakeChannelIds: string[]; reviewChannelId?: string;
  postingUntil?: number; publicationOwner?: string;
  publicationKind?:'answer'|'draft'|'settings'|'knowledge'; lifecycle?: 'stopping'|'archived'; stopId?: string; stoppedAt?: number;
}
export interface KnowledgeDocument { kind?: 'manual'|'wiki'|'url'|'answer'; id: string; title: string; body: string; source: string; version: number; channelIds: string[]; reviewChannelIds: string[]; origins?: import('./wiki-model.js').Citation[]; accessScopes?:import('./wiki-model.js').Scope[]; }
export interface KnowledgeCatalog extends GroupIdentity { pk: 'knowledge'; version: number; documents: KnowledgeDocument[]; wikiVersion?: number; wikiDocuments?: KnowledgeDocument[]; originalDocuments?:KnowledgeDocument[]; withheldManualIds?:string[]; }
export type KnowledgeReference = KnowledgeDocument;
export const knowledgeLimits = { documents: 12, bodyBytes: 8192, catalogBytes: 120000 } as const;
export function settingsContent(config: GroupConfig): GroupConfig {
  const content = { ...config };
  delete content.postingUntil;
  delete content.publicationOwner;
  return content;
}
export function requireIdentity(actual: GroupIdentity, expected: GroupIdentity): void {
  if (actual.environmentId !== expected.environmentId || actual.appId !== expected.appId || actual.teamId !== expected.teamId) throw new AppError('group_boundary_mismatch');
}
function ids(raw: unknown, pattern: RegExp, maximum: number): string[] {
  if (!Array.isArray(raw) || raw.length > maximum || raw.some(id => typeof id !== 'string' || !pattern.test(id)) || new Set(raw).size !== raw.length) throw new AppError('invalid_group_config');
  return raw as string[];
}
export function validateGroup(raw: unknown): GroupConfig {
  const value = object(raw);
  for (const key of ['environmentId', 'appId', 'teamId']) string(value[key]);
  if (value.pk !== 'roughmate' || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new AppError('invalid_group_config');
  validateName(string(value.name));
  validateDescription(value.description);
  if (!ids(value.adminIds, /^[UW][A-Z0-9]+$/, 20).length) throw new AppError('invalid_group_config');
  const notifyUserIds = ids(value.notifyUserIds ?? [], /^[UW][A-Z0-9]+$/, 20);
  ids(value.intakeChannelIds, /^[CG][A-Z0-9]+$/, 20);
  if (value.reviewChannelId !== undefined && (typeof value.reviewChannelId !== 'string' || !/^[CG][A-Z0-9]+$/.test(value.reviewChannelId))) throw new AppError('invalid_group_config');
  if (value.postingUntil !== undefined && (!Number.isSafeInteger(value.postingUntil) || (value.postingUntil as number) < 0)) throw new AppError('invalid_group_config');
  if(value.publicationKind!==undefined && !['answer','draft','settings','knowledge'].includes(String(value.publicationKind))) throw new AppError('invalid_group_config');
  if (value.lifecycle!==undefined && (!['stopping','archived'].includes(String(value.lifecycle)) || typeof value.stopId!=='string' || !/^[a-f0-9]{32}$/.test(value.stopId) || !Number.isSafeInteger(value.stoppedAt))) throw new AppError('invalid_group_config');
  return { pk: 'roughmate', environmentId: string(value.environmentId), appId: string(value.appId), teamId: string(value.teamId),
    version: value.version as number, name: value.name as string, description: value.description as string,
    adminIds: [...value.adminIds as string[]], notifyUserIds: [...notifyUserIds], intakeChannelIds: [...value.intakeChannelIds as string[]],
    ...(value.reviewChannelId !== undefined ? { reviewChannelId: value.reviewChannelId as string } : {}),
    ...(value.lastRequestId !== undefined ? { lastRequestId: string(value.lastRequestId) } : {}),
    ...(value.postingUntil !== undefined ? { postingUntil: value.postingUntil as number } : {}),
    ...(value.publicationOwner !== undefined ? { publicationOwner: string(value.publicationOwner) } : {}),
    ...(value.publicationKind!==undefined ? {publicationKind:value.publicationKind as GroupConfig['publicationKind']}:{}) ,
    ...(value.lifecycle ? {lifecycle:value.lifecycle as GroupConfig['lifecycle'],stopId:string(value.stopId),stoppedAt:value.stoppedAt as number}:{}) };
}
export function validateName(name: string): string {
  if (!name.trim() || name.length > 35 || (/[<>]/.test(name) || [...name].some(character => character.charCodeAt(0) < 32))) throw new AppError('invalid_group_name');
  return name;
}
export function validateDescription(description: unknown): string {
  if (typeof description !== 'string' || description.length > 500) throw new AppError('invalid_group_config');
  return description;
}
export function validateSetupSeed(raw: unknown): { appId: string; name: string; description: string } {
  const value = object(raw);
  return { appId: string(value.appId), name: validateName(string(value.name)), description: validateDescription(value.description) };
}
export function requireAdmin(config: GroupConfig, user: string): void {
  if (!config.adminIds.includes(user)) throw new AppError('forbidden');
}
export function requireRunningGroup(config:GroupConfig):void {
  if(config.lifecycle) throw new AppError('bot_stopped');
}
export function requireIntake(config: GroupConfig, channel: string): void {
  requireRunningGroup(config);
  if (!config.intakeChannelIds.includes(channel)) throw new AppError('intake_channel_not_allowed');
}
export function validateDocument(raw: unknown): KnowledgeDocument {
  const value = object(raw);
  if(value.kind!==undefined && value.kind!=='manual' || value.origins!==undefined || value.accessScopes!==undefined) throw new AppError('invalid_knowledge');
  const id = string(value.id), title = string(value.title), source = string(value.source), body = string(value.body);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || title.length > 150 || source.length > 500 || Buffer.byteLength(body, 'utf8') > knowledgeLimits.bodyBytes || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new AppError('invalid_knowledge');
  return { kind:'manual', id, title, body, source, version: value.version as number, channelIds: [...ids(value.channelIds, /^[CG][A-Z0-9]+$/, 20)], reviewChannelIds: [...ids(value.reviewChannelIds, /^[CG][A-Z0-9]+$/, 20)] };
}
export function validateCatalog(raw: unknown, identity: GroupIdentity): KnowledgeCatalog {
  const value = { ...object(raw) };
  delete value.wikiVersion;
  delete value.wikiDocuments;
  delete value.originalDocuments;
  delete value.withheldManualIds;
  if (value.pk !== 'knowledge' || !Number.isSafeInteger(value.version) || (value.version as number) < 1 || !Array.isArray(value.documents) || value.documents.length > knowledgeLimits.documents || Buffer.byteLength(JSON.stringify(value), 'utf8') > knowledgeLimits.catalogBytes) throw new AppError('invalid_knowledge');
  requireIdentity(value as unknown as GroupIdentity, identity);
  const documents = value.documents.map(validateDocument);
  if (new Set(documents.map(document => document.id)).size !== documents.length) throw new AppError('invalid_knowledge');
  return { ...value, documents } as KnowledgeCatalog;
}
export function references(documents: KnowledgeDocument[]): KnowledgeReference[] {
  answerDependencies(documents);
  return documents.map(({ kind, id, title, body, source, version, channelIds, reviewChannelIds, origins, accessScopes }) => ({ kind:kind ?? 'manual', id, title, body, source, version, channelIds: [...channelIds], reviewChannelIds: [...reviewChannelIds], ...(origins ? {origins:origins.map(citation=>({...citation}))}: {}),...(accessScopes ? {accessScopes:accessScopes.map(scope=>({...scope}))}: {}) }));
}
export function validateDraftBoundary(item: Consultation, config: GroupConfig, catalog: KnowledgeCatalog): void {
  requireIdentity(item as Consultation & GroupIdentity, config);
  requireIntake(config, item.sourceChannel);
  if (item.configVersion !== config.version || item.reviewChannel !== config.reviewChannelId || !item.knowledgeReferences) throw new AppError('draft_boundary_changed');
  answerDependencies(item.knowledgeReferences);
  for (const reference of item.knowledgeReferences) {
    const kind=reference.kind ?? 'manual';
    const collection=kind==='manual' ? catalog.documents.filter(document=>!catalog.withheldManualIds?.includes(document.id)) : kind==='wiki' ? catalog.wikiDocuments ?? [] : catalog.originalDocuments ?? [];
    const matches=collection.filter(document=>document.id===reference.id && (document.kind ?? 'manual')===kind);
    const current=matches[0];
    if (matches.length!==1 || !current || current.version !== reference.version || current.title!==reference.title || current.source!==reference.source || (kind==='manual' || kind==='wiki') && current.body!==reference.body || !isDeepStrictEqual(current.origins,reference.origins) || !isDeepStrictEqual(current.accessScopes,reference.accessScopes) || !current.channelIds.includes(item.sourceChannel) || !current.reviewChannelIds.includes(item.reviewChannel) || JSON.stringify([...current.reviewChannelIds].sort()) !== JSON.stringify([...reference.reviewChannelIds].sort()) || JSON.stringify([...current.channelIds].sort()) !== JSON.stringify([...reference.channelIds].sort())) throw new AppError('knowledge_changed');
  }
}
