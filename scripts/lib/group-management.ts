import { fenced, environmentFence } from './environment-lease.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { AppError, string } from '../../app/src/contracts.js';
import { Storage } from '../../app/src/storage.js';
import { enqueueWiki } from '../../app/src/wiki-queue.js';
import { requireAdmin, validateGroup, validateDocument, knowledgeLimits, type GroupConfig } from '../../app/src/groups.js';
import type { SetupAws } from './aws.js';
import type { Descriptor } from './config.js';
export async function manageGroup(aws: SetupAws, descriptor: Descriptor, command: string, options: { actor?: string; file?: string; id?: string; name?: string; description?: string }): Promise<void> {
  const setup = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }))).Item;
  if (setup?.phase !== 'created') throw new AppError('slack_app_unavailable');
  const store = fenced(new Storage(descriptor.tableName, descriptor.secretArn, undefined, descriptor.region));
  const workspace = await store.workspace();
  const identity = { environmentId: descriptor.secretArn, appId: string(setup.appId), teamId: workspace.teamId };
  if (command === 'migrate-config') {
    if (await store.get('roughmate')) throw new AppError('already_migrated');
    if (options.actor !== workspace.ownerId) throw new AppError('forbidden');
    const config: GroupConfig = { pk: 'roughmate', ...identity, version: 1, name: string(options.name), description: options.description ?? '', adminIds: [workspace.ownerId], notifyUserIds: [], intakeChannelIds: [], ...(workspace.channelId ? { reviewChannelId: workspace.channelId } : {}) };
    await store.initializeGroup(config);
    process.stdout.write('既存Slackアプリ・認証情報・workspaceを保持して設定を移行しました。受付チャンネルと任意通知をSlackホームで設定してください。\n');
    return;
  }
  const config = await store.group(identity);
  requireAdmin(config, string(options.actor));
  if (command === 'show-config') { process.stdout.write(JSON.stringify(config, null, 2) + '\n'); return; }
  if (command === 'configure') {
    const raw = await boundedJson(string(options.file), 16000);
    for (const key of ['intakeChannelIds', 'reviewChannelId', 'notifyUserIds'] as const) {
      if (Object.hasOwn(raw, key) && !isDeepStrictEqual(raw[key], config[key])) throw new AppError('settings_require_home');
    }
    const next = validateGroup({ ...config, pk: 'roughmate', ...identity, version: config.version + 1,
      ...(Object.hasOwn(raw, 'name') ? { name: raw.name } : {}),
      ...(Object.hasOwn(raw, 'description') ? { description: raw.description } : {}),
      ...(Object.hasOwn(raw, 'adminIds') ? { adminIds: raw.adminIds } : {}) });
    await store.saveGroup(config, next, string(options.actor));
    process.stdout.write('Roughmate設定を保存しました。表示名のSlackアプリへの反映は setup-slack --name を実行してください。\n');
    return;
  }
  const catalog = await store.manualKnowledge(identity);
  if (command === 'knowledge-list') {
    process.stdout.write(JSON.stringify(catalog.documents.map(({ id, title, source, version, channelIds, reviewChannelIds }) => ({ id, title, source, version, channelIds, reviewChannelIds })), null, 2) + '\n');
    return;
  }
  let documents = catalog.documents;
  if (command === 'knowledge-put') {
    const raw = await boundedJson(string(options.file), knowledgeLimits.bodyBytes + 12000);
    const id = string(raw.id);
    const previous = documents.find(document => document.id === id);
    const document = validateDocument({ ...raw, version: catalog.version + 1 });
    if (document.reviewChannelIds.some(channel => channel !== config.reviewChannelId)) throw new AppError('review_channel_not_allowed');
    if (document.channelIds.some(channel => !config.intakeChannelIds.includes(channel))) throw new AppError('intake_channel_not_allowed');
    documents = previous ? documents.map(current => current.id === id ? document : current) : [...documents, document];
  } else if (command === 'knowledge-delete') {
    if (!documents.some(document => document.id === options.id)) throw new AppError('knowledge_not_found');
    documents = documents.filter(document => document.id !== options.id);
  } else throw new AppError('invalid_input');
  const tasks=await store.saveKnowledge(config, catalog, { ...catalog, version: catalog.version + 1, documents }, string(options.actor));
  process.stdout.write('専用知識と整理待ち状態を保存しました。整理完了まで通常相談への利用を保留します。配送失敗時はBotのHomeから「今すぐ同期」で再開できます。\n');
  for(const key of tasks) { await environmentFence(); await enqueueWiki(identity,undefined,key,{url:`https://sqs.${descriptor.region}.amazonaws.com/${descriptor.accountId}/roughmate-${descriptor.environment}-wiki`,region:descriptor.region}); }
}
async function boundedJson(path: string, maxBytes: number): Promise<Record<string, unknown>> {
  if ((await stat(path)).size > maxBytes) throw new AppError('knowledge_too_large');
  const content = await readFile(path, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new AppError('knowledge_too_large');
  const raw: unknown = JSON.parse(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('invalid_input');
  return raw as Record<string, unknown>;
}
