import { environmentFence, environmentSignal } from './environment-lease.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, object, string } from '../../app/src/contracts.js';
import { location, type Target } from './config.js';
import { functionKinds, roleKinds, policyKinds, requireRootTags, tagMap, validateResource, type PurgeResource } from './purge-model.js';
import { authorizePurge, requireServiceTrust, requireProtectedPolicyBoundary } from './purge-authorization.js';
const execute = promisify(execFile);
export class PurgeAwsCli {
  constructor(readonly target: Target, private executeCommand = execute) { }
  async authorizeAdmin(identity: Record<string, unknown>): Promise<void> { await authorizePurge(this, identity); await requireProtectedPolicyBoundary(this); }
  async call(service: string, operation: string, input: Record<string, unknown>, region = this.target.region): Promise<Record<string, unknown>> {
    await environmentFence();
    const signal = environmentSignal();
    signal?.throwIfAborted();
    try {
      const result = await this.executeCommand('aws', [service, operation, '--cli-input-json', JSON.stringify(input), '--region', region, '--output', 'json', '--no-cli-pager', '--no-cli-auto-prompt', '--cli-connect-timeout', '10', '--cli-read-timeout', '60'], { signal, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' } });
      return result.stdout.trim() ? object(JSON.parse(result.stdout)) : {};
    }
    catch (error) {
      signal?.throwIfAborted();
      const stderr = (error as {
        stderr?: unknown;
      }).stderr;
      const code = typeof stderr === 'string' ? /An error occurred \(([A-Za-z0-9.]+)\)/.exec(stderr)?.[1] : undefined;
      // Subprocess errors contain CLI inputs and secret responses, so never propagate them.
      throw new AppError(code ? `purge_aws_${code}` : 'purge_aws_cli');
    }
  }
  async optional(service: string, operation: string, input: Record<string, unknown>, absent: string[]): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.call(service, operation, input);
    }
    catch (error) {
      if (error instanceof AppError && absent.some(code => error.code === `purge_aws_${code}`))
        return undefined;
      throw error;
    }
  }
  async items(service: string, operation: string, input: Record<string, unknown>, key: string, region = this.target.region): Promise<Record<string, unknown>[]> {
    const result = await this.call(service, operation, input, region), value = result[key];
    if (result.NextToken || result.NextMarker || result.LastEvaluatedBackupArn || result.IsTruncated === true || result.LastEvaluatedTableName || !Array.isArray(value))
      throw new AppError('purge_inventory');
    return value.map(object);
  }
  async inventory(): Promise<PurgeResource[]> {
    const base = `roughmate-${this.target.environment}`, resources: PurgeResource[] = [];
    const regional = (service: string, suffix: string) => `arn:aws:${service}:${this.target.region}:${this.target.accountId}:${suffix}`;
    const add = (kind: PurgeResource['kind'], id: string, arn: string, registrationId?: string) => { const resource = { kind, id, arn, ...(registrationId ? { registrationId } : {}) }; validateResource(resource, this.target); resources.push(resource); };
    const candidate = (canonical: boolean, prefixed: boolean, tags: Record<string, string>): boolean => {
      if (canonical)
        return true;
      const owned = tags.RoughmateParent === base || tags.Application === 'roughmate-self-hosted' && tags.Environment === this.target.environment;
      const foreign = tags.RoughmateParent !== undefined && tags.RoughmateParent !== base || tags.Environment !== undefined && tags.Environment !== this.target.environment;
      if (owned || prefixed && !foreign)
        throw new AppError('purge_inventory_changed');
      return false;
    };
    const parentTags = (tags: Record<string, string>, id?: string) => {
      if (id) {
        if (tags.RoughmateParent !== base || tags.RegistrationId !== id)
          throw new AppError('purge_ownership');
      }
      else
        requireRootTags(tags, this.target);
    };
    const tables = await this.call('dynamodb', 'list-tables', {});
    if (!Array.isArray(tables.TableNames) || tables.LastEvaluatedTableName)
      throw new AppError('purge_inventory');
    for (const rawName of tables.TableNames) {
      const name = string(rawName);
      const child = name === base ? undefined : name.slice(`${base}-bot-`.length);
      const table = object((await this.call('dynamodb', 'describe-table', { TableName: name })).Table);
      const arn = string(table.TableArn), tags = tagMap((await this.call('dynamodb', 'list-tags-of-resource', { ResourceArn: arn })).Tags ?? []);
      if (!candidate(name === base || new RegExp(`^${base}-bot-[a-f0-9]{32}$`).test(name), name.startsWith(`${base}-`), tags))
        continue;
      if (table.Replicas !== undefined && (!Array.isArray(table.Replicas) || table.Replicas.length) || table.DeletionProtectionEnabled === true)
        throw new AppError('purge_retained_resource');
      const backups = object((await this.call('dynamodb', 'describe-continuous-backups', { TableName: name })).ContinuousBackupsDescription);
      if (object(backups.PointInTimeRecoveryDescription).PointInTimeRecoveryStatus !== 'DISABLED')
        throw new AppError('purge_retained_backup');
      parentTags(tags, child);
      add('table', name, arn, child);
    }
    for (const secret of await this.items('secretsmanager', 'list-secrets', { IncludePlannedDeletion: true }, 'SecretList')) {
      const name = string(secret.Name);
      const child = name.startsWith(`${base}/bots/`) ? /^.+\/bots\/([a-f0-9]{32})\/runtime$/.exec(name)?.[1] : undefined;
      const described = await this.call('secretsmanager', 'describe-secret', { SecretId: string(secret.ARN) });
      const tags = tagMap(described.Tags ?? []);
      if (!candidate(name === `${base}/runtime` || name === `${base}/configuration` || !!child, name.startsWith(`${base}/`), tags))
        continue;
      if (Array.isArray(described.ReplicationStatus) && described.ReplicationStatus.length)
        throw new AppError('purge_retained_resource');
      parentTags(tags, child);
      add('secret', name, string(described.ARN), child);
    }
    for (const lambda of await this.items('lambda', 'list-functions', {}, 'Functions')) {
      const name = string(lambda.FunctionName);
      const arn = string(lambda.FunctionArn), tags = object((await this.call('lambda', 'list-tags', { Resource: arn })).Tags ?? {}) as Record<string, string>;
      if (!candidate(functionKinds.some(kind => name === `${base}-${kind}`), name.startsWith(`${base}-`), tags))
        continue;
      parentTags(tags);
      add('function', name, arn);
    }
    for (const api of await this.items('apigatewayv2', 'get-apis', {}, 'Items')) {
      const tags = object(api.Tags ?? {}) as Record<string, string>;
      if (!candidate(api.Name === base, String(api.Name).startsWith(`${base}-`), tags))
        continue;
      parentTags(tags);
      if (api.ProtocolType !== 'HTTP')
        throw new AppError('purge_ownership');
      const id = string(api.ApiId);
      add('api', id, `arn:aws:apigateway:${this.target.region}::/apis/${id}`);
      resources.at(-1)!.publicUrl = string(api.ApiEndpoint);
    }
    const queues = await this.call('sqs', 'list-queues', { MaxResults: 1000 });
    // SQS pagination is opt-in; AWS CLI aggregates it when MaxResults is specified.
    if (queues.NextToken || queues.QueueUrls !== undefined && !Array.isArray(queues.QueueUrls))
      throw new AppError('purge_inventory');
    for (const url of (queues.QueueUrls ?? []) as string[]) {
      const tags = object((await this.call('sqs', 'list-queue-tags', { QueueUrl: url })).Tags ?? {}) as Record<string, string>;
      if (!candidate(['jobs', 'dead', 'provision', 'provision-dead', 'wiki', 'wiki-dead'].some(kind => url.endsWith(`/${base}-${kind}`)), url.split('/').at(-1)!.startsWith(`${base}-`), tags))
        continue;
      parentTags(tags);
      const attrs = object((await this.call('sqs', 'get-queue-attributes', { QueueUrl: url, AttributeNames: ['QueueArn'] })).Attributes);
      add('queue', url, string(attrs.QueueArn));
    }
    for (const log of await this.items('logs', 'describe-log-groups', {}, 'logGroups')) {
      const name = string(log.logGroupName);
      const arn = regional('logs', `log-group:${name}`), tags = object((await this.call('logs', 'list-tags-for-resource', { resourceArn: arn })).tags ?? {}) as Record<string, string>;
      if (!candidate(functionKinds.some(kind => name === `/aws/lambda/${base}-${kind}`), name.startsWith(`/aws/lambda/${base}-`), tags))
        continue;
      parentTags(tags);
      add('log', name, arn);
    }
    for (const role of await this.items('iam', 'list-roles', {}, 'Roles')) {
      const name = string(role.RoleName);
      const detail = object((await this.call('iam', 'get-role', { RoleName: name })).Role);
      const tags = tagMap(detail.Tags ?? []);
      if (!candidate(roleKinds.some(kind => name === `${base}-${this.target.region}-${kind}`), name.startsWith(`${base}-`), tags))
        continue;
      parentTags(tags);
      await this.requireExclusiveRole(string(detail.Arn));
      requireServiceTrust(detail.AssumeRolePolicyDocument, name, this);
      add('role', name, string(detail.Arn));
      if ((await this.items('iam', 'list-instance-profiles-for-role', { RoleName: name }, 'InstanceProfiles')).length)
        throw new AppError('purge_shared_policy');
      if ((await this.items('iam', 'list-attached-role-policies', { RoleName: name }, 'AttachedPolicies')).length)
        throw new AppError('purge_shared_policy');
    }
    for (const policy of await this.items('iam', 'list-policies', { Scope: 'Local' }, 'Policies')) {
      const name = string(policy.PolicyName);
      const arn = string(policy.Arn), tags = tagMap((await this.call('iam', 'list-policy-tags', { PolicyArn: arn })).Tags ?? []);
      if (!candidate(policyKinds.some(kind => name === `${base}-${this.target.region}-${kind}-boundary`), name.startsWith(`${base}-`), tags))
        continue;
      // Boundaries are generated outside Terraform without tags; exact names plus policy references prove ownership.
      const version = object((await this.call('iam', 'get-policy-version', { PolicyArn: arn, VersionId: string(policy.DefaultVersionId) })).PolicyVersion);
      const document = typeof version.Document === 'string' ? object(JSON.parse(decodeURIComponent(version.Document))) : object(version.Document);
      const childPattern = '?'.repeat(32);
      const ownedArns = new Set([
        regional('dynamodb', `table/${base}`), regional('dynamodb', `table/${base}-bot-${childPattern}`),
        regional('secretsmanager', `secret:${base}/runtime-??????`), regional('secretsmanager', `secret:${base}/configuration-??????`), regional('secretsmanager', `secret:${base}/bots/*/runtime-??????`),
        ...['jobs', 'dead', 'provision', 'provision-dead', 'wiki', 'wiki-dead'].map(kind => regional('sqs', `${base}-${kind}`)),
        ...functionKinds.map(kind => regional('logs', `log-group:/aws/lambda/${base}-${kind}:*`))
      ]);
      if (!Array.isArray(document.Statement) || !document.Statement.length)
        throw new AppError('purge_ownership');
      for (const rawStatement of document.Statement) {
        const statement = object(rawStatement), refs = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        if (!refs.length || refs.some(reference => typeof reference !== 'string' || !ownedArns.has(reference)))
          throw new AppError('purge_ownership');
      }
      await this.requireExclusivePolicy(arn, resources.filter(resource => resource.kind === 'role').map(resource => resource.id));
      add('policy', name, arn);
    }
    for (const mapping of await this.items('lambda', 'list-event-source-mappings', {}, 'EventSourceMappings')) {
      const functionOwned = functionKinds.some(kind => mapping.FunctionArn === regional('lambda', `function:${base}-${kind}`));
      const queueOwned = ['jobs', 'provision', 'wiki'].some(kind => mapping.EventSourceArn === regional('sqs', `${base}-${kind}`));
      if (!functionOwned && !queueOwned) {
        if (String(mapping.FunctionArn).startsWith(regional('lambda', `function:${base}-`)))
          candidate(false, true, object((await this.call('lambda', 'list-tags', { Resource: mapping.FunctionArn })).Tags ?? {}) as Record<string, string>);
        if (String(mapping.EventSourceArn).startsWith(regional('sqs', `${base}-`)))
          candidate(false, true, object((await this.call('sqs', 'list-queue-tags', { QueueUrl: `https://sqs.${this.target.region}.amazonaws.com/${this.target.accountId}/${String(mapping.EventSourceArn).split(':').at(-1)}` })).Tags ?? {}) as Record<string, string>);
        continue;
      }
      if (!['worker', 'provisioner', 'wiki-runner'].some((kind, index) => mapping.FunctionArn === regional('lambda', `function:${base}-${kind}`) && mapping.EventSourceArn === regional('sqs', `${base}-${['jobs', 'provision', 'wiki'][index]}`)))
        throw new AppError('purge_ownership');
      const id = string(mapping.UUID);
      add('mapping', id, regional('lambda', `event-source-mapping:${id}`));
    }
    const groupName = `${base}-configuration`;
    for (const group of await this.items('scheduler', 'list-schedule-groups', {}, 'ScheduleGroups')) {
      const tags = tagMap((await this.call('scheduler', 'list-tags-for-resource', { ResourceArn: string(group.Arn) })).Tags ?? []);
      candidate(group.Name === groupName, String(group.Name).startsWith(`${base}-`), tags);
    }
    const group = await this.optional('scheduler', 'get-schedule-group', { Name: groupName }, ['ResourceNotFoundException']);
    if (group) {
      const arn = string(group.Arn);
      parentTags(tagMap((await this.call('scheduler', 'list-tags-for-resource', { ResourceArn: arn })).Tags));
      for (const schedule of await this.items('scheduler', 'list-schedules', { GroupName: groupName }, 'Schedules')) {
        if (schedule.Name !== `${base}-configuration-refresh`)
          throw new AppError('purge_ownership');
        const detail = await this.call('scheduler', 'get-schedule', { GroupName: groupName, Name: string(schedule.Name) });
        const target = object(detail.Target);
        if (target.Arn !== regional('sqs', `${base}-provision`) || target.RoleArn !== `arn:aws:iam::${this.target.accountId}:role/${base}-${this.target.region}-scheduler`)
          throw new AppError('purge_ownership');
      }
      add('schedule-group', groupName, arn);
    }
    for (const backup of await this.items('dynamodb', 'list-backups', { BackupType: 'ALL' }, 'BackupSummaries')) {
      const name = string(backup.TableName);
      if (name !== base && !new RegExp(`^${base}-bot-[a-f0-9]{32}$`).test(name)) {
        if (name.startsWith(`${base}-`))
          throw new AppError('purge_inventory_changed');
        continue;
      }
      const child = name === base ? undefined : name.slice(`${base}-bot-`.length);
      // AWS Backup / SYSTEM retention cannot be irreversibly removed with DeleteBackup.
      if (backup.BackupType !== 'USER')
        throw new AppError('purge_retained_backup');
      add('backup', name, string(backup.BackupArn), child);
    }
    for (const vault of await this.items('backup', 'list-backup-vaults', {}, 'BackupVaultList')) {
      for (const type of ['DynamoDB', 'S3']) {
        const points = await this.items('backup', 'list-recovery-points-by-backup-vault', { BackupVaultName: string(vault.BackupVaultName), ByResourceType: type }, 'RecoveryPoints');
        for (const point of points) {
          const arn = string(point.ResourceArn), tableArn = regional('dynamodb', `table/${base}`);
          if (arn === tableArn || arn.startsWith(`${tableArn}-bot-`) || arn === `arn:aws:s3:::${location(this.target).bucket}`)
            throw new AppError('purge_retained_backup');
        }
      }
    }
    return resources;
  }
  async requireExclusiveRole(arn: string): Promise<void> {
    const base = `roughmate-${this.target.environment}`, kind = roleKinds.find(kind => arn === `arn:aws:iam::${this.target.accountId}:role/${base}-${this.target.region}-${kind}`);
    if (!kind)
      throw new AppError('purge_ownership');
    const expected = `${base}-${kind}`, functionArn = `arn:aws:lambda:${this.target.region}:${this.target.accountId}:function:${expected}`;
    const regions = (await this.items('ec2', 'describe-regions', { AllRegions: false }, 'Regions')).map(region => {
      if (typeof region.RegionName !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*$/.test(region.RegionName) || !['opt-in-not-required', 'opted-in'].includes(String(region.OptInStatus)))
        throw new AppError('purge_inventory');
      return region.RegionName;
    });
    if (!regions.includes(this.target.region) || new Set(regions).size !== regions.length)
      throw new AppError('purge_inventory');
    for (const region of regions) {
      for (const fn of await this.items('lambda', 'list-functions', { FunctionVersion: 'ALL' }, 'Functions', region)) {
        if (typeof fn.Role !== 'string' || !fn.Role)
          throw new AppError('purge_inventory');
        if (fn.Role !== arn)
          continue;
        if (region !== this.target.region || !functionKinds.includes(kind) || fn.FunctionName !== expected || !(fn.FunctionArn === functionArn || new RegExp(`^${functionArn}:(?:[1-9][0-9]*|\\$LATEST)$`).test(String(fn.FunctionArn))))
          throw new AppError('purge_shared_policy');
      }
    }
  }

  async requireExclusivePolicy(arn: string, roles: string[]): Promise<void> {
    for (const usage of ['PermissionsPolicy', 'PermissionsBoundary']) {
      const entities = await this.call('iam', 'list-entities-for-policy', { PolicyArn: arn, PolicyUsageFilter: usage });
      if (entities.IsTruncated === true || entities.Marker || !Array.isArray(entities.PolicyUsers) || !Array.isArray(entities.PolicyGroups) || !Array.isArray(entities.PolicyRoles) || entities.PolicyUsers.length || entities.PolicyGroups.length || entities.PolicyRoles.some(role => !roles.includes(string(object(role).RoleName))))
        throw new AppError('purge_shared_policy');
    }
  }
}
