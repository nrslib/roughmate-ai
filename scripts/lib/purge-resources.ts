import { AppError, object, string } from '../../app/src/contracts.js';
import type { Descriptor } from './config.js';
import type { PurgeAwsCli } from './purge-inventory.js';
import { functionKinds, roleKinds, policyKinds, requireRootTags, tagMap, validateResource, type PurgeResource } from './purge-model.js';
import { requireServiceTrust, policyDocument } from './purge-authorization.js';
export function canonicalResources(d: Descriptor, ids: string[] = []): PurgeResource[] {
  const t = d, base = `roughmate-${t.environment}`, arn = (service: string, suffix: string) => `arn:aws:${service}:${t.region}:${t.accountId}:${suffix}`;
  return [
    { kind: 'table', id: base, arn: arn('dynamodb', `table/${base}`) }, { kind: 'secret', id: `${base}/runtime`, arn: d.secretArn },
    { kind: 'api', id: new URL(d.publicUrl).hostname.split('.')[0], arn: `arn:aws:apigateway:${t.region}::/apis/${new URL(d.publicUrl).hostname.split('.')[0]}`, publicUrl: d.publicUrl },
    ...functionKinds.map(kind => ({ kind: 'function' as const, id: `${base}-${kind}`, arn: arn('lambda', `function:${base}-${kind}`) })),
    ...functionKinds.map(kind => ({ kind: 'log' as const, id: `/aws/lambda/${base}-${kind}`, arn: arn('logs', `log-group:/aws/lambda/${base}-${kind}`) })),
    ...roleKinds.map(kind => ({ kind: 'role' as const, id: `${base}-${t.region}-${kind}`, arn: `arn:aws:iam::${t.accountId}:role/${base}-${t.region}-${kind}` })),
    ...policyKinds.map(kind => ({ kind: 'policy' as const, id: `${base}-${t.region}-${kind}-boundary`, arn: `arn:aws:iam::${t.accountId}:policy/${base}-${t.region}-${kind}-boundary` })),
    ...['jobs', 'dead', 'provision', 'provision-dead', 'wiki', 'wiki-dead'].map(kind => ({ kind: 'queue' as const, id: `https://sqs.${t.region}.amazonaws.com/${t.accountId}/${base}-${kind}`, arn: arn('sqs', `${base}-${kind}`) })),
    { kind: 'schedule-group', id: `${base}-configuration`, arn: arn('scheduler', `schedule-group/${base}-configuration`) },
    ...ids.map(id => ({ kind: 'table' as const, id: `${base}-bot-${id}`, arn: arn('dynamodb', `table/${base}-bot-${id}`), registrationId: id }))
  ];
}
export async function secretResource(cli: PurgeAwsCli, name: string, id?: string): Promise<PurgeResource | undefined> {
  const current = await cli.optional('secretsmanager', 'describe-secret', { SecretId: name }, ['ResourceNotFoundException']);
  if (!current)
    return;
  const resource: PurgeResource = { kind: 'secret', id: name, arn: string(current.ARN), ...(id ? { registrationId: id } : {}) };
  validateResource(resource, cli.target);
  await inspectResource(cli, resource);
  return resource;
}
export function mergeResources(...groups: PurgeResource[][]): PurgeResource[] {
  const found = new Map<string, PurgeResource>();
  for (const r of groups.flat()) {
    const key = `${r.kind}:${r.arn}`, old = found.get(key);
    if (old && (old.id !== r.id || old.registrationId !== r.registrationId || old.publicUrl && r.publicUrl && old.publicUrl !== r.publicUrl))
      throw new AppError('purge_ownership');
    found.set(key, { ...old, ...r });
  }
  return [...found.values()];
}
export async function inspectResource(cli: PurgeAwsCli, r: PurgeResource, d?: Descriptor): Promise<PurgeResource | undefined> {
  validateResource(r, cli.target);
  const base = `roughmate-${cli.target.environment}`, regional = (service: string, suffix: string) => `arn:aws:${service}:${cli.target.region}:${cli.target.accountId}:${suffix}`;
  const tags = (value: Record<string, string>) => { if (r.registrationId) {
    if (value.RoughmateParent !== base || value.RegistrationId !== r.registrationId)
      throw new AppError('purge_ownership');
  }
  else
    requireRootTags(value, cli.target); };
  switch (r.kind) {
    case 'table': {
      const raw = await cli.optional('dynamodb', 'describe-table', { TableName: r.id }, ['ResourceNotFoundException']);
      if (!raw)
        return;
      const t = object(raw.Table);
      if (t.TableArn !== r.arn || t.TableName !== r.id)
        throw new AppError('purge_ownership');
      if (t.DeletionProtectionEnabled === true || Array.isArray(t.Replicas) && t.Replicas.length)
        throw new AppError('purge_retained_resource');
      tags(tagMap((await cli.call('dynamodb', 'list-tags-of-resource', { ResourceArn: r.arn })).Tags));
      const p = object((await cli.call('dynamodb', 'describe-continuous-backups', { TableName: r.id })).ContinuousBackupsDescription);
      if (object(p.PointInTimeRecoveryDescription).PointInTimeRecoveryStatus !== 'DISABLED')
        throw new AppError('purge_retained_backup');
      break;
    }
    case 'secret': {
      const s = await cli.optional('secretsmanager', 'describe-secret', { SecretId: r.arn }, ['ResourceNotFoundException']);
      if (!s)
        return;
      if (s.ARN !== r.arn || s.Name !== r.id)
        throw new AppError('purge_ownership');
      if (Array.isArray(s.ReplicationStatus) && s.ReplicationStatus.length)
        throw new AppError('purge_retained_resource');
      tags(tagMap(s.Tags));
      break;
    }
    case 'function': {
      const raw = await cli.optional('lambda', 'get-function', { FunctionName: r.arn }, ['ResourceNotFoundException']);
      if (!raw)
        return;
      const f = object(raw.Configuration);
      if (f.FunctionArn !== r.arn || f.FunctionName !== r.id || f.Role !== `arn:aws:iam::${cli.target.accountId}:role/${base}-${cli.target.region}-${r.id.slice(base.length + 1)}`)
        throw new AppError('purge_ownership');
      tags(object(raw.Tags) as Record<string, string>);
      break;
    }
    case 'api': {
      const a = await cli.optional('apigatewayv2', 'get-api', { ApiId: r.id }, ['NotFoundException']);
      if (!a)
        return;
      const url = r.publicUrl ?? d?.publicUrl;
      if (!url || new URL(url).hostname.split('.')[0] !== r.id || a.ApiId !== r.id || a.Name !== base || a.ProtocolType !== 'HTTP' || a.ApiEndpoint !== url)
        throw new AppError('purge_ownership');
      tags(object(a.Tags) as Record<string, string>);
      break;
    }
    case 'queue': {
      const raw = await cli.optional('sqs', 'get-queue-attributes', { QueueUrl: r.id, AttributeNames: ['QueueArn'] }, ['AWS.SimpleQueueService.NonExistentQueue', 'QueueDoesNotExist']);
      if (!raw)
        return;
      if (object(raw.Attributes).QueueArn !== r.arn)
        throw new AppError('purge_ownership');
      tags(object((await cli.call('sqs', 'list-queue-tags', { QueueUrl: r.id })).Tags) as Record<string, string>);
      break;
    }
    case 'log': {
      const raw = await cli.optional('logs', 'list-tags-for-resource', { resourceArn: r.arn }, ['ResourceNotFoundException']);
      if (!raw)
        return;
      tags(object(raw.tags) as Record<string, string>);
      break;
    }
    case 'role': {
      const raw = await cli.optional('iam', 'get-role', { RoleName: r.id }, ['NoSuchEntity']);
      if (!raw)
        return;
      const role = object(raw.Role);
      if (role.Arn !== r.arn || role.RoleName !== r.id)
        throw new AppError('purge_ownership');
      tags(tagMap(role.Tags));
      requireServiceTrust(role.AssumeRolePolicyDocument, r.id, cli);
      await cli.requireExclusiveRole(r.arn);
      if ((await cli.items('iam', 'list-attached-role-policies', { RoleName: r.id }, 'AttachedPolicies')).length || (await cli.items('iam', 'list-instance-profiles-for-role', { RoleName: r.id }, 'InstanceProfiles')).length)
        throw new AppError('purge_shared_policy');
      break;
    }
    case 'policy': {
      const raw = await cli.optional('iam', 'get-policy', { PolicyArn: r.arn }, ['NoSuchEntity']);
      if (!raw)
        return;
      const p = object(raw.Policy);
      if (p.Arn !== r.arn || p.PolicyName !== r.id)
        throw new AppError('purge_ownership');
      const doc = policyDocument(object((await cli.call('iam', 'get-policy-version', { PolicyArn: r.arn, VersionId: p.DefaultVersionId })).PolicyVersion).Document), pattern = '?'.repeat(32), owned = new Set([regional('dynamodb', `table/${base}`), regional('dynamodb', `table/${base}-bot-${pattern}`), regional('secretsmanager', `secret:${base}/runtime-??????`), regional('secretsmanager', `secret:${base}/configuration-??????`), regional('secretsmanager', `secret:${base}/bots/*/runtime-??????`), ...['jobs', 'dead', 'provision', 'provision-dead', 'wiki', 'wiki-dead'].map(k => regional('sqs', `${base}-${k}`)), ...functionKinds.map(k => regional('logs', `log-group:/aws/lambda/${base}-${k}:*`))]);
      if (!Array.isArray(doc.Statement) || !doc.Statement.length)
        throw new AppError('purge_ownership');
      for (const item of doc.Statement) {
        const s = object(item), refs = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        if (!refs.length || refs.some(ref => typeof ref !== 'string' || !owned.has(ref)))
          throw new AppError('purge_ownership');
      }
      await cli.requireExclusivePolicy(r.arn, roleKinds.map(k => `${base}-${cli.target.region}-${k}`));
      break;
    }
    case 'schedule-group': {
      const group = await cli.optional('scheduler', 'get-schedule-group', { Name: r.id }, ['ResourceNotFoundException']);
      if (!group)
        return;
      if (group.Arn !== r.arn)
        throw new AppError('purge_ownership');
      tags(tagMap((await cli.call('scheduler', 'list-tags-for-resource', { ResourceArn: r.arn })).Tags));
      for (const s of await cli.items('scheduler', 'list-schedules', { GroupName: r.id }, 'Schedules')) {
        if (s.Name !== `${base}-configuration-refresh`)
          throw new AppError('purge_ownership');
        const live = await cli.call('scheduler', 'get-schedule', { GroupName: r.id, Name: s.Name }), target = object(live.Target);
        if (target.Arn !== regional('sqs', `${base}-provision`) || target.RoleArn !== `arn:aws:iam::${cli.target.accountId}:role/${base}-${cli.target.region}-scheduler`)
          throw new AppError('purge_ownership');
      }
      break;
    }
    case 'mapping': {
      const m = await cli.optional('lambda', 'get-event-source-mapping', { UUID: r.id }, ['ResourceNotFoundException']);
      if (!m)
        return;
      if (m.UUID !== r.id || !['worker', 'provisioner', 'wiki-runner'].some((k, i) => m.FunctionArn === regional('lambda', `function:${base}-${k}`) && m.EventSourceArn === regional('sqs', `${base}-${['jobs', 'provision', 'wiki'][i]}`)))
        throw new AppError('purge_ownership');
      break;
    }
    case 'backup': {
      const raw = await cli.optional('dynamodb', 'describe-backup', { BackupArn: r.arn }, ['BackupNotFoundException']);
      if (!raw)
        return;
      const b = object(raw.BackupDescription), detail = object(b.BackupDetails), source = object(b.SourceTableDetails);
      if (detail.BackupArn !== r.arn || source.TableName !== r.id || source.TableArn !== regional('dynamodb', `table/${r.id}`))
        throw new AppError('purge_ownership');
      if (detail.BackupType !== 'USER')
        throw new AppError('purge_retained_backup');
      break;
    }
  }
  return r;
}
export { stateResources } from './purge-state.js';
