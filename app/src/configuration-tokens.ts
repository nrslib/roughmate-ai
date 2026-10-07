import { randomUUID } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { AppError, object, string, type Workspace } from './contracts.js';
import { slackClient } from './slack.js';
import { Storage } from './storage.js';
import { configurationKey } from './registration.js';

interface ConfigurationTokens { token: string; refreshToken: string; teamId: string; userId: string; exp: number; }
export interface ConfigurationStatus { pk: typeof configurationKey; version: string; phase: 'ready' | 'rotating' | 'disconnected'; nextVersion?: string; }
export class ConfigurationAccess {
  private secrets: SecretsManagerClient;
  private db: DynamoDBDocumentClient;
  constructor(private root: Storage, private table: string, private secret: string, region?: string) {
    this.secrets = new SecretsManagerClient({ region, maxAttempts: 1 });
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1 }));
  }
  private async read(version: string): Promise<ConfigurationTokens> {
    const result = await this.secrets.send(new GetSecretValueCommand({ SecretId: this.secret, VersionId: version }));
    const value = object(JSON.parse(string(result.SecretString)));
    for (const key of ['token','refreshToken','teamId','userId']) string(value[key]);
    if (!Number.isSafeInteger(value.exp)) throw new AppError('configuration_boundary');
    return value as unknown as ConfigurationTokens;
  }
  private async saveStatus(previous: ConfigurationStatus | undefined, next: ConfigurationStatus): Promise<void> {
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: next,
        ConditionExpression: previous ? '#version = :version AND #phase = :phase' + (previous.phase === 'rotating' ? ' AND nextVersion = :nextVersion' : '') : 'attribute_not_exists(pk)',
        ...(previous ? { ExpressionAttributeNames: { '#version': 'version', '#phase': 'phase' }, ExpressionAttributeValues: { ':version': previous.version, ':phase': previous.phase, ...(previous.phase === 'rotating' ? { ':nextVersion': previous.nextVersion } : {}) } } : {}) }));
    } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') throw new AppError('configuration_busy'); throw error; }
  }
  private verify(tokens: ConfigurationTokens, workspace: Workspace, allowExpired = false): void {
    if (tokens.teamId !== workspace.teamId || tokens.userId !== workspace.ownerId || !Number.isSafeInteger(tokens.exp) || tokens.exp <= 0 || !allowExpired && tokens.exp <= Math.floor(Date.now()/1000) || tokens.exp > Math.floor(Date.now()/1000)+13*3600) throw new AppError('configuration_boundary');
  }
  private async exchange(refreshToken: string, workspace: Workspace): Promise<ConfigurationTokens> {
    const result = await slackClient(undefined, undefined, 30_000).tooling.tokens.rotate({ refresh_token: string(refreshToken) });
    const tokens = { token: string(result.token), refreshToken: string(result.refresh_token), teamId: string(result.team_id), userId: string(result.user_id), exp: Number(result.exp) };
    this.verify(tokens, workspace);
    return tokens;
  }
  async connect(refreshToken?: string, reconnect = false): Promise<void> {
    const workspace = await this.root.workspace();
    const previous = await this.root.get<ConfigurationStatus>(configurationKey);
    if (previous && (previous.pk !== configurationKey || !previous.version || !['ready','rotating','disconnected'].includes(previous.phase) || previous.phase === 'rotating' && !previous.nextVersion)) throw new AppError('configuration_boundary');
    if (!reconnect && previous && previous.phase !== 'disconnected') {
      await this.token(false);
      return;
    }
    if (!refreshToken) throw new AppError('configuration_refresh_required');
    const version = randomUUID();
    // 既存参照を残し、更新中の所有者はnextVersionまでCASで固定する。
    const intent: ConfigurationStatus = { pk: configurationKey, phase: 'rotating', version: previous?.version ?? version, nextVersion: version };
    await this.saveStatus(previous, intent);
    // 入力accessは本人確認に使わず、公式rotateが返すidentityと有効期限を照合する。
    const verified = await this.exchange(refreshToken, workspace);
    await this.secrets.send(new PutSecretValueCommand({ SecretId: this.secret, ClientRequestToken: version, SecretString: JSON.stringify(verified) }));
    await this.saveStatus(intent, { pk: configurationKey, phase: 'ready', version });
  }
  async token(force: boolean): Promise<string> {
    const workspace = await this.root.workspace();
    const previous = await this.root.get<ConfigurationStatus>(configurationKey);
    if (!previous || previous.phase === 'disconnected') throw new AppError('configuration_not_connected');
    if (previous.phase === 'rotating') {
      if (!previous.nextVersion) throw new AppError('configuration_boundary');
      let recovered: ConfigurationTokens;
      try { recovered = await this.read(previous.nextVersion); }
      catch (error) { if (error instanceof Error && error.name === 'ResourceNotFoundException') throw new AppError('configuration_rotation_unknown'); throw error; }
      this.verify(recovered, workspace, true);
      await this.saveStatus(previous, { pk: configurationKey, phase: 'ready', version: previous.nextVersion });
      if (force || recovered.exp <= Math.floor(Date.now()/1000)+3600) return this.token(force);
      return recovered.token;
    }
    if (previous.phase !== 'ready') throw new AppError('configuration_boundary');
    const tokens = await this.read(previous.version);
    this.verify(tokens, workspace, true);
    if (!force && tokens.exp > Math.floor(Date.now()/1000)+3600) return tokens.token;
    const nextVersion = randomUUID();
    const intent: ConfigurationStatus = { ...previous, phase: 'rotating', nextVersion };
    await this.saveStatus(previous, intent);
    // refreshは一回性のため、通信や保存の結果が不明なら旧tokenで再呼出ししない。
    const next = await this.exchange(tokens.refreshToken, workspace);
    await this.secrets.send(new PutSecretValueCommand({ SecretId: this.secret, ClientRequestToken: nextVersion, SecretString: JSON.stringify(next) }));
    await this.saveStatus(intent, { pk: configurationKey, phase: 'ready', version: nextVersion });
    return next.token;
  }
}
