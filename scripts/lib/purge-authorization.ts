import { AppError, object, string } from '../../app/src/contracts.js';
import type { PurgeAwsCli } from './purge-inventory.js';
export function policyDocument(raw: unknown): Record<string, unknown> {
  try {
    return typeof raw === 'string' ? object(JSON.parse(raw.trim().startsWith('{') ? raw : decodeURIComponent(raw))) : object(raw);
  }
  catch {
    throw new AppError('purge_ownership');
  }
}
export function requireServiceTrust(raw: unknown, roleName: string, cli: PurgeAwsCli): void {
  const doc = policyDocument(raw), statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  if (doc.Version !== '2012-10-17' || statements.length !== 1)
    throw new AppError('purge_shared_policy');
  const s = object(statements[0]), principal = object(s.Principal), scheduler = roleName.endsWith('-scheduler');
  const singleton = (value: unknown, expected: string) => value === expected || Array.isArray(value) && value.length === 1 && value[0] === expected;
  if (Object.keys(s).some(key => !['Sid', 'Effect', 'Principal', 'Action', 'Condition'].includes(key)) || s.Effect !== 'Allow' || !singleton(s.Action, 'sts:AssumeRole') || Object.keys(principal).join(',') !== 'Service' || !singleton(principal.Service, scheduler ? 'scheduler.amazonaws.com' : 'lambda.amazonaws.com'))
    throw new AppError('purge_shared_policy');
  if (!scheduler) {
    if (s.Condition !== undefined)
      throw new AppError('purge_shared_policy');
    return;
  }
  const c = object(s.Condition), account = object(c.StringEquals), source = object(c.ArnEquals);
  if (Object.keys(c).sort().join(',') !== 'ArnEquals,StringEquals' || Object.keys(account).join(',') !== 'aws:SourceAccount' || !singleton(account['aws:SourceAccount'], cli.target.accountId) || Object.keys(source).join(',') !== 'aws:SourceArn' || !singleton(source['aws:SourceArn'], `arn:aws:scheduler:${cli.target.region}:${cli.target.accountId}:schedule-group/roughmate-${cli.target.environment}-configuration`))
    throw new AppError('purge_shared_policy');
}
const actions = ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObjectVersion', 's3:ListBucketVersions', 'dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:DeleteTable', 'dynamodb:DeleteBackup', 'secretsmanager:GetSecretValue', 'secretsmanager:DeleteSecret', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunction', 'lambda:DeleteEventSourceMapping', 'apigateway:DELETE', 'sqs:DeleteQueue', 'logs:DeleteLogGroup', 'scheduler:DeleteSchedule', 'scheduler:DeleteScheduleGroup', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DeletePolicy', 'iam:DeletePolicyVersion'];
export async function authorizePurge(cli: PurgeAwsCli, identity: Record<string, unknown>): Promise<void> {
  try {
    const arn = string(identity.Arn), uid = string(identity.UserId);
    let entity: Record<string, unknown>, kind: 'user' | 'role', name: string;
    if (arn.startsWith(`arn:aws:iam::${cli.target.accountId}:user/`)) {
      kind = 'user';
      name = arn.split('/').at(-1)!;
      entity = object((await cli.call('iam', 'get-user', { UserName: name })).User);
      if (entity.Arn !== arn || entity.UserId !== uid)
        throw new AppError('purge_admin_required');
    }
    else {
      const match = new RegExp(`^arn:aws:sts::${cli.target.accountId}:assumed-role/([^/]+)/[^/]+$`).exec(arn);
      if (!match)
        throw new AppError('purge_admin_required');
      kind = 'role';
      name = match[1];
      entity = object((await cli.call('iam', 'get-role', { RoleName: name })).Role);
      if (!string(entity.Arn).startsWith(`arn:aws:iam::${cli.target.accountId}:role/`) || entity.RoleId !== uid.split(':')[0])
        throw new AppError('purge_admin_required');
    }
    if (identity.Account !== cli.target.accountId || entity.PermissionsBoundary !== undefined)
      throw new AppError('purge_admin_required');
    const docs: Record<string, unknown>[] = [];
    const policies = async (type: 'user' | 'role' | 'group', entityName: string) => {
      const input = { [`${type[0].toUpperCase() + type.slice(1)}Name`]: entityName };
      for (const p of await cli.items('iam', `list-attached-${type}-policies`, input, 'AttachedPolicies')) {
        const policy = object((await cli.call('iam', 'get-policy', { PolicyArn: p.PolicyArn })).Policy);
        docs.push(policyDocument(object((await cli.call('iam', 'get-policy-version', { PolicyArn: p.PolicyArn, VersionId: policy.DefaultVersionId })).PolicyVersion).Document));
      }
      const inline = await cli.call('iam', `list-${type}-policies`, input);
      if (!Array.isArray(inline.PolicyNames) || inline.IsTruncated === true || inline.Marker)
        throw new AppError('purge_admin_required');
      for (const policyName of inline.PolicyNames)
        docs.push(policyDocument((await cli.call('iam', `get-${type}-policy`, { ...input, PolicyName: string(policyName) })).PolicyDocument));
    };
    await policies(kind, name);
    if (kind === 'user')
      for (const group of await cli.items('iam', 'list-groups-for-user', { UserName: name }, 'Groups'))
        await policies('group', string(group.GroupName));
    const all = (value: unknown) => value === '*' || Array.isArray(value) && value.length === 1 && value[0] === '*';
    if (!docs.some(doc => (Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]).some(raw => { const s = object(raw); return s.Effect === 'Allow' && all(s.Action) && all(s.Resource) && s.Condition === undefined && s.NotAction === undefined && s.NotResource === undefined; })))
      throw new AppError('purge_admin_required');
    const results = await cli.items('iam', 'simulate-principal-policy', { PolicySourceArn: entity.Arn, ActionNames: actions, ResourceArns: ['*'], ContextEntries: [{ ContextKeyName: 'aws:RequestedRegion', ContextKeyValues: [cli.target.region], ContextKeyType: 'string' }] }, 'EvaluationResults');
    if (results.length !== actions.length || actions.some(action => !results.some(result => result.EvalActionName === action && result.EvalDecision === 'allowed' && (result.MissingContextValues === undefined || Array.isArray(result.MissingContextValues) && !result.MissingContextValues.length) && (!result.OrganizationsDecisionDetail || object(result.OrganizationsDecisionDetail).AllowedByOrganizations === true) && (!result.PermissionsBoundaryDecisionDetail || object(result.PermissionsBoundaryDecisionDetail).AllowedByPermissionsBoundary === true))))
      throw new AppError('purge_admin_required');
  }
  catch {
    throw new AppError('purge_admin_required');
  }
}
const ordinaryPolicies = ['RoughmateSetupAccess', 'RoughmateDeploymentAccess', 'RoughmateRegistrationSetupAccess', 'RoughmateRegistrationDeploymentAccess', 'RoughmateWikiDeploymentAccess'];
export function grantsProtectedMutation(raw: unknown, cli: PurgeAwsCli): boolean {
  const doc = policyDocument(raw), statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  const glob = (pattern: string, value: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);
  const resources = ['plan.json', 'anchor.json', 'evidence.json','root-genesis.json','root-ledger.json'].map(key => `arn:aws:s3:::roughmate-state-${cli.target.accountId}-${cli.target.region}/environments/${cli.target.environment}/protected-purge/${key}`);
  for (const rawStatement of statements) {
    const s = object(rawStatement);
    if (s.Effect !== 'Allow')
      continue;
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (s.NotAction === undefined && !actions.some(action => typeof action === 'string' && ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectAcl', 's3:PutObjectVersionAcl'].some(operation => glob(action, operation))))
      continue;
    if (s.NotResource !== undefined)
      return true;
    const refs = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    if (refs.some(ref => typeof ref === 'string' && resources.some(resource => glob(ref, resource))))
      return true;
  }
  return false;
}
export async function requireProtectedPolicyBoundary(cli: PurgeAwsCli): Promise<void> {
  for (const name of ordinaryPolicies) {
    const arn = `arn:aws:iam::${cli.target.accountId}:policy/${name}`, policy = await cli.optional('iam', 'get-policy', { PolicyArn: arn }, ['NoSuchEntity']);
    if (!policy)
      continue;
    const metadata = object(policy.Policy);
    if (metadata.AttachmentCount === 0 && metadata.PermissionsBoundaryUsageCount === 0)
      continue;
    const version = object((await cli.call('iam', 'get-policy-version', { PolicyArn: arn, VersionId: metadata.DefaultVersionId })).PolicyVersion);
    if (grantsProtectedMutation(version.Document, cli))
      throw new AppError('purge_protection_required');
  }
}
