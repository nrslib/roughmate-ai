import { requireRootTableHistory } from './root-history.js';
import { SetupAws } from './aws.js';
import { environmentSignal } from './environment-lease.js';
import { environmentFence } from './environment-lease.js';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AppError, object, string, workerDrainSeconds } from '../../app/src/contracts.js';
import { registrationKey, type Registry } from '../../app/src/registration.js';
import type { PurgeAwsCli } from './purge-inventory.js';
import type { PurgePlan, PurgeResource } from './purge-model.js';
import type { PurgeJournal } from './purge-journal.js';
import { inspectResource, mergeResources } from './purge-resources.js';
import type { Descriptor } from './config.js';
export function requireFrozenInventory(plan: PurgePlan, current: PurgeResource[]): void {
  for (const resource of current)
    if (!plan.resources.some(saved => saved.kind === resource.kind && saved.arn === resource.arn && saved.id === resource.id && saved.registrationId === resource.registrationId))
      throw new AppError('purge_inventory_changed');
}
export async function remainingPurgeResources(cli: PurgeAwsCli, plan: PurgePlan): Promise<PurgeResource[]> {
  const checked: PurgeResource[] = [];
  for (const resource of mergeResources(await cli.inventory(), plan.resources)) {
    const live = await inspectResource(cli, resource, plan.descriptor);
    if (live) {
      if (live.kind==='table'&&live.id===plan.descriptor.tableName) await requireRootTableHistory(new SetupAws(cli.target),plan.rootHistory,false,cli);
      checked.push(live);
    }
  }
  return checked;
}
export async function stopPurge(aws: SetupAws, cli: PurgeAwsCli, journal: PurgeJournal, plan: PurgePlan): Promise<PurgePlan> {
  const current = await remainingPurgeResources(cli, plan);
  requireFrozenInventory(plan, current);
  // Stop external entry points before taking the registry snapshot; drain covers already-running Lambdas.
  for (const resource of current.filter(item => item.kind === 'function')) {
    plan = await journal.save(plan);
    if (!await inspectResource(cli, resource, plan.descriptor))
      continue;
    await environmentFence();
    await cli.call('lambda', 'put-function-concurrency', { FunctionName: resource.arn, ReservedConcurrentExecutions: 0 });
  }
  if (current.some(resource => resource.kind === 'table' && resource.id === plan.descriptor.tableName)) {
    const registry = (await aws.db.send(new GetCommand({ TableName: plan.descriptor.tableName, Key: { pk: registrationKey }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item as Registry | undefined;
    if (registry && (registry.parentSecret !== plan.descriptor.secretArn || !Number.isSafeInteger(registry.version) || !Array.isArray(registry.entries)))
      throw new AppError('purge_ownership');
    const next = registry ? { ...registry, version: registry.version + 1, deleting: true, removingAppId: plan.apps.find(app => !app.registrationId)?.appId } : { pk: registrationKey, version: 1, parentSecret: plan.descriptor.secretArn, entries: [], deleting: true, removingAppId: plan.apps.find(app => !app.registrationId)?.appId };
    plan = await journal.save(plan);
    if (!await inspectResource(cli, plan.resources.find(resource => resource.kind === 'table' && resource.id === plan.descriptor.tableName)!, plan.descriptor))
      throw new AppError('purge_inventory_changed');
    await environmentFence();
    await aws.db.send(new PutCommand({ TableName: plan.descriptor.tableName, Item: next, ConditionExpression: registry ? '#v = :v AND parentSecret = :parent' : 'attribute_not_exists(pk)', ...(registry ? { ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': registry.version, ':parent': plan.descriptor.secretArn } } : {}) }), { abortSignal: environmentSignal() });
  }
  return journal.save({ ...plan, stage: 'stopped', drainUntil: Date.now() + workerDrainSeconds * 1000 });
}
export async function drainPurge(journal: PurgeJournal, plan: PurgePlan): Promise<PurgePlan> {
  while (plan.drainUntil > Date.now()) {
    plan = await journal.save(plan);
    process.stdout.write('稼働中の処理が終了するまで待機しています。\n');
    await new Promise(resolve => setTimeout(resolve, Math.min(30000, plan.drainUntil - Date.now())));
  }
  return plan;
}
export async function deletePurgeResource(cli: PurgeAwsCli, resource: PurgeResource, lease: {
  touch(): Promise<void>;
}, descriptor?: Descriptor): Promise<void> {
  const mutate = async (service: string, operation: string, input: Record<string, unknown>, absent: string[] = [], subject = resource) => {
    await lease.touch();
    if (!await inspectResource(cli, subject, descriptor)) return undefined;
    await lease.touch();
    await environmentFence();
    return cli.optional(service, operation, input, absent);
  };
  switch (resource.kind) {
    case 'mapping':
      await mutate('lambda', 'delete-event-source-mapping', { UUID: resource.id }, ['ResourceNotFoundException']);
      break;
    case 'backup':
      await mutate('dynamodb', 'delete-backup', { BackupArn: resource.arn }, ['BackupNotFoundException']);
      break;
    case 'table': {
      const current = await cli.optional('dynamodb', 'describe-table', { TableName: resource.id }, ['ResourceNotFoundException']);
      if (!current)
        return;
      const backup = object((await cli.call('dynamodb', 'describe-continuous-backups', { TableName: resource.id })).ContinuousBackupsDescription);
      if (object(backup.PointInTimeRecoveryDescription).PointInTimeRecoveryStatus !== 'DISABLED')
        throw new AppError('purge_retained_backup');
      await mutate('dynamodb', 'delete-table', { TableName: resource.id });
      break;
    }
    case 'secret': {
      const current = await cli.optional('secretsmanager', 'describe-secret', { SecretId: resource.arn }, ['ResourceNotFoundException']);
      if (!current || current.DeletedDate !== undefined)
        return;
      await mutate('secretsmanager', 'delete-secret', { SecretId: resource.arn, ForceDeleteWithoutRecovery: true }, ['ResourceNotFoundException']);
      break;
    }
    case 'function': {
      const current = await cli.optional('lambda', 'get-function', { FunctionName: resource.arn }, ['ResourceNotFoundException']);
      if (!current)
        return;
      for (const mapping of await cli.items('lambda', 'list-event-source-mappings', { FunctionName: resource.arn }, 'EventSourceMappings')) {
        if (mapping.FunctionArn !== resource.arn || !['jobs', 'provision', 'wiki'].some(kind => mapping.EventSourceArn === `arn:aws:sqs:${cli.target.region}:${cli.target.accountId}:roughmate-${cli.target.environment}-${kind}`))
          throw new AppError('purge_ownership');
        await mutate('lambda', 'delete-event-source-mapping', { UUID: string(mapping.UUID) }, ['ResourceNotFoundException'], {kind:'mapping',id:string(mapping.UUID),arn:`arn:aws:lambda:${cli.target.region}:${cli.target.accountId}:event-source-mapping:${string(mapping.UUID)}`});
      }
      await mutate('lambda', 'delete-function', { FunctionName: resource.arn });
      break;
    }
    case 'api': {
      const current = await cli.optional('apigatewayv2', 'get-api', { ApiId: resource.id }, ['NotFoundException']);
      if (!current)
        return;
      await mutate('apigatewayv2', 'delete-api', { ApiId: resource.id }, ['NotFoundException']);
      break;
    }
    case 'queue':
      await mutate('sqs', 'delete-queue', { QueueUrl: resource.id }, ['AWS.SimpleQueueService.NonExistentQueue', 'QueueDoesNotExist']);
      break;
    case 'log':
      await mutate('logs', 'delete-log-group', { logGroupName: resource.id }, ['ResourceNotFoundException']);
      break;
    case 'schedule-group': {
      const group = await cli.optional('scheduler', 'get-schedule-group', { Name: resource.id }, ['ResourceNotFoundException']);
      if (!group)
        return;
      for (const schedule of await cli.items('scheduler', 'list-schedules', { GroupName: resource.id }, 'Schedules')) {
        if (schedule.Name !== `roughmate-${cli.target.environment}-configuration-refresh`)
          throw new AppError('purge_ownership');
        await mutate('scheduler', 'delete-schedule', { Name: string(schedule.Name), GroupName: resource.id }, ['ResourceNotFoundException']);
      }
      await mutate('scheduler', 'delete-schedule-group', { Name: resource.id });
      break;
    }
    case 'role': {
      const role = await cli.optional('iam', 'get-role', { RoleName: resource.id }, ['NoSuchEntity']);
      if (!role)
        return;
      if ((await cli.items('iam', 'list-attached-role-policies', { RoleName: resource.id }, 'AttachedPolicies')).length || (await cli.items('iam', 'list-instance-profiles-for-role', { RoleName: resource.id }, 'InstanceProfiles')).length)
        throw new AppError('purge_shared_policy');
      const policies = await cli.call('iam', 'list-role-policies', { RoleName: resource.id });
      if (!Array.isArray(policies.PolicyNames) || policies.IsTruncated === true)
        throw new AppError('purge_inventory');
      for (const policy of policies.PolicyNames)
        await mutate('iam', 'delete-role-policy', { RoleName: resource.id, PolicyName: string(policy) });
      await mutate('iam', 'delete-role', { RoleName: resource.id });
      break;
    }
    case 'policy': {
      if (!await cli.optional('iam', 'get-policy', { PolicyArn: resource.arn }, ['NoSuchEntity']))
        return;
      await cli.requireExclusivePolicy(resource.arn, []);
      for (const version of await cli.items('iam', 'list-policy-versions', { PolicyArn: resource.arn }, 'Versions'))
        if (version.IsDefaultVersion === false)
          await mutate('iam', 'delete-policy-version', { PolicyArn: resource.arn, VersionId: string(version.VersionId) });
      await mutate('iam', 'delete-policy', { PolicyArn: resource.arn });
      break;
    }
  }
}
