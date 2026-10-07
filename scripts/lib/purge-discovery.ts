import { provenRootHistory, protectedRootHistory, requireRootTableHistory } from './root-history.js';
import { environmentSignal } from './environment-lease.js';
import { randomUUID } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AppError, object, string, validateSecrets } from '../../app/src/contracts.js';
import { Registrations, childResources } from '../../app/src/registration.js';
import { confirmedCreateFailure } from '../../app/src/provisioner.js';
import { validateGroup } from '../../app/src/groups.js';
import { immutableArchives, purgeHistoryEvidence } from './purge-evidence.js';
import { canonicalResources, inspectResource, mergeResources, secretResource, stateResources } from './purge-resources.js';
import { type SetupAws } from './aws.js';
import { location, validateDescriptor } from './config.js';
import { readStateJson } from './purge-journal.js';
import { type PurgeAwsCli } from './purge-inventory.js';
import { validatePlan, type PurgePlan, type PurgeApp } from './purge-model.js';
export async function discoverPurge(aws: SetupAws, cli: PurgeAwsCli): Promise<PurgePlan> {
  const history = await purgeHistoryEvidence(aws);
  const known = history.states.flatMap(state => stateResources(state, aws.target));
  const saved = await readStateJson(aws, location(aws.target).descriptorKey);
  const removal = saved ? undefined : await aws.removal();
  const retained = history.evidence.find(proof => proof.descriptor.publicUrl === removal?.publicUrl && proof.apps.some(app => app.appId === removal?.appId && !app.registrationId));
  const descriptor = saved ? validateDescriptor(saved.value, aws.target) : retained?.descriptor;
  if (!descriptor)
    throw new AppError('purge_evidence_missing');
  let resources = await cli.inventory();
  const supplement = async (references: import('./purge-model.js').PurgeResource[]) => {
    for (const resource of references) {
      const live = await inspectResource(cli, resource, descriptor);
      if (live)
        resources = mergeResources(resources, [live]);
    }
  };
  await supplement(mergeResources(canonicalResources(descriptor), known, history.evidence.flatMap(proof => [...canonicalResources(proof.descriptor, proof.registrationIds), ...proof.resources])));
  const configuration = await secretResource(cli, `roughmate-${aws.target.environment}/configuration`);
  if (configuration)
    resources = mergeResources(resources, [configuration]);
  const rootPresent = resources.some(resource => resource.kind === 'table' && resource.id === descriptor.tableName);
  const getWorkspace = rootPresent ? (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'workspace' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item : undefined;
  if (!rootPresent || !getWorkspace) {
    if (!history.evidence.length)
      throw new AppError('purge_evidence_missing');
    const proof = [...history.evidence].sort((a, b) => b.rootHistory.generationCount - a.rootHistory.generationCount)[0];
    const protectedHistory=await protectedRootHistory(aws);
    if (JSON.stringify(protectedHistory.appIds)!==JSON.stringify(proof.rootHistory.appIds)||protectedHistory.genesisId!==proof.rootHistory.genesisId||protectedHistory.tableId!==proof.rootHistory.tableId) throw new AppError('purge_root_history');
    if (rootPresent) await requireRootTableHistory(aws,protectedHistory);
    const apps: PurgeApp[] = [];
    for (const item of history.evidence) {
      if (item.rootHistory.genesisId !== proof.rootHistory.genesisId || item.rootHistory.tableId !== proof.rootHistory.tableId || item.rootHistory.appIds.some((id, index) => proof.rootHistory.appIds[index] !== id))
        throw new AppError('purge_root_history');
      if (item.ownerId !== proof.ownerId || item.teamId !== proof.teamId)
        throw new AppError('purge_ownership');
      for (const app of item.apps) {
        const current = { ...app, publicUrl: item.descriptor.publicUrl };
        const old = apps.find(value => value.appId === app.appId);
        if (old && JSON.stringify(old) !== JSON.stringify(current))
          throw new AppError('purge_ownership');
        if (!old)
          apps.push(current);
      }
      for (const id of item.registrationIds) {
        const secret = await secretResource(cli, childResources(item.descriptor.tableName, item.descriptor.secretArn, id).secretName, id);
        if (secret)
          resources = mergeResources(resources, [secret]);
      }
    }
    if (rootPresent) {
      const setup = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
      if (setup?.phase === 'creating')
        throw new AppError('slack_creation_ambiguous');
      const current = await aws.readSecrets(descriptor);
      if ([setup?.appId, setup?.retiredAppId, current?.appId].some(appId => appId && !apps.some(app => !app.registrationId && app.appId === appId)))
        throw new AppError('purge_creation_unknown');
    }
    for (const resource of resources.filter(resource => resource.kind === 'secret' && resource.registrationId)) {
      const raw = await cli.optional('secretsmanager', 'get-secret-value', { SecretId: resource.arn }, ['ResourceNotFoundException', 'InvalidRequestException']);
      if (raw) {
        const value = object(JSON.parse(string(raw.SecretString)));
        if (value.appId && value.appId !== apps.find(app => app.registrationId === resource.registrationId)?.appId)
          throw new AppError('purge_creation_unknown');
      }
    }
    const removal = await aws.removal();
    if (!saved && (!removal || removal.publicUrl !== descriptor.publicUrl || !removal.appId || !apps.some(app => !app.registrationId && app.appId === removal.appId && app.publicUrl === removal.publicUrl)))
      throw new AppError('purge_evidence_missing');
    if (resources.some(resource => resource.registrationId && !history.evidence.some(item => item.registrationIds.includes(resource.registrationId!))))
      throw new AppError('purge_orphan_unknown');
    return validatePlan({ schemaVersion: 1, application: 'roughmate-environment-purge', target: aws.target, id: randomUUID(), descriptor, rootHistory: proof.rootHistory, ownerId: proof.ownerId, teamId: proof.teamId, apps, resources, stage: 'planned', drainUntil: 0, leaseOwner: randomUUID(), leaseUntil: 0 }, aws.target);
  }
  const root = new Registrations(descriptor.tableName, descriptor.secretArn, undefined, aws.target.region);
  const registry = await root.read();
  const get = async (pk: string) => (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
  const workspace = getWorkspace, setup = await get('setup#slack');
  if (!workspace || !/^T[A-Z0-9]+$/.test(string(workspace.teamId)) || !/^[UW][A-Z0-9]+$/.test(string(workspace.ownerId)))
    throw new AppError('purge_owner_missing');
  if (setup?.phase === 'creating')
    throw new AppError('slack_creation_ambiguous');
  const secrets = await aws.readSecrets(descriptor);
  if (setup?.appId && secrets && setup.appId !== secrets.appId || !secrets && setup?.phase !== 'deleted')
    throw new AppError('purge_evidence_missing');
  const appId = string(setup?.appId ?? secrets?.appId);
  if (!/^A[A-Z0-9]+$/.test(appId))
    throw new AppError('purge_evidence_missing');
  const rootHistory = await provenRootHistory(aws, descriptor, setup, appId, string(workspace.ownerId), string(workspace.teamId));
  for (const item of history.evidence)
    if (item.ownerId !== workspace.ownerId || item.teamId !== workspace.teamId || item.rootHistory.genesisId !== rootHistory.genesisId || item.rootHistory.tableId !== rootHistory.tableId || item.rootHistory.appIds.some((id, index) => rootHistory.appIds[index] !== id))
      throw new AppError('purge_root_history');
  const apps: PurgeApp[] = rootHistory.appIds.map(appId => ({ appId }));
  if (setup?.retiredAppId && !apps.some(app=>app.appId===setup.retiredAppId))
    apps.push({ appId: string(setup.retiredAppId) });
  const entries = new Map(registry.entries.map(entry => [entry.id, entry]));
  const archived = new Set<string>();
  for (const entry of await immutableArchives(aws, descriptor, string(workspace.ownerId))) {
    if (entries.has(entry.id))
      throw new AppError('purge_ownership');
    entries.set(entry.id, entry);
    archived.add(entry.id);
  }
  await supplement(canonicalResources(descriptor, [...entries.keys()]));
  for (const entry of entries.values()) {
    const expected = childResources(descriptor.tableName, descriptor.secretArn, entry.id);
    if (entry.secretArn)
      await supplement([{ kind: 'secret', id: expected.secretName, arn: entry.secretArn, registrationId: entry.id }]);
    const secret = await secretResource(cli, expected.secretName, entry.id);
    if (secret)
      resources = mergeResources(resources, [secret]);
  }
  for (const entry of entries.values()) {
    const expected = childResources(descriptor.tableName, descriptor.secretArn, entry.id);
    if (entry.actor !== workspace.ownerId || entry.teamId !== workspace.teamId || !/^A[A-Z0-9]+$/.test(entry.parentAppId) || !archived.has(entry.id) && entry.parentAppId !== appId || entry.secretArn && (!entry.secretArn.startsWith(expected.secretPrefix) || !/^[A-Za-z0-9]{6}$/.test(entry.secretArn.slice(expected.secretPrefix.length))))
      throw new AppError('purge_ownership');
    // Immutable archive ownership + environment namespace proves prior Roots; live entries stay bound to the current Root.
    if (archived.has(entry.id) && !rootHistory.appIds.includes(entry.parentAppId))
      throw new AppError('purge_root_history');
    let childAppId = entry.appId;
    if (!childAppId && entry.createOwner) {
      if (!entry.secretArn)
        throw new AppError('purge_creation_unknown');
      try {
        const created = object(JSON.parse(string((await aws.secrets.send(new GetSecretValueCommand({ SecretId: entry.secretArn, VersionId: entry.createOwner }), { abortSignal: environmentSignal() })).SecretString)));
        if (created.appId)
          childAppId = validateSecrets(created).appId;
        else
          confirmedCreateFailure(created, entry);
      }
      catch (error) {
        if (error instanceof AppError || error instanceof Error && ['ResourceNotFoundException', 'InvalidRequestException', 'SyntaxError'].includes(error.name))
          throw new AppError('purge_creation_unknown');
        throw new AppError('purge_creation_unknown');
      }
    }
    else if (!childAppId && !['queued', 'resources', 'failed'].includes(entry.phase))
      throw new AppError('purge_creation_unknown');
    if (childAppId) {
      if (childAppId === appId)
        throw new AppError('purge_ownership');
      apps.push({ appId: childAppId, registrationId: entry.id, botName: entry.botName });
    }
  }
  // An orphan cannot be assumed to be pre-create: recover its registry/archive evidence first.
  for (const resource of resources) {
    if (resource.registrationId && !entries.has(resource.registrationId))
      continue;
    if (resource.kind === 'secret' && resource.registrationId) {
      const entry = entries.get(resource.registrationId)!;
      if (entry.secretArn && entry.secretArn !== resource.arn)
        throw new AppError('purge_ownership');
      const rawSecret = await cli.optional('secretsmanager', 'get-secret-value', { SecretId: resource.arn }, ['ResourceNotFoundException', 'InvalidRequestException']);
      if (!rawSecret) {
        if (entry.appId && !entry.deletion)
          throw new AppError('purge_creation_unknown');
        continue;
      }
      const value = object(JSON.parse(string(rawSecret.SecretString)));
      const app = apps.find(item => item.registrationId === entry.id);
      if (value.appId && value.appId !== app?.appId)
        throw new AppError('purge_creation_unknown');
    }
    if (resource.kind === 'table' && resource.registrationId) {
      const raw = (await aws.db.send(new GetCommand({ TableName: resource.id, Key: { pk: 'roughmate' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
      if (raw) {
        const group = validateGroup(raw), entry = entries.get(resource.registrationId)!;
        if (group.environmentId !== entry.secretArn || group.appId !== entry.appId || group.teamId !== workspace.teamId)
          throw new AppError('purge_ownership');
      }
    }
  }
  for (const id of new Set(resources.flatMap(resource => resource.registrationId && !entries.has(resource.registrationId) ? [resource.registrationId] : []))) {
    const table = resources.find(resource => resource.kind === 'table' && resource.registrationId === id);
    const secret = resources.find(resource => resource.kind === 'secret' && resource.registrationId === id);
    const groupRaw = table ? (await aws.db.send(new GetCommand({ TableName: table.id, Key: { pk: 'roughmate' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item : undefined;
    const group = groupRaw ? validateGroup(groupRaw) : undefined;
    const rawSecret = secret ? await cli.optional('secretsmanager', 'get-secret-value', { SecretId: secret.arn }, ['ResourceNotFoundException', 'InvalidRequestException']) : undefined;
    const value = rawSecret ? object(JSON.parse(string(rawSecret.SecretString))) : undefined;
    const childAppId = value?.appId ? validateSecrets(value).appId : group?.appId;
    if (!group || !childAppId || (group.teamId !== workspace.teamId || !group.adminIds.includes(string(workspace.ownerId)) || group.appId !== childAppId || secret && group.environmentId !== secret.arn))
      throw new AppError('purge_orphan_unknown');
    const expected = childResources(descriptor.tableName, descriptor.secretArn, id);
    if (group && (!group.environmentId.startsWith(expected.secretPrefix) || !/^[A-Za-z0-9]{6}$/.test(group.environmentId.slice(expected.secretPrefix.length))))
      throw new AppError('purge_ownership');
    apps.push({ appId: childAppId, registrationId: id });
  }
  for (const proof of history.evidence) {
    if (proof.ownerId !== workspace.ownerId || proof.teamId !== workspace.teamId)
      throw new AppError('purge_ownership');
    for (const app of proof.apps) {
      const old = apps.find(value => value.appId === app.appId);
      if (old) {
        if (old.registrationId !== app.registrationId || old.botName !== app.botName)
          throw new AppError('purge_ownership');
      }
      else
        apps.push({ ...app, publicUrl: proof.descriptor.publicUrl });
    }
  }
  return validatePlan({ schemaVersion: 1, application: 'roughmate-environment-purge', target: aws.target, id: randomUUID(), descriptor, rootHistory, ownerId: string(workspace.ownerId), teamId: string(workspace.teamId), apps, resources, stage: 'planned', drainUntil: 0, leaseOwner: randomUUID(), leaseUntil: 0 }, aws.target);
}
