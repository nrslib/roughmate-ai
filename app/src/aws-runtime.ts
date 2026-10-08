import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand, ListTagsOfResourceCommand, UpdateTimeToLiveCommand, type TableDescription, type Tag } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildResourceManager, SecretStore, JobQueue, RuntimeOptions } from './runtime-ports.js';
import type { BotResources, Registrations, Registration } from './registration.js';
import { AppError, string } from './contracts.js';
export class AwsSecretStore implements SecretStore {
  private client: SecretsManagerClient;
  constructor(region?: string) { this.client = new SecretsManagerClient({ region, maxAttempts: 1, requestHandler: { requestTimeout: 900, throwOnRequestTimeout: true, connectionTimeout: 500 } }); }
  async read(input: { id: string; version?: string }, options?: RuntimeOptions): Promise<string> { const result = await this.client.send(new GetSecretValueCommand({ SecretId: input.id, ...(input.version ? { VersionId: input.version } : {}) }), options); return string(result.SecretString); }
  async write(input: { id: string; operationId?: string; value: string }, options?: RuntimeOptions): Promise<void> { await this.client.send(new PutSecretValueCommand({ SecretId: input.id, SecretString: input.value, ...(input.operationId ? { ClientRequestToken: input.operationId } : {}) }), options); }
}
export class AwsJobQueue implements JobQueue {
  private client: SQSClient;
  constructor(region?: string) { this.client = new SQSClient({ region, maxAttempts: 1, requestHandler: { requestTimeout: 900, throwOnRequestTimeout: true, connectionTimeout: 500 } }); }
  async enqueue(input: { destination: string; body: string; delaySeconds?: number }, options?: RuntimeOptions): Promise<void> { await this.client.send(new SendMessageCommand({ QueueUrl: input.destination, MessageBody: input.body, ...(input.delaySeconds !== undefined ? { DelaySeconds: input.delaySeconds } : {}) }), options); }
}
export function awsChildNames(parentTable: string, parentSecret: string, id: string): BotResources {
  if (!/^[a-f0-9]{32}$/.test(id) || !/^roughmate-[a-z0-9-]+$/.test(parentTable)) throw new AppError('registration_boundary');
  const match = /^arn:aws:secretsmanager:([a-z0-9-]+):(\d{12}):secret:(roughmate-[a-z0-9-]+)\/runtime-[A-Za-z0-9]{6}$/.exec(parentSecret);
  if (!match || match[3] !== parentTable) throw new AppError('registration_boundary');
  const secretName = `${parentTable}/bots/${id}/runtime`;
  return { tableName: `${parentTable}-bot-${id}`, secretName, secretPrefix: `arn:aws:secretsmanager:${match[1]}:${match[2]}:secret:${secretName}-` };
}
export class AwsChildResources implements ChildResourceManager {
  names = awsChildNames;
  validSecret(resources: BotResources, secret: string): boolean { return secret.startsWith(resources.secretPrefix) && /^[A-Za-z0-9]{6}$/.test(secret.slice(resources.secretPrefix.length)); }
  ensure = ensureAwsResources;
}
const db = new DynamoDBClient({ maxAttempts: 1 });
const resourceSecrets = new SecretsManagerClient({ maxAttempts: 1 });
async function waitForChildTable(tableName: string, tableArn: string, tags: Tag[]): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    for (;;) {
      controller.signal.throwIfAborted();
      let table: TableDescription | undefined;
      try {
        table = (await db.send(new DescribeTableCommand({ TableName: tableName }), { abortSignal: controller.signal })).Table;
        if (!table) throw new AppError('registration_resources_pending');
      } catch (error) {
        // 作成直後はDescribeTableのmetadataがまだ反映されない場合がある。
        if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
      }
      if (table) {
        if (table.TableName !== tableName || table.TableArn !== tableArn || table.KeySchema?.length !== 1 || table.KeySchema[0].AttributeName !== 'pk' || table.KeySchema[0].KeyType !== 'HASH' || table.AttributeDefinitions?.length !== 1 || table.AttributeDefinitions[0].AttributeName !== 'pk' || table.AttributeDefinitions[0].AttributeType !== 'S') throw new AppError('registration_boundary');
        if (table.TableStatus === 'ACTIVE') {
          const tableTags = (await db.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }), { abortSignal: controller.signal })).Tags;
          controller.signal.throwIfAborted();
          if (!tags.every(tag => tableTags?.some(actual => actual.Key === tag.Key && actual.Value === tag.Value))) throw new AppError('registration_boundary');
          return;
        }
        if (table.TableStatus !== 'CREATING') throw new AppError('registration_resources_pending');
      }
      await delay(1000, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof AppError)) throw new AppError('registration_resources_pending');
    throw error;
  } finally { clearTimeout(timer); }
}
async function ensureAwsResources(registrations: Registrations, entry: Registration): Promise<string> {
  const target = awsChildNames(registrations.parentTable, registrations.parentSecret, entry.id);
  const tags = [{ Key: 'RoughmateParent', Value: registrations.parentTable }, { Key: 'RegistrationId', Value: entry.id }];
  try { await db.send(new CreateTableCommand({ TableName: target.tableName, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], Tags: tags })); }
  catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceInUseException') throw error; }
  const parentArn = registrations.parentSecret.split(':');
  await waitForChildTable(target.tableName, `arn:aws:dynamodb:${parentArn[3]}:${parentArn[4]}:table/${target.tableName}`, tags);
  const ttl = (await db.send(new DescribeTimeToLiveCommand({ TableName: target.tableName }))).TimeToLiveDescription;
  if (ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING') {
    if (ttl.AttributeName !== 'expiresAt') throw new AppError('registration_boundary');
  } else if (ttl?.TimeToLiveStatus === 'DISABLED') await db.send(new UpdateTimeToLiveCommand({ TableName: target.tableName, TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } }));
  else throw new AppError('registration_resources_pending');
  let arn: string;
  try {
    const root = await registrations.root.readSecrets();
    arn = string((await resourceSecrets.send(new CreateSecretCommand({ Name: target.secretName, ClientRequestToken: entry.id, SecretString: JSON.stringify({ apiKey: root.apiKey, model: root.model }), Tags: tags }))).ARN);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceExistsException') throw error;
    const existing = await resourceSecrets.send(new DescribeSecretCommand({ SecretId: target.secretName }));
    if (existing.Name !== target.secretName || existing.DeletedDate || !tags.every(tag => existing.Tags?.some(actual => actual.Key === tag.Key && actual.Value === tag.Value))) throw new AppError('registration_boundary');
    arn = string(existing.ARN);
  }
  if (!arn.startsWith(target.secretPrefix) || !/^[A-Za-z0-9]{6}$/.test(arn.slice(target.secretPrefix.length))) throw new AppError('registration_boundary');
  return arn;
}
