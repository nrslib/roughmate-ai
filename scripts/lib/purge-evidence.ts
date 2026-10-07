import { provenRootHistory, readRootGenesis, readRootLedger, protectedRootHistory, requireRootTableHistory, bindPurgeRootOwner } from './root-history.js';
import { validateRootHistory, type RootHistory } from './root-history-model.js';
import { stateResources } from './purge-resources.js';
import { PurgeAwsCli } from './purge-inventory.js';
import { environmentSignal } from './environment-lease.js';
import type { RemovalRecord } from './config.js';
import { isDeepStrictEqual } from 'node:util';
import { readStateJson } from './purge-journal.js';
import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AppError, object, string } from '../../app/src/contracts.js';
import { Registrations, childResources, type Registration } from '../../app/src/registration.js';
import { location, validateDescriptor, type Descriptor, type Target } from './config.js';
import type { SetupAws } from './aws.js';
import { environmentFence } from './environment-lease.js';
import { validatePurgeApps, validatePurgeResources, type PurgeApp, type PurgeResource } from './purge-model.js';
export interface PurgeEvidence {
  schemaVersion: 2;
  application: 'roughmate-purge-evidence';
  descriptor: Descriptor;
  rootHistory: RootHistory;
  ownerId: string;
  teamId: string;
  apps: PurgeApp[];
  registrationIds: string[];
  resources: PurgeResource[];
}
export function evidenceKey(target: Target): string { return `environments/${target.environment}/protected-purge/evidence.json`; }
export function validateEvidence(raw: unknown, target: Target): PurgeEvidence {
  const value = object(raw);
  if (Object.keys(value).sort().join(',') !== 'application,apps,descriptor,ownerId,registrationIds,resources,rootHistory,schemaVersion,teamId' || value.schemaVersion !== 2 || value.application !== 'roughmate-purge-evidence' || !Array.isArray(value.registrationIds) || value.registrationIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) || new Set(value.registrationIds).size !== value.registrationIds.length)
    throw new AppError('purge_evidence_missing');
  const ids = value.registrationIds as string[];
  const descriptor = validateDescriptor(value.descriptor, target);
  validatePurgeApps(value.apps, descriptor, value.ownerId, value.teamId);
  validatePurgeResources(value.resources, target);
  const apps = value.apps, history = validateRootHistory(value.rootHistory);
  if (history.ownerId !== value.ownerId || history.teamId !== value.teamId || history.appIds.length !== apps.filter(app => !app.registrationId).length || history.appIds.some(id => !apps.some(app => !app.registrationId && app.appId === id)))
    throw new AppError('purge_root_history');
  if (!apps.some(app => !app.registrationId) || apps.some(app => app.registrationId && !ids.includes(app.registrationId)) || ids.some(id => !apps.some(app => app.registrationId === id)) || value.resources.some(resource => !resource.registrationId || !ids.includes(resource.registrationId) || !['table', 'secret'].includes(resource.kind)))
    throw new AppError('purge_evidence_missing');
  return value as unknown as PurgeEvidence;
}
export async function immutableArchives(aws: SetupAws, descriptor: Descriptor, ownerId: string): Promise<Registration[]> {
  const entries: Registration[] = [], cursors = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await aws.db.send(new ScanCommand({ TableName: descriptor.tableName, ConsistentRead: true, FilterExpression: 'begins_with(pk, :archive)', ExpressionAttributeValues: { ':archive': 'bot-archive#' }, ExclusiveStartKey: cursor }), { abortSignal: environmentSignal() });
    for (const raw of page.Items ?? []) {
      const archive = object(raw), entry = object(archive.entry) as unknown as Registration;
      if (!/^A[A-Z0-9]+$/.test(String(entry.appId)) || archive.pk !== `bot-archive#${entry.id}` || archive.parentSecret !== descriptor.secretArn || archive.rootOwner !== ownerId || !Number.isFinite(Date.parse(string(archive.deletedAt))) || entries.some(old => old.id === entry.id))
        throw new AppError('purge_ownership');
      entries.push(entry);
    }
    cursor = page.LastEvaluatedKey;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (cursors.has(key))
        throw new AppError('purge_inventory');
      cursors.add(key);
    }
  } while (cursor);
  return entries;
}
// Explicit administrator removal preserves identity before workspace/root storage is discarded.
async function savePurgeEvidence(aws: SetupAws, descriptor: Descriptor): Promise<void> {
  const workspace = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'workspace' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
  if (!workspace) {
    const saved = await readStateJson(aws, evidenceKey(aws.target));
    const setup = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
    const previous = saved ? validateEvidence(saved.value, aws.target) : undefined;
    if (previous && (await new PurgeAwsCli(aws.target).inventory()).some(resource => resource.registrationId && !previous.registrationIds.includes(resource.registrationId)))
      throw new AppError('purge_orphan_unknown');
    if (previous) {
      const ledger=await protectedRootHistory(aws);
      await requireRootTableHistory(aws,ledger);
      if (ledger.genesisId!==previous.rootHistory.genesisId||ledger.tableId!==previous.rootHistory.tableId||ledger.appIds.join(',')!==previous.rootHistory.appIds.join(',')) throw new AppError('purge_root_history');
    }
    if (previous && isDeepStrictEqual(previous.descriptor, descriptor) && setup?.phase === 'deleted' && previous.apps.some(app => !app.registrationId && app.appId === setup.appId))
      return;
    throw new AppError('purge_evidence_missing');
  }
  if (!/^[UW][A-Z0-9]+$/.test(String(workspace.ownerId)) || !/^T[A-Z0-9]+$/.test(String(workspace.teamId)))
    throw new AppError('purge_owner_missing');
  const setup = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
  if (setup?.phase === 'creating')
    throw new AppError('slack_creation_ambiguous');
  const secrets = setup?.phase === 'deleted' ? undefined : await aws.readSecrets(descriptor);
  if (setup?.appId && secrets && setup.appId !== secrets.appId)
    throw new AppError('purge_ownership');
  const rootId = setup?.appId ?? secrets?.appId;
  if (!rootId)
    throw new AppError('purge_evidence_missing');
  const registry = await new Registrations(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region).read();
  if (registry.entries.length)
    throw new AppError('registration_children_present');
  const rootHistory = await provenRootHistory(aws, descriptor, setup, string(rootId), string(workspace.ownerId), string(workspace.teamId));
  for (const previous of (await purgeHistoryEvidence(aws)).evidence)
    if (previous.ownerId !== workspace.ownerId || previous.teamId !== workspace.teamId || previous.rootHistory.genesisId !== rootHistory.genesisId || previous.rootHistory.tableId !== rootHistory.tableId || previous.rootHistory.appIds.some((id, index) => rootHistory.appIds[index] !== id))
      throw new AppError('purge_root_history');
  const apps: PurgeApp[] = rootHistory.appIds.map(appId => ({ appId }));
  if (setup?.retiredAppId && !apps.some(app=>app.appId===setup.retiredAppId))
    apps.push({ appId: string(setup.retiredAppId) });
  const resources: PurgeResource[] = [];
  const entries = await immutableArchives(aws, descriptor, string(workspace.ownerId));
  for (const entry of entries) {
    const expected = childResources(descriptor.tableName, descriptor.secretArn, entry.id);
    if (entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || !/^A[A-Z0-9]+$/.test(entry.parentAppId) || entry.secretArn && (!entry.secretArn.startsWith(expected.secretPrefix) || !/^[A-Za-z0-9]{6}$/.test(entry.secretArn.slice(expected.secretPrefix.length))))
      throw new AppError('purge_ownership');
    resources.push({ kind: 'table', id: expected.tableName, arn: `arn:aws:dynamodb:${aws.target.region}:${aws.target.accountId}:table/${expected.tableName}`, registrationId: entry.id });
    if (entry.secretArn)
      resources.push({ kind: 'secret', id: expected.secretName, arn: entry.secretArn, registrationId: entry.id });
    if (!rootHistory.appIds.includes(entry.parentAppId))
      throw new AppError('purge_root_history');
    if (entry.appId)
      apps.push({ appId: entry.appId, registrationId: entry.id, botName: entry.botName });
    else if (entry.createOwner || !['queued', 'resources', 'failed'].includes(entry.phase))
      throw new AppError('purge_creation_unknown');
  }
  if ((await new PurgeAwsCli(aws.target).inventory()).some(resource => resource.registrationId && !entries.some(entry => entry.id === resource.registrationId)))
    throw new AppError('purge_orphan_unknown');
  await bindPurgeRootOwner(aws,rootHistory,string(workspace.ownerId),string(workspace.teamId));
  const evidence = validateEvidence({ schemaVersion: 2, application: 'roughmate-purge-evidence', descriptor, rootHistory, ownerId: workspace.ownerId, teamId: workspace.teamId, apps, registrationIds: entries.map(entry => entry.id), resources }, aws.target);
  await environmentFence();
  await aws.s3.send(new PutObjectCommand({ Bucket: location(aws.target).bucket, Key: evidenceKey(aws.target), ExpectedBucketOwner: aws.target.accountId, Body: JSON.stringify(evidence), ContentType: 'application/json', ServerSideEncryption: 'AES256' }), { abortSignal: environmentSignal() });
}
export async function purgeHistoryEvidence(aws: SetupAws): Promise<{
  evidence: PurgeEvidence[];
  states: unknown[];
}> {
  await readRootGenesis(aws);
  await readRootLedger(aws);
  const place = location(aws.target), prefix = `environments/${aws.target.environment}/`, evidence: PurgeEvidence[] = [], states: unknown[] = [];
  const knownKeys = new Set([place.descriptorKey,place.removalKey,`${place.stateKey}.tflock`,`${prefix}operation.json`,`${prefix}protected-purge/plan.json`,`${prefix}protected-purge/anchor.json`,`${prefix}protected-purge/root-genesis.json`,`${prefix}protected-purge/root-ledger.json`]);
  const statePath = (key: string) => key.startsWith(`${prefix}workspaces/`) || /\.tfstate(?:\.backup)?$/.test(key);
  let unsupportedState = false;
  let keyMarker: string | undefined, versionMarker: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = await aws.s3.send(new ListObjectVersionsCommand({ Bucket: place.bucket, Prefix: prefix, ExpectedBucketOwner: aws.target.accountId, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: environmentSignal() });
    for (const marker of page.DeleteMarkers ?? []) {
      if (!marker.Key?.startsWith(prefix) || !marker.VersionId) throw new AppError('purge_history');
      if (marker.Key !== place.stateKey && (statePath(marker.Key) || !knownKeys.has(marker.Key) && marker.Key !== evidenceKey(aws.target))) unsupportedState = true;
    }
    for (const version of page.Versions ?? []) {
      if (!version.Key?.startsWith(prefix) || !version.VersionId)
        throw new AppError('purge_history');
      if ([`${prefix}protected-purge/root-genesis.json`,`${prefix}protected-purge/root-ledger.json`].includes(version.Key)) continue;
      let value: unknown;
      try {
        const raw = await aws.s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: version.Key, VersionId: version.VersionId, ExpectedBucketOwner: aws.target.accountId }), { abortSignal: environmentSignal() });
        value = JSON.parse(string(await raw.Body?.transformToString()));
      }
      catch {
        throw new AppError('purge_state_unavailable');
      }
      if (version.Key === evidenceKey(aws.target)) evidence.push(validateEvidence(value, aws.target));
      else if (version.Key === place.stateKey || statePath(version.Key) || value && typeof value === 'object' && !Array.isArray(value) && ('terraform_version' in value || 'version' in value && 'resources' in value || 'resources' in value && !('application' in value))) {
        stateResources(value,aws.target);
        states.push(value);
        if (version.Key !== place.stateKey) unsupportedState = true;
      }
    }
    if (page.IsTruncated !== true)
      break;
    if (!page.NextKeyMarker || cursors.has(`${page.NextKeyMarker}:${page.NextVersionIdMarker}`))
      throw new AppError('purge_history');
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
    cursors.add(`${keyMarker}:${versionMarker}`);
  }
  if (unsupportedState) throw new AppError('purge_terraform_workspace');
  return { evidence, states };
}
export async function preservePurgeEvidence(aws: SetupAws, descriptor: Descriptor): Promise<void> {
  try {
    await savePurgeEvidence(aws, descriptor);
  }
  catch (error) {
    if (error instanceof AppError)
      throw error;
    throw new AppError('purge_evidence_save');
  }
}
export async function requirePurgeEvidenceForRemoval(aws: SetupAws, record: RemovalRecord): Promise<void> {
  const saved = await readStateJson(aws, evidenceKey(aws.target));
  const proof = saved ? validateEvidence(saved.value, aws.target) : undefined;
  if (!proof || proof.descriptor.publicUrl !== record.publicUrl || !record.appId || !proof.apps.some(app => !app.registrationId && app.appId === record.appId))
    throw new AppError('purge_evidence_missing');
  if ((await new PurgeAwsCli(aws.target).inventory()).some(resource => resource.registrationId && !proof.registrationIds.includes(resource.registrationId)))
    throw new AppError('purge_orphan_unknown');
}
