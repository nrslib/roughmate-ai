import { requireRootTableHistory, validateSavedRootHistory, bindPurgeRootOwner } from './root-history.js';
import { AppError } from '../../app/src/contracts.js';
import { SetupAws } from './aws.js';
import { location, validateTarget, type Target } from './config.js';
import type { SetupInteraction } from './slack-setup.js';
import { Terraform } from './terraform.js';
import { discoverPurge } from './purge-discovery.js';
import { PurgeAwsCli } from './purge-inventory.js';
import { PurgeJournal } from './purge-journal.js';
import type { PurgePlan, ResourceKind } from './purge-model.js';
import { purgeSlack } from './purge-slack.js';
import { deletePurgeResource, drainPurge, remainingPurgeResources, requireFrozenInventory, stopPurge } from './purge-execution.js';
import { validatePurgeState } from './purge-terraform.js';
import { EnvironmentLease } from './environment-lease.js';

function showPlan(plan: PurgePlan): void {
  process.stdout.write(`削除計画 ${plan.id}: 段階=${plan.stage}\nSlack App: ${plan.apps.map(app => app.appId).join(', ')}\n`);
  for (const resource of plan.resources) process.stdout.write(`${resource.kind}: ${resource.id}\n`);
  process.stdout.write(`state履歴: environments/${plan.target.environment}/ の全version/delete marker（保護された再開anchorを最後に消去）\n共有bucket・他環境・管理者principal/global管理policy・Slackチャンネル/投稿は保持します。\n`);
}
export async function purgeEnvironment(target: Target, dryRun: boolean, terraformBinary: string, interaction: SetupInteraction): Promise<void> {
  validateTarget(target);
  process.stdout.write(`対象: AWS ${target.accountId} / ${target.region} / ${target.environment}\nRoot/全子BotのSlack App、AWS専用資源・保存データ・管理記録/state履歴を不可逆に削除します。\n`);
  if (!dryRun && await interaction.input({ message: `対象確認のため ${target.accountId}/${target.region}/${target.environment} を入力:` }) !== `${target.accountId}/${target.region}/${target.environment}`) throw new AppError('target_mismatch');
  if (await SetupAws.account(target.region) !== target.accountId) throw new AppError('target_mismatch');
  const aws = new SetupAws(target), cli = new PurgeAwsCli(target);
  const identity = await cli.call('sts','get-caller-identity',{});
  await cli.authorizeAdmin(identity);
  await aws.verifyStateBucket();
  const bucketInput = {Bucket:location(target).bucket,ExpectedBucketOwner:target.accountId};
  const bucketRegion = (await cli.call('s3api','get-bucket-location',bucketInput)).LocationConstraint;
  if ((bucketRegion === null ? 'us-east-1' : bucketRegion === 'EU' ? 'eu-west-1' : bucketRegion) !== target.region) throw new AppError('purge_ownership');
  const versioning = await cli.call('s3api','get-bucket-versioning',bucketInput);
  if (versioning.MFADelete === 'Enabled') throw new AppError('purge_retained_resource');
  const lock = await cli.optional('s3api','get-object-lock-configuration',bucketInput,['ObjectLockConfigurationNotFoundError']);
  if (lock) throw new AppError('purge_retained_resource');
  const replication = await cli.optional('s3api','get-bucket-replication',bucketInput,['ReplicationConfigurationNotFoundError']);
  if (replication) throw new AppError('purge_retained_resource');
  const lease = dryRun ? undefined : new EnvironmentLease(aws,'purge');
  await lease?.acquire();
  const execute = async () => {
    const journal = await PurgeJournal.read(aws,lease);
    let plan = journal.existing ?? await discoverPurge(aws,cli);
    if (journal.existing) await validateSavedRootHistory(aws,cli,plan);
    else await requireRootTableHistory(aws,plan.rootHistory,true,cli);
    await validatePurgeState(aws,plan,cli);
    showPlan(plan);
    if (dryRun) {
      requireFrozenInventory(plan,await cli.inventory());
      process.stdout.write('プレビューのみです。保存・停止・token更新・削除を行っていません。Slack不存在は実行時に照合します。\n');
      return;
    }
    if (!journal.existing) await bindPurgeRootOwner(aws,plan.rootHistory,plan.ownerId,plan.teamId);
    plan = await journal.acquire(plan);
    let complete = false;
    try {
      if (plan.stage === 'planned') plan = await stopPurge(aws,cli,journal,plan);
      if (plan.stage === 'stopped') {
        plan = await drainPurge(journal,plan);
        const stable = await discoverPurge(aws,cli);
        if (stable.ownerId !== plan.ownerId || stable.teamId !== plan.teamId || JSON.stringify(stable.descriptor) !== JSON.stringify(plan.descriptor) || plan.apps.some(app => !stable.apps.some(current => JSON.stringify(current) === JSON.stringify(app)))) throw new AppError('purge_inventory_changed');
        // In-flight provisioning may finish during drain; freeze its proven resources before deleting Slack apps.
        await journal.saveAnchor({...plan,apps:stable.apps,resources:stable.resources},'slack');
        plan = await journal.save({ ...plan, apps: stable.apps, resources: stable.resources, stage: 'slack' });
      }
      plan = await journal.save(plan);
      plan = await purgeSlack(plan,interaction,plan.stage === 'slack',journal);
      if(plan.stage!=='history')await journal.saveAnchor(plan,'verified');
      plan = await journal.save({ ...plan, stage: plan.stage === 'history' ? 'history' : 'aws' });
      if (plan.stage === 'aws') {
        requireFrozenInventory(plan,await cli.inventory());
        // Remove child storage/backups before Terraform destroys the root registry and runtime/configuration secrets.
        for (const resource of plan.resources.filter(item => item.registrationId || item.kind === 'backup')) {
          plan = await journal.save(plan); await deletePurgeResource(cli,resource,{async touch(){plan=await journal.save(plan);}},plan.descriptor);
        }
        plan = await journal.save(plan);
        if (await validatePurgeState(aws,plan,cli)) { plan=await journal.save(plan); requireFrozenInventory(plan,await remainingPurgeResources(cli,plan)); await new Terraform(terraformBinary,target).purge(); }
        const order: ResourceKind[] = ['schedule-group','api','mapping','function','queue','log','table','secret','role','policy','backup'];
        for (const kind of order) for (const resource of plan.resources.filter(item => item.kind === kind && !item.registrationId && item.kind !== 'backup')) {
          plan = await journal.save(plan);
          requireFrozenInventory(plan,await cli.inventory());
          await deletePurgeResource(cli,resource,{async touch(){plan=await journal.save(plan);}},plan.descriptor);
        }
        let remaining = await remainingPurgeResources(cli,plan);
        for (let attempt = 0; remaining.length && attempt < 12; attempt++) {
          requireFrozenInventory(plan,remaining);
          plan = await journal.save(plan);
          process.stdout.write('AWSの非同期削除完了を照合しています。\n');
          await new Promise(resolve => setTimeout(resolve,5_000)); remaining = await remainingPurgeResources(cli,plan);
        }
        if (remaining.length) throw new AppError('purge_aws_pending');
        plan = await journal.save({ ...plan, stage: 'history' });
      }
      const remaining = await remainingPurgeResources(cli,plan);
      requireFrozenInventory(plan,remaining);
      if (remaining.length) throw new AppError('purge_aws_pending');
      await journal.eraseHistory(plan);
      complete = true;
      process.stdout.write('全対象Slack Appの不存在、当環境AWS資源とS3管理履歴の消去を確認しました。AWS/Slack内部保持・外部バックアップの物理消去は保証範囲外です。\n');
    } finally {
      if (!complete) {
        // CAS failure must leave another owner's journal untouched; the original failure remains visible.
        try { await journal.release(plan); } catch { process.stderr.write('計画leaseを解放できませんでした。15分以上待ち、同じコマンドを再実行してください。\n'); }
      }
    }
  };
  let failure: unknown, failed = false;
  try { if (lease) await lease.run(execute); else await execute(); }
  catch (error) { failure = error; failed = true; }
  try { await lease?.release(); }
  catch (error) {
    if (!failed) { failure = error; failed = true; }
    else process.stderr.write('環境leaseを解放できませんでした。記録を再作成せず停止しました。同じ対象と旧プロセスの終了を確認して再実行してください。\n');
  }
  if (failed) throw failure;
}
