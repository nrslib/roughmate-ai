import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateTarget, type Target } from './lib/config.js';

type Statement = { Sid: string; Effect: 'Allow'; Action: string[]; Resource: string | string[]; Condition?: Record<string, Record<string, string | string[]>> };
const allow = (sid: string, actions: string[], resources: string | string[], condition?: Statement['Condition']): Statement => ({ Sid: sid, Effect: 'Allow', Action: actions, Resource: resources, ...(condition ? { Condition: condition } : {}) });

function policies(target: Target, binding: { apiId: string; mappingId: string } | undefined, bootstrapOnly: boolean): Record<string, Statement[]> {
  const { accountId, region, environment } = target;
  const name = `roughmate-${environment}`;
  const arn = (service: string, resource: string): string => `arn:aws:${service}:${region}:${accountId}:${resource}`;
  const roleArn = (kind: string): string => `arn:aws:iam::${accountId}:role/${name}-${region}-${kind}`;
  const boundaryArn = (kind: string): string => `arn:aws:iam::${accountId}:policy/${name}-${region}-${kind}-boundary`;
  const functionArn = (kind: string): string => arn('lambda', `function:${name}-${kind}`);
  const secret = arn('secretsmanager', `secret:${name}/runtime-??????`);
  const table = arn('dynamodb', `table/${name}`);
  const childTable = `${table}-bot-${'?'.repeat(32)}`;
  const childSecret = arn('secretsmanager', `secret:${name}/bots/*/runtime-??????`);
  const configurationSecret = arn('secretsmanager', `secret:${name}/configuration-??????`);
  const wikiQueue = arn('sqs', `${name}-wiki`);
  const provisionQueue = arn('sqs', `${name}-provision`);
  const bucket = `arn:aws:s3:::roughmate-state-${accountId}-${region}`;
  const result: Record<string, Statement[]> = {};
  if (bootstrapOnly) return { RoughmateStateBootstrapAccess: [allow('SharedStateBucketBootstrap', ['s3:CreateBucket', 's3:ListBucket', 's3:GetBucketTagging', 's3:PutBucketTagging', 's3:PutBucketVersioning', 's3:PutEncryptionConfiguration', 's3:PutBucketPublicAccessBlock'], bucket)] };
  const wikiKeys = (keys:string[]):Statement['Condition'] => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': keys }, Null: { 'dynamodb:LeadingKeys': 'false' } });
  const wikiData = [
    allow('WikiReads', ['dynamodb:GetItem'], [table, childTable], wikiKeys(['workspace','roughmate','knowledge','wiki','wiki-source#*','wiki-manual#*','wiki-manual-history#*','wiki-version#*','wiki-answer#*','wiki-pending#*','wiki-proposal#*','wiki-maintenance#*','wiki-command#*','wiki-view#*','wiki-erasure#*','wiki-erasure-node#*','request#*'])),
    allow('WikiBindingReads', ['dynamodb:GetItem'], table, wikiKeys(['registrations','bot-archive#*'])),
    allow('WikiWrites', ['dynamodb:PutItem'], [table, childTable], wikiKeys(['wiki','wiki-source#*','wiki-manual#*','wiki-version#*','wiki-answer#*','wiki-pending#*','wiki-proposal#*','wiki-maintenance#*','wiki-command#*','wiki-view#*','wiki-erasure#*','wiki-erasure-node#*'])),
    allow('WikiRetentionUpdates', ['dynamodb:UpdateItem'], [table, childTable], wikiKeys(['request#*'])),
    allow('WikiPublicationUpdates', ['dynamodb:UpdateItem'], [table, childTable], wikiKeys(['roughmate'])),
    allow('WikiPublicationChecks', ['dynamodb:ConditionCheckItem'], [table, childTable], wikiKeys(['roughmate','knowledge','wiki']))
  ];
  for (const kind of ['http', 'worker', 'wiki-runner']) {
    result[`${name}-${region}-${kind}-boundary`] = [
      ...(kind === 'wiki-runner' ? wikiData : [allow('ApplicationData', ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem'], [table, childTable])]),
      allow('RuntimeSecrets', kind === 'http' ? ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'] : ['secretsmanager:GetSecretValue'], [secret, childSecret]),
      allow('JobQueue', kind === 'http' ? ['sqs:SendMessage'] : ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'], kind === 'http' ? [arn('sqs', `${name}-jobs`), provisionQueue] : kind === 'worker' ? arn('sqs', `${name}-jobs`) : wikiQueue),
      allow('WikiTasks', ['sqs:SendMessage'], wikiQueue),
      allow('FunctionLogs', ['logs:CreateLogStream', 'logs:PutLogEvents'], arn('logs', `log-group:/aws/lambda/${name}-${kind}:*`))
    ];
  }
  result[`${name}-${region}-provisioner-boundary`] = [
    allow('RegistrationReads', ['dynamodb:GetItem'], table, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['workspace','registrations','registration#configuration','bot-archive#*'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('RegistrationWrites', ['dynamodb:PutItem'], table, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['registrations','registration#configuration','bot-archive#*'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('DeletionOwnerCheck', ['dynamodb:ConditionCheckItem'], table, wikiKeys(['workspace'])),
    allow('ChildTables', ['dynamodb:DescribeTable','dynamodb:DescribeTimeToLive','dynamodb:UpdateTimeToLive','dynamodb:ListTagsOfResource'], childTable),
    allow('ChildInitializationReads', ['dynamodb:GetItem'], childTable, { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['roughmate','knowledge','wiki'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('ChildInitializationWrites', ['dynamodb:PutItem'], childTable, { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['roughmate#setup','roughmate','knowledge'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('ChildWorkspaceReservation', ['dynamodb:UpdateItem'], childTable, { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['workspace','roughmate'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('CreateTaggedChildTable', ['dynamodb:CreateTable','dynamodb:TagResource'], childTable, { StringEquals: { 'aws:RequestTag/RoughmateParent': name }, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['RoughmateParent','RegistrationId'] }, Null: { 'aws:TagKeys': 'false', 'aws:RequestTag/RegistrationId': 'false' } }),
    allow('ParentModelConfiguration', ['secretsmanager:GetSecretValue'], secret),
    allow('ConfigurationTokens', ['secretsmanager:GetSecretValue','secretsmanager:PutSecretValue'], configurationSecret),
    allow('ChildSecretVersions', ['secretsmanager:DescribeSecret','secretsmanager:GetSecretValue','secretsmanager:PutSecretValue'], childSecret),
    allow('CreateTaggedChildSecret', ['secretsmanager:CreateSecret','secretsmanager:TagResource'], childSecret, { StringEquals: { 'aws:RequestTag/RoughmateParent': name }, 'ForAllValues:StringEquals': { 'aws:TagKeys': ['RoughmateParent','RegistrationId'] }, Null: { 'aws:TagKeys': 'false', 'aws:RequestTag/RegistrationId': 'false' } }),
    allow('ProvisionQueue', ['sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes','sqs:SendMessage'], provisionQueue),
    allow('ParentHomeQueue', ['sqs:SendMessage'], [arn('sqs', `${name}-jobs`),wikiQueue]),
    allow('ProvisionLogs', ['logs:CreateLogStream','logs:PutLogEvents'], arn('logs', `log-group:/aws/lambda/${name}-provisioner:*`))
  ];
  result[`${name}-${region}-scheduler-boundary`] = [allow('RefreshQueueOnly', ['sqs:SendMessage'], [provisionQueue, arn('sqs', `${name}-provision-dead`)])];
  if (!binding) return result;
  const api = `arn:aws:apigateway:${region}::/apis/${binding.apiId}`;
  const mapping = arn('lambda', `event-source-mapping:${binding.mappingId}`);
  const deployment = [
    allow('TableLifecycle', ['dynamodb:CreateTable', 'dynamodb:DeleteTable', 'dynamodb:DescribeTable', 'dynamodb:UpdateTable', 'dynamodb:DescribeTimeToLive', 'dynamodb:UpdateTimeToLive', 'dynamodb:DescribeContinuousBackups', 'dynamodb:UpdateContinuousBackups', 'dynamodb:ListTagsOfResource', 'dynamodb:TagResource', 'dynamodb:UntagResource'], table),
    allow('QueueLifecycle', ['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SetQueueAttributes', 'sqs:ListQueueTags', 'sqs:TagQueue', 'sqs:UntagQueue'], ['jobs', 'dead'].map(kind => arn('sqs', `${name}-${kind}`))),
    allow('SecretLifecycle', ['secretsmanager:CreateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:UpdateSecret', 'secretsmanager:GetResourcePolicy', 'secretsmanager:TagResource', 'secretsmanager:UntagResource'], secret),
    allow('LogGroupLifecycle', ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:TagResource', 'logs:UntagResource', 'logs:ListTagsForResource'], ['http', 'worker'].flatMap(kind => ['', ':*'].map(suffix => arn('logs', `log-group:/aws/lambda/${name}-${kind}${suffix}`)))),
    // 削除後のmapping参照はAWSがresource "*"で認可するため、完了待ちの読み取りをリージョンで制限する。
    allow('RegionalLifecycleReads', ['logs:DescribeLogGroups', 'lambda:GetEventSourceMapping'], '*', { StringEquals: { 'aws:RequestedRegion': region } }),
    allow('FunctionLifecycle', ['lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:GetFunctionCodeSigningConfig', 'lambda:GetPolicy', 'lambda:ListVersionsByFunction', 'lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource', 'lambda:AddPermission', 'lambda:RemovePermission'], ['http', 'worker'].map(functionArn)),
    allow('RoleLifecycle', ['iam:GetRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateAssumeRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:ListRoleTags', 'iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies', 'iam:ListInstanceProfilesForRole'], ['http', 'worker'].map(roleArn)),
    ...['http', 'worker'].map(kind => allow(`Create${kind === 'http' ? 'Http' : 'Worker'}RoleWithBoundary`, ['iam:CreateRole'], roleArn(kind), { ArnEquals: { 'iam:PermissionsBoundary': boundaryArn(kind) } })),
    allow('PassRolesToLambda', ['iam:PassRole'], ['http', 'worker'].map(roleArn), { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } }),
    allow('CreateWorkerMapping', ['lambda:CreateEventSourceMapping'], '*', { ArnEquals: { 'lambda:FunctionArn': functionArn('worker') }, StringEquals: { 'aws:RequestedRegion': region } }),
    allow('WorkerMappingTags', ['lambda:ListTags', 'lambda:TagResource', 'lambda:UntagResource'], mapping),
    allow('ChangeWorkerMapping', ['lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping'], mapping, { ArnEquals: { 'lambda:FunctionArn': functionArn('worker') } }),
    allow('CreateNamedApi', ['apigateway:POST'], `arn:aws:apigateway:${region}::/apis`, { StringEquals: { 'apigateway:Request/ApiName': name } }),
    allow('ManageBoundApi', ['apigateway:GET', 'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE'], [api, `${api}/*`]),
    // 実APIのタグ付き作成が要求する個別アクション名はIAM検証を通らないため、コレクションARNで制限する。
    allow('CreateTaggedStages', ['apigateway:*'], `${api}/stages`),
    allow('BoundApiTags', ['apigateway:GET', 'apigateway:POST', 'apigateway:DELETE'], [`arn:aws:apigateway:${region}::/tags/${api}`, `arn:aws:apigateway:${region}::/tags/${api}/*`])
  ];
  result.RoughmateDeploymentAccess = deployment;
  result.RoughmateSetupAccess = [
    allow('StateBucketChecks', ['s3:GetBucketLocation', 's3:GetBucketTagging', 's3:GetBucketVersioning', 's3:GetEncryptionConfiguration', 's3:GetBucketPublicAccessBlock'], bucket),
    allow('EnvironmentStateListing', ['s3:ListBucket'], bucket, { StringLike: { 's3:prefix': `environments/${environment}/*` } }),
    allow('EnvironmentState', ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], ['setup.json','removal.json','operation.json','terraform.tfstate','terraform.tfstate.tflock'].map(key=>`${bucket}/environments/${environment}/${key}`)),
    allow('PurgeExclusionRead', ['s3:GetObject'], ['plan.json','anchor.json'].map(key=>`${bucket}/environments/${environment}/protected-purge/${key}`)),
    allow('RootEnrollmentRead', ['s3:GetObject'], `${bucket}/environments/${environment}/protected-purge/root-genesis.json`),
    allow('SetupRecords', ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem'], table, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['setup#slack', 'workspace', 'oauth#*', 'roughmate', 'roughmate#setup', 'knowledge', 'settings#*', 'registrations'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('ManualHistoryRecords', ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem'], table, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['wiki-manual#*', 'wiki-manual-history#*'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('ManualPreparationRootRead', ['dynamodb:GetItem'], table, wikiKeys(['wiki'])),
    allow('ManualPreparationWrites', ['dynamodb:PutItem'], table, wikiKeys(['knowledge','wiki','wiki-manual#*','wiki-manual-history#*'])),
    allow('ManualPreparationChecks', ['dynamodb:ConditionCheckItem'], table, wikiKeys(['roughmate','wiki-manual#*'])),
    allow('ManualPreparationQueue', ['sqs:SendMessage'], wikiQueue),
    allow('RuntimeConfiguration', ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'], secret),
    allow('VerifyEndpointFunction', ['lambda:GetFunctionConfiguration'], functionArn('http')),
    allow('VerifyEndpointApi', ['apigateway:GET'], api)
  ];
  result.RoughmateRegistrationSetupAccess = [
    allow('ConfigurationConnectionRecord', ['dynamodb:GetItem','dynamodb:PutItem'], table, { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['workspace', 'registration#configuration'] }, Null: { 'dynamodb:LeadingKeys': 'false' } }),
    allow('ConnectConfigurationTokens', ['secretsmanager:GetSecretValue','secretsmanager:PutSecretValue'], configurationSecret)
  ];
  const registrationRole = [roleArn('provisioner'), roleArn('scheduler')], registrationFunction = functionArn('provisioner');
  const scheduleGroup = arn('scheduler', `schedule-group/${name}-configuration`);
  const schedule = arn('scheduler', `schedule/${name}-configuration/${name}-configuration-refresh`);
  result.RoughmateRegistrationDeploymentAccess = [
    allow('RegistrationQueues', ['sqs:CreateQueue','sqs:DeleteQueue','sqs:GetQueueAttributes','sqs:GetQueueUrl','sqs:SetQueueAttributes','sqs:ListQueueTags','sqs:TagQueue','sqs:UntagQueue'], [provisionQueue, arn('sqs', `${name}-provision-dead`)]),
    allow('ConfigurationSecretLifecycle', ['secretsmanager:CreateSecret','secretsmanager:DeleteSecret','secretsmanager:DescribeSecret','secretsmanager:UpdateSecret','secretsmanager:GetResourcePolicy','secretsmanager:TagResource','secretsmanager:UntagResource'], configurationSecret),
    allow('RegistrationLogs', ['logs:CreateLogGroup','logs:DeleteLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource','logs:ListTagsForResource'], ['', ':*'].map(suffix => arn('logs', `log-group:/aws/lambda/${name}-provisioner${suffix}`))),
    allow('RegistrationFunction', ['lambda:CreateFunction','lambda:DeleteFunction','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:GetFunctionCodeSigningConfig','lambda:GetPolicy','lambda:ListVersionsByFunction','lambda:ListTags','lambda:TagResource','lambda:UntagResource','lambda:PutFunctionConcurrency','lambda:DeleteFunctionConcurrency','lambda:GetFunctionConcurrency'], registrationFunction),
    allow('RegistrationRole', ['iam:GetRole','iam:DeleteRole','iam:UpdateRole','iam:UpdateAssumeRolePolicy','iam:TagRole','iam:UntagRole','iam:ListRoleTags','iam:PutRolePolicy','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:ListInstanceProfilesForRole'], registrationRole),
    ...['provisioner','scheduler'].map(kind => allow(`CreateBounded${kind}Role`, ['iam:CreateRole'], roleArn(kind), { ArnEquals: { 'iam:PermissionsBoundary': boundaryArn(kind) } })),
    allow('PassRegistrationRole', ['iam:PassRole'], roleArn('provisioner'), { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } }),
    allow('PassSchedulerRole', ['iam:PassRole'], roleArn('scheduler'), { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } }),
    allow('RegistrationMapping', ['lambda:CreateEventSourceMapping','lambda:UpdateEventSourceMapping','lambda:DeleteEventSourceMapping'], '*', { ArnEquals: { 'lambda:FunctionArn': registrationFunction }, StringEquals: { 'aws:RequestedRegion': region } }),
    allow('RegistrationMappingReads', ['lambda:ListTags'], arn('lambda', 'event-source-mapping:*')),
    allow('ConfigurationScheduleGroup', ['scheduler:CreateScheduleGroup','scheduler:DeleteScheduleGroup','scheduler:GetScheduleGroup','scheduler:ListTagsForResource','scheduler:TagResource','scheduler:UntagResource'], scheduleGroup),
    allow('ConfigurationRefreshSchedule', ['scheduler:CreateSchedule','scheduler:UpdateSchedule','scheduler:DeleteSchedule','scheduler:GetSchedule'], schedule)
  ];
  const wikiRole=roleArn('wiki-runner'),wikiFunction=functionArn('wiki-runner');
  result.RoughmateWikiDeploymentAccess = [
    allow('WikiQueues', ['sqs:CreateQueue','sqs:DeleteQueue','sqs:GetQueueAttributes','sqs:GetQueueUrl','sqs:SetQueueAttributes','sqs:ListQueueTags','sqs:TagQueue','sqs:UntagQueue'], [wikiQueue,arn('sqs',`${name}-wiki-dead`)]),
    allow('WikiLogs', ['logs:CreateLogGroup','logs:DeleteLogGroup','logs:PutRetentionPolicy','logs:DeleteRetentionPolicy','logs:TagResource','logs:UntagResource','logs:ListTagsForResource'], ['',':*'].map(suffix=>arn('logs',`log-group:/aws/lambda/${name}-wiki-runner${suffix}`))),
    allow('WikiFunction', ['lambda:CreateFunction','lambda:DeleteFunction','lambda:UpdateFunctionCode','lambda:UpdateFunctionConfiguration','lambda:GetFunction','lambda:GetFunctionConfiguration','lambda:GetFunctionCodeSigningConfig','lambda:GetPolicy','lambda:ListVersionsByFunction','lambda:ListTags','lambda:TagResource','lambda:UntagResource'], wikiFunction),
    allow('WikiRole', ['iam:GetRole','iam:DeleteRole','iam:UpdateRole','iam:UpdateAssumeRolePolicy','iam:TagRole','iam:UntagRole','iam:ListRoleTags','iam:PutRolePolicy','iam:GetRolePolicy','iam:DeleteRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:ListInstanceProfilesForRole'], wikiRole),
    allow('CreateWikiRoleWithBoundary', ['iam:CreateRole'], wikiRole, {ArnEquals:{'iam:PermissionsBoundary':boundaryArn('wiki-runner')}}),
    allow('PassWikiRole', ['iam:PassRole'], wikiRole, {StringEquals:{'iam:PassedToService':'lambda.amazonaws.com'}}),
    allow('WikiMapping', ['lambda:CreateEventSourceMapping','lambda:UpdateEventSourceMapping','lambda:DeleteEventSourceMapping'], '*', {ArnEquals:{'lambda:FunctionArn':wikiFunction},StringEquals:{'aws:RequestedRegion':region}}),
    allow('WikiMappingReads', ['lambda:ListTags'], arn('lambda','event-source-mapping:*'))
  ];
  return result;
}

const { values } = parseArgs({ options: {
  account: { type: 'string' }, region: { type: 'string' }, env: { type: 'string' },
  'api-id': { type: 'string' }, 'mapping-id': { type: 'string' }, out: { type: 'string' },
  'boundaries-only': { type: 'boolean' }, 'bootstrap-only': { type: 'boolean' }
} });
function required(key: Exclude<keyof typeof values, 'boundaries-only' | 'bootstrap-only'>): string {
  const value = values[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} が必要です。`);
  return value;
}
const target = validateTarget({ accountId: required('account'), region: required('region'), environment: required('env') });
const boundariesOnly = values['boundaries-only'] === true;
const bootstrapOnly = values['bootstrap-only'] === true;
if (boundariesOnly && bootstrapOnly || (boundariesOnly || bootstrapOnly) && (values['api-id'] !== undefined || values['mapping-id'] !== undefined)) throw new Error('--boundaries-only / --bootstrap-only は互いに、またID指定と併用できません。');
const binding = boundariesOnly || bootstrapOnly ? undefined : { apiId: required('api-id'), mappingId: required('mapping-id') };
if (binding && (!/^[a-z0-9]+$/.test(binding.apiId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.mappingId))) throw new Error('API IDまたはmapping IDが不正です。');
const destination = resolve(required('out'));
const generated = Object.entries(policies(target, binding, bootstrapOnly)).map(([name, statements]) => {
  const policy = { Version: '2012-10-17', Statement: statements };
  const length = JSON.stringify(policy).length;
  if (length > 6144) throw new Error(`${name} がIAM managed policyの文字数上限を超えました。`);
  return { name, policy, length };
});
await mkdir(destination, { recursive: true });
for (const { name, policy, length } of generated) {
  await writeFile(resolve(destination, `${name}.json`), JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`${name}: ${length}/6144文字\n`);
}
