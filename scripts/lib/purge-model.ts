import { validateRootHistory, type RootHistory } from './root-history-model.js';
import { AppError, object, string } from '../../app/src/contracts.js';
import { validateDescriptor, validateTarget, type Descriptor, type Target } from './config.js';
export type ResourceKind = 'table' | 'secret' | 'function' | 'api' | 'queue' | 'log' | 'role' | 'policy' | 'schedule-group' | 'backup' | 'mapping';
export interface PurgeResource {
  kind: ResourceKind;
  id: string;
  arn: string;
  registrationId?: string;
  publicUrl?: string;
}
export interface PurgeApp {
  appId: string;
  registrationId?: string;
  botName?: string;
  publicUrl?: string;
}
export interface PurgePlan {
  schemaVersion: 1;
  application: 'roughmate-environment-purge';
  target: Target;
  id: string;
  descriptor: Descriptor;
  rootHistory: RootHistory;
  ownerId: string;
  teamId: string;
  apps: PurgeApp[];
  resources: PurgeResource[];
  stage: 'planned' | 'stopped' | 'slack' | 'aws' | 'history';
  drainUntil: number;
  leaseOwner: string;
  leaseUntil: number;
}
export const functionKinds = ['http', 'worker', 'wiki-runner', 'provisioner'];
export const roleKinds = [...functionKinds, 'scheduler'];
export const policyKinds = roleKinds;
export function requireRootTags(tags: Record<string, string>, target: Target): void {
  if (tags.Application !== 'roughmate-self-hosted' || tags.Environment !== target.environment)
    throw new AppError('purge_ownership');
}
export function tagMap(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw))
    throw new AppError('purge_inventory');
  return Object.fromEntries(raw.map(item => { const tag = object(item); return [string(tag.Key), string(tag.Value)]; }));
}
export function validateResource(resource: PurgeResource, target: Target): void {
  const base = `roughmate-${target.environment}`, regional = (service: string, suffix: string) => `arn:aws:${service}:${target.region}:${target.accountId}:${suffix}`;
  const child = resource.registrationId;
  if (child !== undefined && (!/^[a-f0-9]{32}$/.test(child) || !['table', 'secret', 'backup'].includes(resource.kind)))
    throw new AppError('purge_ownership');
  if (resource.publicUrl !== undefined && (resource.kind !== 'api' || resource.publicUrl !== `https://${resource.id}.execute-api.${target.region}.amazonaws.com`))
    throw new AppError('purge_ownership');
  const expected: Record<ResourceKind, boolean> = {
    table: resource.id === (child ? `${base}-bot-${child}` : base) && resource.arn === regional('dynamodb', `table/${resource.id}`),
    secret: resource.id === (child ? `${base}/bots/${child}/runtime` : `${base}/runtime`) || !child && resource.id === `${base}/configuration`,
    function: functionKinds.some(kind => resource.id === `${base}-${kind}`) && resource.arn === regional('lambda', `function:${resource.id}`),
    api: /^[a-z0-9]+$/.test(resource.id) && resource.arn === `arn:aws:apigateway:${target.region}::/apis/${resource.id}`,
    queue: ['jobs', 'dead', 'provision', 'provision-dead', 'wiki', 'wiki-dead'].some(kind => resource.id === `https://sqs.${target.region}.amazonaws.com/${target.accountId}/${base}-${kind}`) && resource.arn === regional('sqs', resource.id.split('/').at(-1)!),
    log: functionKinds.some(kind => resource.id === `/aws/lambda/${base}-${kind}`) && resource.arn === regional('logs', `log-group:${resource.id}`),
    role: roleKinds.some(kind => resource.id === `${base}-${target.region}-${kind}`) && resource.arn === `arn:aws:iam::${target.accountId}:role/${resource.id}`,
    policy: policyKinds.some(kind => resource.id === `${base}-${target.region}-${kind}-boundary`) && resource.arn === `arn:aws:iam::${target.accountId}:policy/${resource.id}`,
    'schedule-group': resource.id === `${base}-configuration` && resource.arn === regional('scheduler', `schedule-group/${resource.id}`),
    mapping: /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(resource.id) && resource.arn === regional('lambda', `event-source-mapping:${resource.id}`),
    backup: resource.id === (child ? `${base}-bot-${child}` : base) && resource.arn.startsWith(regional('dynamodb', `table/${resource.id}/backup/`)) && /^[a-zA-Z0-9-]+$/.test(resource.arn.split('/').at(-1)!)
  };
  if (!Object.hasOwn(expected, resource.kind) || !expected[resource.kind] || resource.kind === 'secret' && (!resource.arn.startsWith(regional('secretsmanager', `secret:${resource.id}-`)) || !/^[a-zA-Z0-9]{6}$/.test(resource.arn.slice(regional('secretsmanager', `secret:${resource.id}-`).length))))
    throw new AppError('purge_ownership');
}
export function validatePlan(raw: unknown, target: Target): PurgePlan {
  const value = object(raw);
  if (Object.keys(value).sort().join(',') !== ['schemaVersion', 'application', 'target', 'id', 'descriptor', 'rootHistory', 'ownerId', 'teamId', 'apps', 'resources', 'stage', 'drainUntil', 'leaseOwner', 'leaseUntil'].sort().join(','))
    throw new AppError('purge_journal');
  const savedTarget = validateTarget(object(value.target) as unknown as Target);
  if (Object.keys(savedTarget).sort().join(',') !== 'accountId,environment,region' || savedTarget.accountId !== target.accountId || savedTarget.region !== target.region || savedTarget.environment !== target.environment || value.schemaVersion !== 1 || value.application !== 'roughmate-environment-purge' || !/^[a-f0-9-]{36}$/.test(string(value.id)))
    throw new AppError('purge_journal');
  validateDescriptor(value.descriptor, target);
  if (!['planned', 'stopped', 'slack', 'aws', 'history'].includes(string(value.stage)) || !Number.isSafeInteger(value.drainUntil) || !Number.isSafeInteger(value.leaseUntil) || !/^[a-f0-9-]{36}$/.test(string(value.leaseOwner)))
    throw new AppError('purge_journal');
  validatePurgeApps(value.apps, value.descriptor as Descriptor, value.ownerId, value.teamId);
  const apps = value.apps, history = validateRootHistory(value.rootHistory);
  if (history.ownerId !== value.ownerId || history.teamId !== value.teamId || history.appIds.length !== apps.filter(app => !app.registrationId).length || history.appIds.some(id => !apps.some(app => !app.registrationId && app.appId === id)))
    throw new AppError('purge_root_history');
  validatePurgeResources(value.resources, target);
  return value as unknown as PurgePlan;
}
export function validatePurgeApps(apps: unknown, descriptor: Descriptor, ownerId: unknown, teamId: unknown): asserts apps is PurgeApp[] {
  const target = descriptor;
  if (!/^[UW][A-Z0-9]+$/.test(string(ownerId)) || !/^T[A-Z0-9]+$/.test(string(teamId)))
    throw new AppError('purge_journal');
  if (!Array.isArray(apps) || !apps.length || !apps.some(app => object(app).registrationId === undefined))
    throw new AppError('purge_journal');
  const appIds = new Set<string>();
  for (const rawApp of apps) {
    const app = object(rawApp);
    if (Object.keys(app).some(key => !['appId', 'registrationId', 'botName', 'publicUrl'].includes(key)) || !/^A[A-Z0-9]+$/.test(string(app.appId)) || appIds.has(string(app.appId)) || app.registrationId !== undefined && (!/^[a-f0-9]{32}$/.test(string(app.registrationId)) || app.botName !== undefined && !/^[a-z][a-z0-9._-]{0,34}$/.test(string(app.botName))))
      throw new AppError('purge_journal');
    if (app.publicUrl !== undefined)
      validateDescriptor({ ...descriptor, publicUrl: app.publicUrl }, target);
    appIds.add(string(app.appId));
  }
}
export function validatePurgeResources(resources: unknown, target: Target): asserts resources is PurgeResource[] {
  if (!Array.isArray(resources))
    throw new AppError('purge_journal');
  const resourceIds = new Set<string>();
  for (const item of resources) {
    const resource = object(item);
    if (Object.keys(resource).some(key => !['kind', 'id', 'arn', 'registrationId', 'publicUrl'].includes(key)))
      throw new AppError('purge_journal');
    validateResource(resource as unknown as PurgeResource, target);
    const key = `${resource.kind}:${resource.arn}`;
    if (resourceIds.has(key))
      throw new AppError('purge_journal');
    resourceIds.add(key);
  }
}
