import { environmentSignal } from './environment-lease.js';
import { anchorKey, reconcileAnchor, validateAnchor, type PurgeAnchor } from './purge-anchor.js';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand, type ObjectIdentifier } from '@aws-sdk/client-s3';
import { AppError, string } from '../../app/src/contracts.js';
import type { SetupAws } from './aws.js';
import { location } from './config.js';
import { validatePlan, type PurgePlan } from './purge-model.js';
import type { EnvironmentLease } from './environment-lease.js';
export function purgeKey(aws: SetupAws): string { return `environments/${aws.target.environment}/protected-purge/plan.json`; }
export async function readStateJson(aws: SetupAws, key: string): Promise<{
  value: unknown;
  etag: string;
  versionId: string;
} | undefined> {
  try {
    const result = await aws.s3.send(new GetObjectCommand({ Bucket: location(aws.target).bucket, Key: key, ExpectedBucketOwner: aws.target.accountId }), { abortSignal: environmentSignal() });
    return { value: JSON.parse(string(await result.Body?.transformToString())), etag: string(result.ETag), versionId: string(result.VersionId) };
  }
  catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey')
      return undefined;
    if (error instanceof Error && error.name === 'NoSuchBucket')
      throw new AppError('aws_not_deployed');
    throw new AppError('purge_state_unavailable');
  }
}
export async function requireNoPurge(aws: SetupAws): Promise<void> {
  try {
    if (await readStateJson(aws, purgeKey(aws)) || await readStateJson(aws, anchorKey(aws)))
      throw new AppError('purge_pending');
  }
  catch (error) {
    if (error instanceof AppError && error.code === 'aws_not_deployed')
      return;
    throw error;
  }
}
export class PurgeJournal {
  private etag?: string;
  private versionId?: string;
  private anchorEtag?: string;
  private anchorVersionId?: string;
  private anchor?: PurgeAnchor;
  private owner = randomUUID();
  constructor(private aws: SetupAws, readonly existing?: PurgePlan, private existingEtag?: string, private lease?: EnvironmentLease) { }
  static async read(aws: SetupAws, lease?: EnvironmentLease): Promise<PurgeJournal> {
    const saved = await readStateJson(aws, purgeKey(aws)), proof = await readStateJson(aws, anchorKey(aws));
    const anchor = proof ? validateAnchor(proof.value, aws.target) : undefined;
    if (saved && !anchor)
      throw new AppError('purge_journal');
    const existing = saved ? reconcileAnchor(validatePlan(saved.value, aws.target), anchor!) : anchor ? { ...anchor.plan, leaseUntil: 0 } : undefined;
    const journal = new PurgeJournal(aws, existing, saved?.etag, lease);
    journal.anchor = anchor;
    journal.anchorEtag = proof?.etag;
    journal.anchorVersionId = proof?.versionId;
    return journal;
  }
  async saveAnchor(plan: PurgePlan, phase: PurgeAnchor['phase']): Promise<void> {
    await this.lease?.touch();
    const stage = ({ planned: 'planned', slack: 'slack', verified: 'aws', history: 'history' } as const)[phase];
    const next = validateAnchor({ schemaVersion: 1, application: 'roughmate-purge-anchor', phase, plan: { ...plan, stage } }, this.aws.target);
    try {
      const result = await this.aws.s3.send(new PutObjectCommand({ Bucket: location(this.aws.target).bucket, Key: anchorKey(this.aws), ExpectedBucketOwner: this.aws.target.accountId, Body: JSON.stringify(next), ContentType: 'application/json', ServerSideEncryption: 'AES256', ...(this.anchorEtag ? { IfMatch: this.anchorEtag } : { IfNoneMatch: '*' }) }), { abortSignal: environmentSignal() });
      this.anchor = next;
      this.anchorEtag = string(result.ETag);
      this.anchorVersionId = string(result.VersionId);
    }
    catch (error) {
      if (error instanceof Error && ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error.name))
        throw new AppError('purge_busy');
      throw new AppError('purge_state_unavailable');
    }
  }
  async acquire(plan: PurgePlan): Promise<PurgePlan> {
    if (this.existing && this.existing.leaseUntil > Date.now())
      throw new AppError('purge_busy');
    this.etag = this.existingEtag;
    if (!this.anchor)
      await this.saveAnchor(plan, 'planned');
    return this.save({ ...plan, leaseOwner: this.owner, leaseUntil: Date.now() + 15 * 60000 });
  }
  async save(plan: PurgePlan): Promise<PurgePlan> {
    await this.lease?.touch();
    if (plan.leaseOwner !== this.owner || this.etag && plan.leaseUntil <= Date.now())
      throw new AppError('purge_busy');
    const next = validatePlan({ ...plan, leaseUntil: Date.now() + 15 * 60000 }, this.aws.target);
    try {
      const result = await this.aws.s3.send(new PutObjectCommand({ Bucket: location(this.aws.target).bucket, Key: purgeKey(this.aws), ExpectedBucketOwner: this.aws.target.accountId, Body: JSON.stringify(next), ContentType: 'application/json', ServerSideEncryption: 'AES256', ...(this.etag ? { IfMatch: this.etag } : { IfNoneMatch: '*' }) }), { abortSignal: environmentSignal() });
      this.etag = string(result.ETag);
      this.versionId = string(result.VersionId);
      return next;
    }
    catch (error) {
      if (error instanceof Error && ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error.name))
        throw new AppError('purge_busy');
      throw error;
    }
  }
  async release(plan: PurgePlan): Promise<void> {
    if (this.lease?.signal.aborted || plan.leaseOwner !== this.owner || !this.etag)
      return;
    try {
      await this.aws.s3.send(new PutObjectCommand({ Bucket: location(this.aws.target).bucket, Key: purgeKey(this.aws), ExpectedBucketOwner: this.aws.target.accountId, Body: JSON.stringify({ ...plan, leaseUntil: 0 }), ContentType: 'application/json', ServerSideEncryption: 'AES256', IfMatch: this.etag }), { abortSignal: environmentSignal() });
    }
    catch (error) {
      // During final erasure the protected anchor carries the same recovery plan after plan.json is gone.
      if (!await readStateJson(this.aws, purgeKey(this.aws)) && this.anchor?.phase === 'history' && this.anchor.plan.leaseOwner === this.owner && this.anchorEtag) {
        const next = { ...this.anchor, plan: { ...this.anchor.plan, leaseUntil: 0 } };
        await this.aws.s3.send(new PutObjectCommand({ Bucket: location(this.aws.target).bucket, Key: anchorKey(this.aws), ExpectedBucketOwner: this.aws.target.accountId, Body: JSON.stringify(next), ContentType: 'application/json', ServerSideEncryption: 'AES256', IfMatch: this.anchorEtag }), { abortSignal: environmentSignal() });
        return;
      }
      throw error;
    }
  }
  async eraseHistory(plan: PurgePlan): Promise<void> {
    if (plan.stage !== 'history')
      throw new AppError('purge_journal');
    const bucket = location(this.aws.target).bucket, prefix = `environments/${this.aws.target.environment}/`;
    const versions = async (): Promise<ObjectIdentifier[]> => {
      let keyMarker: string | undefined, versionMarker: string | undefined;
      const found: ObjectIdentifier[] = [], cursors = new Set<string>();
      let more = true;
      while (more) {
        const page = await this.aws.s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, ExpectedBucketOwner: this.aws.target.accountId, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: environmentSignal() });
        for (const version of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (!version.Key?.startsWith(prefix) || !version.VersionId)
            throw new AppError('purge_history');
          found.push({ Key: version.Key, VersionId: version.VersionId });
        }
        more = page.IsTruncated === true;
        if (!more)
          break;
        if (!page.NextKeyMarker || cursors.has(`${page.NextKeyMarker}:${page.NextVersionIdMarker}`))
          throw new AppError('purge_history');
        keyMarker = page.NextKeyMarker;
        versionMarker = page.NextVersionIdMarker;
        cursors.add(`${keyMarker}:${versionMarker}`);
      }
      return found;
    };
    const remove = async (items: ObjectIdentifier[]) => {
      for (let offset = 0; offset < items.length; offset += 1000) {
        // This keeps the only recovery record alive through every other history deletion.
        if (plan.leaseUntil <= Date.now())
          throw new AppError('purge_busy');
        if (this.lease && !items.some(item => (item.Key === purgeKey(this.aws) && item.VersionId === this.versionId) || (item.Key === anchorKey(this.aws) && item.VersionId === this.anchorVersionId)))
          await this.lease.assertOwned();
        try {
          const result = await this.aws.s3.send(new DeleteObjectsCommand({ Bucket: bucket, ExpectedBucketOwner: this.aws.target.accountId, Delete: { Objects: items.slice(offset, offset + 1000), Quiet: true } }), { abortSignal: environmentSignal() });
          if (result.Errors?.length)
            throw new AppError('purge_history');
        }
        catch {
          throw new AppError('purge_history');
        }
      }
    };
    plan = await this.save(plan);
    await this.saveAnchor(plan, 'history');
    await this.lease?.prepareHistoryErase();
    const leaseRecord = this.lease?.historyRecord();
    const keep = (item: ObjectIdentifier) => item.Key === purgeKey(this.aws) && item.VersionId === this.versionId;
    const keepAnchor = (item: ObjectIdentifier) => item.Key === anchorKey(this.aws) && item.VersionId === this.anchorVersionId;
    const keepLease = (item: ObjectIdentifier) => item.Key === leaseRecord?.key && item.VersionId === leaseRecord?.versionId;
    await remove((await versions()).filter(item => !keep(item) && !keepLease(item) && !keepAnchor(item)));
    const remaining = await versions();
    if (remaining.length !== (leaseRecord ? 3 : 2) || !remaining.some(keep) || !remaining.some(keepAnchor) || leaseRecord && !remaining.some(keepLease))
      throw new AppError('purge_history');
    await remove(remaining.filter(keepLease));
    await remove(remaining.filter(keep));
    await remove(remaining.filter(keepAnchor));
    this.lease?.markErased();
    if ((await versions()).length)
      throw new AppError('purge_history');
  }
}
