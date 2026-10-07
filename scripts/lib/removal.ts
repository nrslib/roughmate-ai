import { preservePurgeEvidence, requirePurgeEvidenceForRemoval } from './purge-evidence.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { AppError } from '../../app/src/contracts.js';
import type { SetupAws } from './aws.js';
import { validateRemovalRecord, type Descriptor, type RemovalRecord } from './config.js';
import { deleteDedicatedSlackApp, deleteSlack, type SetupInteraction } from './slack-setup.js';
import type { Terraform } from './terraform.js';
import { stopRegistrationForRemoval } from './registration-setup.js';

async function prepareRemoval(aws: SetupAws, descriptor: Descriptor, preserveEvidence: boolean): Promise<RemovalRecord> {
  const progress = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }))).Item;
  if (progress?.phase === 'creating') throw new AppError('slack_creation_ambiguous');
  const secrets = progress?.phase === 'deleted' ? undefined : await aws.readSecrets(descriptor);
  if (progress?.appId && secrets && progress.appId !== secrets.appId) throw new AppError('slack_target_mismatch');
  if (progress && !secrets && progress.phase !== 'deleted') throw new AppError('slack_app_unavailable');
  if (preserveEvidence) await preservePurgeEvidence(aws,descriptor);
  await stopRegistrationForRemoval(aws, descriptor, secrets?.appId ?? progress?.appId);
  const appId = progress?.phase === 'deleted' ? progress.appId : secrets?.appId;
  const record = validateRemovalRecord({ ...aws.target, schemaVersion: 1, application: 'roughmate-self-hosted', publicUrl: descriptor.publicUrl, ...(appId ? { appId } : {}), slackStatus: appId ? progress?.phase === 'deleted' ? 'deleted' : 'present' : 'not-created', awsStatus: 'destroying' }, aws.target);
  await aws.saveRemoval(record);
  return record;
}
export async function removeSlack(aws: SetupAws, interaction: SetupInteraction, preserveEvidence = false): Promise<void> {
  const record = await aws.removal();
  if(record&&preserveEvidence)await requirePurgeEvidenceForRemoval(aws,record);
  if (!record) { await deleteSlack(aws, await aws.descriptor(), interaction,preserveEvidence); return; }
  if (record.slackStatus !== 'present') { process.stdout.write('この環境の Slack アプリは削除済み、または未作成です。\n'); return; }
  if (!record.appId) throw new AppError('invalid_removal_record');
  await deleteDedicatedSlackApp(record.appId, record, interaction);
  await aws.saveRemoval({ ...record, slackStatus: 'deleted' });
}
export async function destroyAws(aws: SetupAws, terraform: Terraform, interaction: SetupInteraction, preserveEvidence = false): Promise<void> {
  let record = await aws.removal();
  if(record&&preserveEvidence)await requirePurgeEvidenceForRemoval(aws,record);
  if (record?.awsStatus === 'destroyed') {
    await aws.removeDescriptor();
    process.stdout.write('この環境の AWS リソースは削除済みです。\n');
    return;
  }
  const descriptor = record ? undefined : await aws.descriptor();
  const { accountId, region, environment } = aws.target;
  if (!await interaction.confirm({ message: `AWS ${accountId}/${region}/${environment} のRoughmateリソース（秘密・相談DB・キュー含む）を削除します。続行しますか？`, default: false })) throw new AppError('cancelled');
  if (await interaction.input({ message: `対象確認のため ${accountId}/${environment} を入力:` }) !== `${accountId}/${environment}`) throw new AppError('target_mismatch');
  if (!record) {
    if (!descriptor) throw new AppError('aws_not_deployed');
    record = await prepareRemoval(aws, descriptor,preserveEvidence);
  }
  // 削除開始時点で非稼働扱いにし、以降は removal.json と Terraform state で再開する。
  await aws.removeDescriptor();
  await terraform.init();
  await terraform.apply(true);
  await aws.saveRemoval({ ...record, awsStatus: 'destroyed' });
  process.stdout.write('AWSリソースを削除しました。state用S3バケット・state履歴・非秘密のSlack削除記録は保持しています。\n');
}
export async function prepareDeploy(aws: SetupAws): Promise<void> {
  const record = await aws.removal();
  if (!record) return;
  if (record.awsStatus !== 'destroyed') throw new AppError('aws_removal_pending');
  if (record.slackStatus === 'present') throw new AppError('slack_removal_pending');
  // 旧アプリの後始末が済んだ環境だけ、新しい導入へ移れる。
  await aws.removeRemoval();
}
