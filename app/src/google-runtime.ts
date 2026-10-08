import { createHash, randomUUID } from 'node:crypto';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { CloudTasksClient } from '@google-cloud/tasks';
import { FirestoreDocumentStore } from './firestore-document-store.js';
import type { Runtime } from './runtime.js';
import type { RuntimeOptions, SecretStore, JobQueue, ChildResourceManager } from './runtime-ports.js';
import { SecretVersionUnavailableError } from './runtime-ports.js';
import type { BotResources, Registrations, Registration } from './registration.js';
import { AppError, string } from './contracts.js';
import { createGoogleFirestore, disableGooglePayloadLogging, firestoreRpc, firestoreReceipt, googleRpcOptions as rpcOptions } from './google-rpc.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function rejectedWrite(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' && [3, 5, 7, 9].includes(error.code);
}
function requireRejectedReceipt(receipt: { rejectionCode?: unknown; attempt?: unknown; digest?: unknown }): void {
  if (!rejectedWrite({ code: receipt.rejectionCode }) || typeof receipt.attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.attempt) || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('secret_operation_invalid');
}
function requirePreparedReceipt(receipt: { attempt?: unknown; digest?: unknown; sendAttempt?: unknown }): void {
  if (receipt.sendAttempt !== undefined || typeof receipt.attempt !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.attempt) || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('secret_operation_invalid');
}
export interface GoogleRuntimeConfig { project: string; projectNumber: string; database: string; environment: string; location: string; workerUrl: string; taskAccount: string; }
class GoogleClient<T extends { initialize(): Promise<unknown>; close(): Promise<void> }> {
  constructor(private client: T, private createClient: () => T) {}
  async initialize(): Promise<T> {
    const client = this.client;
    try { await client.initialize(); }
    catch (error) {
      if (this.client === client) {
        this.client = this.createClient();
        void client.close().catch(() => {});
      }
      throw error;
    }
    return client;
  }
}
export class GoogleSecretStore implements SecretStore {
  private client: GoogleClient<SecretManagerServiceClient>;
  constructor(client: SecretManagerServiceClient | GoogleClient<SecretManagerServiceClient>, private db: Firestore, private config: GoogleRuntimeConfig, private rpcTimeoutMs = 30_000, createClient?: () => SecretManagerServiceClient) {
    disableGooglePayloadLogging(); this.client = client instanceof GoogleClient ? client : new GoogleClient(client, createClient ?? (() => new SecretManagerServiceClient()));
  }
  private transaction<T>(operation: (transaction: Transaction) => Promise<T>, options?: RuntimeOptions): Promise<T> {
    return firestoreRpc(this.rpcTimeoutMs, options, () => this.db.runTransaction(operation, { maxAttempts: 1 }));
  }
  private saveReceipt<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    return firestoreReceipt(this.rpcTimeoutMs, () => this.db.runTransaction(operation, { maxAttempts: 1 }));
  }
  private requireId(id: string): void {
    const prefix = `projects/${this.config.projectNumber}/secrets/${this.config.environment}`;
    if (id !== prefix + '-runtime' && id !== prefix + '-configuration' && !new RegExp(`^${prefix}-bot-[a-f0-9]{32}-runtime$`).test(id)) throw new AppError('registration_boundary');
  }
  private operation(id: string, operationId: string) { return this.db.collection('secretOperations').doc(digest(id + '\0' + operationId)); }
  private async access(name: string, options?: RuntimeOptions): Promise<{ operationId: string; value: string }> {
    const client = await this.client.initialize();
    const [result] = await client.accessSecretVersion({ name }, rpcOptions(this.rpcTimeoutMs, options));
    const bytes = result.payload?.data;
    if (!bytes || !result.name || !result.name.startsWith(name.slice(0, name.lastIndexOf('/versions/')) + '/versions/')) throw new Error('secret_payload_invalid');
    const text = (typeof bytes === 'string' ? Buffer.from(bytes, 'base64') : Buffer.from(bytes)).toString('utf8');
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== 'object' || !('operationId' in envelope) || !('value' in envelope) || typeof envelope.operationId !== 'string' || typeof envelope.value !== 'string') throw new Error('secret_payload_invalid');
    return { operationId: envelope.operationId, value: envelope.value };
  }
  async read(input: { id: string; version?: string }, options?: RuntimeOptions): Promise<string> {
    this.requireId(input.id); options?.abortSignal?.throwIfAborted();
    if (!input.version) return (await this.access(input.id + '/versions/latest', options)).value;
    const reference = this.operation(input.id, input.version), snapshot = await firestoreRpc(this.rpcTimeoutMs, options, () => reference.get()), receipt = snapshot.data();
    if (!receipt) throw new SecretVersionUnavailableError('missing');
    if (receipt.secret !== input.id || receipt.operationId !== input.version) throw new Error('secret_operation_conflict');
    if (receipt.phase === 'prepared') { requirePreparedReceipt(receipt); throw new SecretVersionUnavailableError('unsent'); }
    if (receipt.phase === 'rejected') { requireRejectedReceipt(receipt); throw new SecretVersionUnavailableError('rejected'); }
    if (receipt.phase === 'ready' && typeof receipt.version === 'string') {
      if (!receipt.version.startsWith(input.id + '/versions/')) throw new Error('secret_operation_conflict');
      const recovered = await this.access(receipt.version, options);
      if (recovered.operationId !== input.version || digest(recovered.value) !== receipt.digest) throw new Error('secret_operation_conflict');
      return recovered.value;
    }
    if (receipt.phase !== 'pending') throw new Error('secret_operation_invalid');
    // addVersion has no idempotency key. Recover its durable result, never resend it.
    const client = await this.client.initialize();
    const [versions] = await client.listSecretVersions({ parent: input.id, pageSize: 100 }, { autoPaginate: false, ...rpcOptions(this.rpcTimeoutMs, options) });
    for (const version of versions) {
      if (version.state !== 'ENABLED' && version.state !== 1) continue;
      const name = string(version.name), recovered = await this.access(name, options);
      if (recovered.operationId !== input.version) continue;
      if (digest(recovered.value) !== receipt.digest) throw new Error('secret_operation_conflict');
      await this.saveReceipt(async tx => {
        const latest = (await tx.get(reference)).data();
        if (!latest || latest.secret !== input.id || latest.operationId !== input.version || latest.digest !== receipt.digest || !['pending', 'ready'].includes(latest.phase)) throw new Error('secret_operation_conflict');
        if (latest.phase === 'ready' && latest.version !== name) throw new Error('secret_operation_conflict');
        tx.set(reference, { ...latest, phase: 'ready', version: name });
      });
      return recovered.value;
    }
    throw new SecretVersionUnavailableError('unknown');
  }
  async write(input: { id: string; operationId?: string; value: string }, options?: RuntimeOptions): Promise<void> {
    this.requireId(input.id); options?.abortSignal?.throwIfAborted();
    if (!input.operationId) throw new Error('secret_operation_required');
    const reference = this.operation(input.id, input.operationId), hash = digest(input.value), attempt = randomUUID();
    const created = await this.transaction(async tx => {
      const existing = (await tx.get(reference)).data();
      if (existing) {
        if (existing.secret !== input.id || existing.operationId !== input.operationId || existing.digest !== hash) throw new Error('secret_operation_conflict');
        if (!['prepared', 'rejected'].includes(existing.phase)) return false;
        if (existing.phase === 'rejected') requireRejectedReceipt(existing);
        else requirePreparedReceipt(existing);
        tx.set(reference, { secret: input.id, operationId: input.operationId, digest: hash, phase: 'prepared', attempt });
        return true;
      }
      tx.create(reference, { secret: input.id, operationId: input.operationId, digest: hash, phase: 'prepared', attempt });
      return true;
    }, options);
    if (!created) {
      const known = await this.read({ id: input.id, version: input.operationId }, options);
      if (known !== input.value) throw new Error('secret_operation_conflict');
      return;
    }
    let version;
    const client = await this.client.initialize();
    options?.abortSignal?.throwIfAborted();
    const restoreUnsent = () => this.saveReceipt(async tx => {
      const current = (await tx.get(reference)).data();
      if (!current || current.secret !== input.id || current.operationId !== input.operationId || current.digest !== hash || current.attempt !== attempt || current.version !== undefined || current.rejectionCode !== undefined) throw new Error('secret_operation_conflict');
      if (current.phase === 'prepared') { requirePreparedReceipt(current); return; }
      if (current.phase !== 'pending' || current.sendAttempt !== attempt) throw new Error('secret_operation_conflict');
      tx.set(reference, { secret: input.id, operationId: input.operationId, digest: hash, phase: 'prepared', attempt });
    });
    try {
      await this.transaction(async tx => {
        const current = (await tx.get(reference)).data();
        if (!current || current.secret !== input.id || current.operationId !== input.operationId || current.digest !== hash || current.phase !== 'prepared' || current.attempt !== attempt) throw new Error('secret_operation_conflict');
        tx.set(reference, { ...current, phase: 'pending', sendAttempt: attempt });
      }, options);
    } catch (error) {
      // This invocation has not called addSecretVersion, even if the pending commit response was lost.
      await restoreUnsent();
      throw error;
    }
    let callOptions;
    try { callOptions = rpcOptions(this.rpcTimeoutMs, options); }
    catch (error) { await restoreUnsent(); throw error; }
    try {
      [version] = await client.addSecretVersion({ parent: input.id, payload: { data: Buffer.from(JSON.stringify({ operationId: input.operationId, value: input.value })) } }, callOptions);
    } catch (error) {
      // Only definitive validation/permission/state rejection permits a later version creation.
      if (rejectedWrite(error)) await this.saveReceipt(async tx => {
        const current = (await tx.get(reference)).data();
        if (!current || current.secret !== input.id || current.operationId !== input.operationId || current.digest !== hash || current.phase !== 'pending' || current.attempt !== attempt || current.sendAttempt !== attempt) throw new Error('secret_operation_conflict');
        tx.set(reference, { ...current, phase: 'rejected', rejectionCode: error.code });
      });
      throw error;
    }
    // Persist a received version even when the caller's deadline has elapsed.
    if (!version.name?.startsWith(input.id + '/versions/')) throw new Error('secret_version_invalid');
    await this.saveReceipt(async tx => {
      const current = (await tx.get(reference)).data();
      if (!current || current.secret !== input.id || current.operationId !== input.operationId || current.digest !== hash || current.attempt !== attempt || current.sendAttempt !== attempt || current.phase === 'ready' && current.version !== version.name || current.phase !== 'ready' && current.phase !== 'pending') throw new Error('secret_operation_conflict');
      tx.set(reference, { ...current, phase: 'ready', version: string(version.name) });
    });
  }
}
export class GoogleJobQueue implements JobQueue {
  private client: GoogleClient<CloudTasksClient>;
  constructor(client: CloudTasksClient, private config: GoogleRuntimeConfig, private rpcTimeoutMs = 30_000, createClient = () => new CloudTasksClient()) {
    disableGooglePayloadLogging(); this.client = new GoogleClient(client, createClient);
  }
  async enqueue(input: { destination: string; body: string; delaySeconds?: number }, options?: RuntimeOptions): Promise<void> {
    options?.abortSignal?.throwIfAborted();
    const prefix = `projects/${this.config.project}/locations/${this.config.location}/queues/${this.config.environment}-`;
    if (![prefix + 'jobs', prefix + 'wiki', prefix + 'provision'].includes(input.destination) || Buffer.byteLength(input.body) > 900_000 || !Number.isSafeInteger(input.delaySeconds ?? 0) || (input.delaySeconds ?? 0) < 0 || (input.delaySeconds ?? 0) > 86400) throw new AppError('invalid_input');
    const client = await this.client.initialize();
    await client.createTask({ parent: input.destination, task: { scheduleTime: { seconds: Math.floor(Date.now() / 1000) + (input.delaySeconds ?? 0) }, dispatchDeadline: { seconds: 180 }, httpRequest: { httpMethod: 'POST', url: this.config.workerUrl + '/tasks', headers: { 'Content-Type': 'application/json' }, body: Buffer.from(input.body).toString('base64'), oidcToken: { serviceAccountEmail: this.config.taskAccount, audience: this.config.workerUrl } } } }, rpcOptions(this.rpcTimeoutMs, options));
  }
}
export class GoogleChildResources implements ChildResourceManager {
  private client: GoogleClient<SecretManagerServiceClient>;
  constructor(client: SecretManagerServiceClient | GoogleClient<SecretManagerServiceClient>, private secrets: SecretStore, private config: GoogleRuntimeConfig, private rpcTimeoutMs = 30_000) {
    disableGooglePayloadLogging(); this.client = client instanceof GoogleClient ? client : new GoogleClient(client, () => new SecretManagerServiceClient());
  }
  names(parent: string, secret: string, id: string): BotResources {
    const root = `projects/${this.config.projectNumber}/secrets/${this.config.environment}-runtime`;
    if (parent !== this.config.environment || secret !== root || !/^[a-f0-9]{32}$/.test(id)) throw new AppError('registration_boundary');
    const secretName = `${this.config.environment}-bot-${id}-runtime`;
    return { tableName: `${parent}-bot-${id}`, secretName, secretPrefix: `projects/${this.config.projectNumber}/secrets/${secretName}` };
  }
  validSecret(resources: BotResources, secret: string): boolean { return secret === resources.secretPrefix; }
  async ensure(registrations: Registrations, entry: Registration): Promise<string> {
    const target = this.names(registrations.parentTable, registrations.parentSecret, entry.id), labels = { roughmate_environment: this.config.environment, registration_id: entry.id };
    const client = await this.client.initialize();
    try { await client.createSecret({ parent: `projects/${this.config.project}`, secretId: target.secretName, secret: { replication: { userManaged: { replicas: [{ location: this.config.location }] } }, labels } }, rpcOptions(this.rpcTimeoutMs)); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 6) throw error; }
    const [existing] = await client.getSecret({ name: target.secretPrefix }, rpcOptions(this.rpcTimeoutMs));
    if (existing.name !== target.secretPrefix || !Object.entries(labels).every(([key, value]) => existing.labels?.[key] === value)) throw new AppError('registration_boundary');
    const root = await registrations.root.readSecrets();
    await this.secrets.write({ id: target.secretPrefix, operationId: `bootstrap-${entry.id}`, value: JSON.stringify({ apiKey: root.apiKey, model: root.model }) });
    return target.secretPrefix;
  }
}
export function googleRuntime(config: GoogleRuntimeConfig, rpcTimeoutMs = 30_000): Runtime {
  if (process.env.FIRESTORE_EMULATOR_HOST && !config.project.startsWith('demo-')) throw new Error('google_emulator_boundary');
  if (!/^roughmate-[a-z][a-z0-9-]{0,9}$/.test(config.environment) || config.environment.includes('-bot') || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project)) throw new Error('google_runtime_config_invalid');
  const db = createGoogleFirestore(config.project, config.database, rpcTimeoutMs), client = new GoogleClient(new SecretManagerServiceClient(), () => new SecretManagerServiceClient()), tasks = new CloudTasksClient();
  const secrets = new GoogleSecretStore(client, db, config, rpcTimeoutMs), queue = new GoogleJobQueue(tasks, config, rpcTimeoutMs);
  return { documents: () => new FirestoreDocumentStore(db, config.environment, rpcTimeoutMs), secrets: () => secrets, queue: () => queue, children: new GoogleChildResources(client, secrets, config, rpcTimeoutMs) };
}
