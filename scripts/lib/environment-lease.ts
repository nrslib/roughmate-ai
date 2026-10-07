import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { AppError, object, string } from '../../app/src/contracts.js';
import type { SetupAws } from './aws.js';
import { location } from './config.js';
import { anchorKey } from './purge-anchor.js';
import { purgeKey, readStateJson } from './purge-journal.js';
const duration = 15 * 60000;
const context = new AsyncLocalStorage<EnvironmentLease>();
export function environmentLeaseKey(aws: SetupAws): string { return `environments/${aws.target.environment}/operation.json`; }
export async function environmentFence(): Promise<void> { await context.getStore()?.touch(); }
export function environmentSignal(): AbortSignal | undefined { return context.getStore()?.signal; }
export function fenced<T extends object>(instance: T): T {
  return new Proxy(instance, { get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function')
        return value;
      if (value.constructor.name === 'AsyncFunction')
        return async (...args: unknown[]) => { await environmentFence(); return Reflect.apply(value, receiver, args); };
      return (...args: unknown[]) => { context.getStore()?.signal.throwIfAborted(); return Reflect.apply(value, receiver, args); };
    } });
}
export async function requireNoBackendLock(aws: SetupAws): Promise<void> {
  if (await readStateJson(aws, `${location(aws.target).stateKey}.tflock`))
    throw new AppError('environment_backend_locked');
}
// One lease spans the entire CLI operation, including prompts and Terraform subprocesses.
export class EnvironmentLease {
  private owner = randomUUID();
  private etag?: string;
  private versionId?: string;
  private until = 0;
  private serial: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private finished = false;
  readonly signal = this.controller.signal;
  constructor(readonly aws: SetupAws, private mode: 'normal' | 'purge') { }
  async acquire(): Promise<void> {
    const purge = await readStateJson(this.aws, purgeKey(this.aws));
    const anchor = await readStateJson(this.aws, anchorKey(this.aws));
    if (this.mode === 'normal' && anchor)
      throw new AppError('purge_pending');
    if (this.mode === 'purge' && !purge && anchor && Number(object(object(anchor.value).plan).leaseUntil) > Date.now())
      throw new AppError('purge_busy');
    if (purge && this.mode === 'normal')
      throw new AppError('purge_pending');
    if (purge && Number(object(purge.value).leaseUntil) > Date.now())
      throw new AppError('purge_busy');
    await requireNoBackendLock(this.aws);
    const saved = await readStateJson(this.aws, environmentLeaseKey(this.aws));
    if (saved) {
      const value = object(saved.value), target = object(value.target);
      if (Object.keys(value).sort().join(',') !== 'application,leaseOwner,leaseUntil,mode,target' || value.application !== 'roughmate-environment-operation' || Object.keys(target).sort().join(',') !== 'accountId,environment,region' || target.accountId !== this.aws.target.accountId || target.region !== this.aws.target.region || target.environment !== this.aws.target.environment || !['normal', 'purge'].includes(string(value.mode)) || !/^[a-f0-9-]{36}$/.test(string(value.leaseOwner)) || !Number.isSafeInteger(value.leaseUntil))
        throw new AppError('environment_lease_invalid');
      if (Number(value.leaseUntil) > Date.now())
        throw new AppError('environment_busy');
      this.etag = saved.etag;
    }
    await this.write(Date.now() + duration);
    try {
      // Check under the lease: a previous GET is never an authorization to mutate.
      if (this.mode === 'normal' && (await readStateJson(this.aws, purgeKey(this.aws)) || await readStateJson(this.aws, anchorKey(this.aws))))
        throw new AppError('purge_pending');
    }
    catch (error) {
      await this.release();
      throw error;
    }
    this.timer = setInterval(() => { void this.touch(false).catch(() => { }); }, 30000);
    this.timer.unref();
  }
  async run<T>(work: () => Promise<T>): Promise<T> { return context.run(this, work); }
  private async write(until: number): Promise<void> {
    try {
      const result = await this.aws.s3.send(new PutObjectCommand({ Bucket: location(this.aws.target).bucket, Key: environmentLeaseKey(this.aws), ExpectedBucketOwner: this.aws.target.accountId, Body: JSON.stringify({ application: 'roughmate-environment-operation', target: this.aws.target, mode: this.mode, leaseOwner: this.owner, leaseUntil: until }), ContentType: 'application/json', ServerSideEncryption: 'AES256', ...(this.etag ? { IfMatch: this.etag } : { IfNoneMatch: '*' }) }), {abortSignal:this.signal});
      this.etag = string(result.ETag);
      this.versionId = string(result.VersionId);
      this.until = until;
    }
    catch {
      this.controller.abort(new AppError('environment_lease_lost'));
      throw new AppError('environment_lease_lost');
    }
  }
  async touch(backend = true): Promise<void> {
    const next = this.serial.then(async () => {
      if (this.signal.aborted || this.finished || this.until <= Date.now()) {
        this.controller.abort(new AppError('environment_lease_lost'));
        throw new AppError('environment_lease_lost');
      }
      if (this.mode === 'normal' && (await readStateJson(this.aws, purgeKey(this.aws)) || await readStateJson(this.aws, anchorKey(this.aws)))) {
        this.controller.abort(new AppError('purge_pending'));
        throw new AppError('purge_pending');
      }
      await this.write(Date.now() + duration);
      if (backend) {
        try {
          await requireNoBackendLock(this.aws);
        }
        catch (error) {
          this.controller.abort(error);
          throw error;
        }
      }
    });
    this.serial = next.catch(() => { });
    return next;
  }
  async release(): Promise<void> {
    this.stopHeartbeat();
    await this.serial;
    if (this.finished || this.signal.aborted || !this.etag)
      return;
    await this.write(0);
    this.finished = true;
  }
  stopHeartbeat(): void { if (this.timer)
    clearInterval(this.timer); this.timer = undefined; }
  async prepareHistoryErase(): Promise<void> {
    this.stopHeartbeat();
    await this.serial;
    await this.touch();
  }
  historyRecord(): {
    key: string;
    versionId: string;
  } { return { key: environmentLeaseKey(this.aws), versionId: string(this.versionId) }; }
  async assertOwned(): Promise<void> {
    if (this.signal.aborted || this.until <= Date.now())
      throw new AppError('environment_lease_lost');
    const saved = await readStateJson(this.aws, environmentLeaseKey(this.aws));
    if (!saved || saved.etag !== this.etag)
      throw new AppError('environment_lease_lost');
  }
  markErased(): void { this.finished = true; this.stopHeartbeat(); }
}
