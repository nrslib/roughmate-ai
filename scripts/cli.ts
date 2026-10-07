import {beginRootHistory,bindRootHistory} from './lib/root-history.js';
import type {RootHistory} from './lib/root-history-model.js';
import { PurgeAwsCli } from './lib/purge-inventory.js';
import { purgeEnvironment } from './lib/purge.js';
import { EnvironmentLease, environmentFence } from './lib/environment-lease.js';
import { requireNoPurge } from './lib/purge-journal.js';
import { parseArgs } from 'node:util';
import { input, confirm, password } from '@inquirer/prompts';
import { fileURLToPath } from 'node:url';
import { AppError, string } from '../app/src/contracts.js';
import { validateName, validateDescription } from '../app/src/groups.js';
import { SetupAws } from './lib/aws.js';
import { validateRegion, validateTarget, validateDescriptor } from './lib/config.js';
import { Terraform } from './lib/terraform.js';
import { setupSlack } from './lib/slack-setup.js';
import { destroyAws, removeSlack, prepareDeploy } from './lib/removal.js';
import { manageGroup } from './lib/group-management.js';
import { setupDiagnosticCode } from './lib/setup-diagnostics.js';
import { connectRegistration, recoverRegistration, restartRegistrationOAuth, resumeFailedRegistration } from './lib/registration-setup.js';
const actions = ['purge-env','connect-registration','recover-registration','bootstrap-state','deploy-aws','setup-slack','install','remove-slack','destroy-aws','uninstall','migrate-config','show-config','configure','knowledge-put','knowledge-list','knowledge-delete'];
const recoveryHelp = 'recover-registration --id ID --restart-oauth --recover-app-id A...: 未保存OAuth結果を同じ子appの新承認で復旧（管理者専用）\nrecover-registration --id ID --resume-failed: 確定failedの作成前/既存appを照合し、同じIDの再確認を許可\n';
const help = `Roughmateを作る → 知識を登録 → 受付・対応先・任意通知を設定\n使い方: ./scripts/<command> [--region AWS_REGION] [--env ENV] [--terraform PATH]\ncommands: ${actions.join(', ')}\nconnect-registration: 初回接続・保存済み接続の復旧。--reconnect は新Refreshによる明示再接続\nrecover-registration: 結果不明な子appを --id 登録ID --recover-app-id A... で照合復旧（管理者専用）\nbootstrap-state: 管理者専用。共有stateバケットを初回作成・保護設定（全環境へ影響）\n--name NAME --description TEXT: Roughmateの名前・所属説明（35文字/500文字まで）\n--actor U...: 管理操作の担当Slackユーザー（AWS principalも対象環境の管理者に制限）\n--file PATH: configure / knowledge-put のJSONファイル\nconfigure: name / description / adminIds の変更。受付・対応先・任意通知はSlack Homeで設定\n--id ID: knowledge-delete の資料ID\n--preserve-purge-evidence: 管理者installで未使用環境のRoot履歴を開始。remove-slack/destroy-aws/uninstallでは削除前の保護所有証跡を必須保存\n--reinstall: 既存Slackアプリを再OAuth承認\n--recover-app-id A...: 作成結果が不明な既存アプリを復旧（秘密は非表示入力）\npurge-env: --account 12桁 --region REGION --env ENV [--dry-run]。管理者AWS認証で全子Bot/履歴まで不可逆削除。最初に対象を再入力。再実行は同じ計画を継続します。\nAWS認証は標準SDKチェーン（AWS_PROFILE/SSO/環境等）を使います。\n`;
const messages: Record<string,string> = {
  environment_busy: '別の環境変更CLIが処理中です。終了を待って再実行してください。',
  environment_lease_lost: '環境leaseの所有権を確認できません。変更を停止しました。旧プロセスの終了とTerraform backend lockを確認し、15分以上待って再実行してください。',
  environment_backend_locked: 'Terraform backend lockが残っています。実行中のTerraformの終了とlock所有者を確認してください。変更は開始していません。',
  purge_pending: '環境の完全削除計画が残っています。新しい操作を停止しました。同じpurge-envコマンドを管理者認証で再実行してください。',
  purge_protection_required: '通常運用の生成IAM policyがprotected-purgeへの書込/削除を許可しています。最新generatorの必要key限定policyへ管理者が更新してから再実行してください。停止・計画保存・削除は開始していません。',
  purge_journal: '保護された計画と所有anchorのApp一覧・所有者・段階が整合しません。削除を開始せず、管理者が保存versionの来歴を確認してください。',
  purge_busy: '別プロセスが完全削除計画を処理中です。中断後は15分以上待ち、同じコマンドを再実行してください。',
  purge_creation_unknown: '子Slack Appの作成結果が不明です。保存されたcreateOwner世代とApp管理画面を照合し、対象App ID/所有者を復旧してください。AWS保存データは消去していません。',
  purge_orphan_unknown: '非管理の子資源を検出しましたがSlack Appの所有証明が不足しています。runtime secret/子group/旧registryの同一RegistrationIdを照合復旧して再実行してください。推測で消去しません。',
  purge_owner_missing: 'Root owner/workspaceの照合記録がありません。Slackの対象/所有記録を復旧して再実行してください。',
  purge_retained_backup: 'PITR/SYSTEM/AWS Backupの保持データを検出しました。READMEの物理保持限界を確認し、管理者が復旧設定/バックアップを整理してから再実行してください。',
  purge_shared_policy: '対象IAM資源に共有利用/別principal/instance profileがあり、削除を停止しました。無関係なprincipalは変更していません。',
  purge_aws_pending: 'AWS資源は削除応答後も存在します。計画は保持しています。待機後に新しい認証で同じコマンドを再実行してください。',
  purge_terraform_scope: 'Terraform stateに所有範囲を証明できない資源があります。消去を停止しました。',
  purge_inventory_changed: '計画外の環境資源/登録変更を検出しました。消去を停止しました。再配備を停止し、保存済み計画と所有証明を照合してください。',
  purge_ownership: '削除対象の名前・タグ・account/region・Slack markerが一致しません。消去を停止しました。',
  purge_terraform_workspace: 'default以外のworkspaceまたは不明なstate保存先の履歴があります。資源を残したまま履歴を消さないため、停止・削除を開始していません。READMEの対象境界を確認してください。',
  purge_root_history: 'Root App全世代の継続証明がありません。旧環境/新tableを完全履歴と推測せず停止しました。READMEの管理者初回installと保護証跡の条件を確認してください。',
  purge_evidence_missing: '対象のsetup/Root/Slack所有証明がありません。Root消失後は保存purge計画、またはuninstall前のowner/team所有証跡と対応する削除記録が必要です。旧形式で証跡が不足する場合は管理者が保持履歴とAppを照合復旧してください。',
  purge_evidence_save: '削除前の所有証跡を保存できません。管理者認証で対象Root tableのScanと当環境protected-purgeの書込権限を確認してください。普通SetupAccessには付与しません。停止・Slack/AWS削除は開始していません。',
  purge_admin_required: '境界のない管理者IAM user/roleが必要です。caller ID、無条件の全Action/Resource許可とIAM simulationを照合できません。通常DeploymentAccessでは実行できません。',
  registration_children_present: '管理中の子Botまたは作成要求が残っています。親の削除を停止しました。READMEの対象照合・子資源cleanup手順を先に実行してください。',
  configuration_rotation_unknown: 'Configuration token更新の結果が不明です。旧refresh tokenを再使用しません。保存済みSM世代を確認し、未保存ならroot OAuth ownerが新しいRefresh Tokenを生成して connect-registration --reconnect で明示再接続してください。',
  settings_require_home: '受付チャンネル・対応先・任意通知はSlack Homeで変更してください。Botの参加状態・外部共有を検証して保存します。configureは名前・説明・管理者の変更に使います。',
  unsupported_region: 'このリージョンは未対応です。通常のAWS商用リージョンを指定してください。中国・GovCloud等ではAWS/Slack変更を開始しません。',
  aws_authentication: 'AWS認証を確認してください。AWS_PROFILE/SSO等を設定して再実行してください。',
  aws_bucket_access: 'state用S3バケットを確認できません。権限不足またはバケット名・ownerの競合の可能性があります。AWSアカウント・リージョン・バケット名、ネットワークとバケット設定の読取権限を確認してください。初期準備は管理者のbootstrap-stateで行います。',
  state_bucket_not_ready: 'state用バケットの準備が未完了です。管理者がbootstrap-stateで専用タグ・公開アクセス制限・暗号化・versioningを確認/復旧してください。通常運用はバケット設定を変更しません。',
  aws_bootstrap_permission: 'state用S3バケットの初期化権限がありません。対象バケットの作成・タグ読み書き・公開アクセス制限・暗号化・versioningの権限を確認してください。Terraform適用は開始していません。途中まで作成・設定済みの場合はREADMEの復旧手順を確認して再実行してください。',
  aws_permission: 'セットアップ情報へのAWS権限がありません。対象S3オブジェクトの読み取り権限を確認してください。',
  aws_not_deployed: '指定環境は未展開です。deploy-awsを先に実行してください。',
  aws_descriptor_unavailable: 'セットアップ情報を取得できません。認証・権限・リージョン・ネットワークを確認してください。Slack変更は開始していません。',
  aws_endpoint_permission: '接続先のAWS照合権限がありません。対象HTTP Lambdaのlambda:GetFunctionConfigurationとAPI Gatewayのapigateway:GET権限を確認してください。Slack変更は開始していません。',
  aws_endpoint_unavailable: '接続先のAWS実体を確認できません。認証・権限・リージョン・ネットワークとHTTP Lambdaの環境設定を確認してください。Slack変更は開始していません。',
  invalid_descriptor: 'セットアップ情報の形式またはリソース参照が不正です。deploy-awsで復旧してください。',
  target_mismatch: 'セットアップ情報と指定環境が一致しません。Slack変更は開始していません。',
  slack_invalid_manifest: 'SlackがManifestを拒否しました (slack_invalid_manifest)。作成中の記録が残る場合はアプリ管理画面で作成有無を確認し、READMEの復旧手順に従ってください。',
  slack_invalid_auth: 'Slack認証に失敗しました (slack_invalid_auth)。対象ワークスペースのApp configuration Access Tokenとネットワーク制限を確認してください。',
  slack_not_allowed_token_type: 'Slackのトークン種類が違います (slack_not_allowed_token_type)。初回connect-registrationはConfiguration Refresh Token、親setup-slackはConfiguration Access Tokenを使います。Bot tokenではありません。',
  slack_request_failed: 'Slackへの通信に失敗しました (slack_request_failed)。タイムアウトやネットワーク障害の可能性があります。アプリ作成中の場合は管理画面で作成有無を確認し、READMEの復旧手順に従ってください。',
  slack_creation_ambiguous: 'Slackアプリ作成の成否が不明です。アプリ管理画面で確認し、存在する場合は --recover-app-id で復旧してください。存在しない場合はREADMEの作成状態解除手順に従ってください。',
  slack_scope_reduction_required: '既存Bot tokenにManifestより余分な権限があります。再OAuthでは縮小できません。remove-slackで専用アプリを削除してからsetup-slackで再作成・承認してください。',
  root_oauth_pending: 'Root OAuthの交換・保存結果が未確認のため、新しい承認リンクを発行しません。setup-slack --reinstallは同じ要求の保存済み成功結果と現在のBot/workspaceを照合できる場合だけ復旧します。照合できない場合は既存状態を確認し、必要なら対象専用Appを削除・再作成してください。同じOAuth codeは再交換しません。',
  slack_scopes_unknown: '既存Bot tokenの付与済み権限が不明です。remove-slackで専用アプリを削除してからsetup-slackで再作成してください。',
  aws_removal_pending: 'AWS削除が途中です。destroy-awsを再実行し、削除完了後に再展開してください。',
  slack_removal_pending: 'AWS削除済みの専用Slackアプリが残っています。remove-slackで削除してから再展開してください。',
  invalid_removal_record: 'Slack削除記録の形式が不正です。変更を開始せず停止しました。S3の記録とREADMEの復旧手順を確認してください。',
  terraform_unavailable: 'Terraform 1.10以上をPATHへ入れるか --terraform で実行ファイルを指定してください。',
  cancelled: '処理を中止しました。'
};
async function main(): Promise<void> {
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  const command = process.argv[2];
  const { values } = parseArgs({ args: process.argv.slice(3), options: { account: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'preserve-purge-evidence': { type: 'boolean' }, region: { type: 'string' }, env: { type: 'string' }, terraform: { type: 'string' }, reinstall: { type: 'boolean' }, reconnect: { type: 'boolean' }, 'recover-app-id': { type: 'string' }, 'restart-oauth': { type: 'boolean' }, 'resume-failed': { type: 'boolean' }, help: { type: 'boolean' }, name: { type: 'string' }, description: { type: 'string' }, actor: { type: 'string' }, file: { type: 'string' }, id: { type: 'string' } } });
  if (values.help || !command || !actions.includes(command)) { process.stdout.write(help + recoveryHelp); if (command && !actions.includes(command)) process.exitCode = 1; return; }
  if (command === 'purge-env') {
    if (Object.keys(values).some(key => !['account','region','env','terraform','dry-run','help'].includes(key))) throw new AppError('invalid_input');
    await purgeEnvironment(validateTarget({accountId:string(values.account),region:string(values.region),environment:string(values.env)}),values['dry-run'] === true,values.terraform ?? 'terraform',{input,confirm,password});
    return;
  }
  if(values['preserve-purge-evidence'] && !['install','remove-slack','destroy-aws','uninstall'].includes(command)) throw new AppError('invalid_input');
  if (values.account !== undefined || values['dry-run'] !== undefined) throw new AppError('invalid_input');
  if ((values['restart-oauth'] || values['resume-failed']) && (command !== 'recover-registration' || values['restart-oauth'] && values['resume-failed'] || values['resume-failed'] && values['recover-app-id'])) throw new AppError('invalid_input');
  if (values.reconnect && command !== 'connect-registration') throw new AppError('invalid_input');
  if (values.name !== undefined) validateName(values.name);
  validateDescription(values.description ?? '');
  const region = string(values.region ?? await input({ message: 'AWSリージョン:' }));
  const environment = string(values.env ?? await input({ message: '環境名（小文字英数字・ハイフン、24文字以内）:' }));
  validateRegion(region);
  const accountId = await SetupAws.account(region);
  const target = validateTarget({ accountId, region, environment });
  if(values['preserve-purge-evidence']) { const cli = new PurgeAwsCli(target); await cli.authorizeAdmin(await cli.call('sts','get-caller-identity',{})); }
  const aws = new SetupAws(target);
  if (!['deploy-aws','install','bootstrap-state'].includes(command)) await requireNoPurge(aws);
  const terraform = new Terraform(values.terraform ?? 'terraform', target);
  process.stdout.write(`対象: AWS ${accountId} / ${region} / ${environment}\n`);
  if (command === 'bootstrap-state') {
    if (!await confirm({ message: '共有stateバケットを管理者権限で作成・保護設定します。全環境へ影響する操作を実行しますか？', default: false })) throw new AppError('cancelled');
    await aws.bootstrap();
    process.stdout.write('共有stateバケットの準備が完了しました。\n');
  }
  const execute = async () => {
    let rootHistory:RootHistory|undefined;
    if (command === 'deploy-aws' || command === 'install') {
      const genesis=command==='install'&&values['preserve-purge-evidence']?await beginRootHistory(aws):undefined;
      await environmentFence();
      await requireNoPurge(aws);
      await prepareDeploy(aws);
      await terraform.init();
      await terraform.apply(false);
      await environmentFence();
      const descriptor=validateDescriptor(await terraform.output(),target);
      await aws.saveDescriptor(descriptor);
      if(genesis)rootHistory=await bindRootHistory(aws,descriptor,genesis);
    }
    if (command === 'setup-slack' || command === 'install') {
      await environmentFence();
      if (await aws.removal()) throw new AppError('aws_removal_pending');
      await setupSlack(aws, await aws.descriptor(), values.reinstall === true, values['recover-app-id'], { input, confirm, password }, { name: values.name, description: values.description, rootHistory });
    }
    if (command === 'connect-registration' || command === 'recover-registration') {
      await environmentFence();
      if (await aws.removal()) throw new AppError('aws_removal_pending');
      const descriptor = await aws.descriptor();
      if (command === 'connect-registration') await connectRegistration(aws, descriptor, password, values.reconnect === true);
      else if (values['restart-oauth']) await restartRegistrationOAuth(aws, descriptor, string(values.id), string(values['recover-app-id']));
      else if (values['resume-failed']) await resumeFailedRegistration(aws, descriptor, string(values.id));
      else await recoverRegistration(aws, descriptor, string(values.id), string(values['recover-app-id']), password);
    }
    if (['migrate-config','show-config','configure','knowledge-put','knowledge-list','knowledge-delete'].includes(command)) {
      if (await aws.removal()) throw new AppError('aws_removal_pending');
      await environmentFence();
      await manageGroup(aws, await aws.descriptor(), command, { actor: values.actor, file: values.file, id: values.id, name: values.name, description: values.description });
    }
    if (command === 'remove-slack' || command === 'uninstall') { await environmentFence(); await removeSlack(aws, { input, confirm, password },values['preserve-purge-evidence'] === true); }
    if (command === 'destroy-aws' || command === 'uninstall') { await environmentFence(); await destroyAws(aws, terraform, { input, confirm, password },values['preserve-purge-evidence'] === true); }
  };
  if (['bootstrap-state','show-config','knowledge-list'].includes(command)) { await execute(); return; }
  if (['deploy-aws','install'].includes(command)) await aws.verifyStateBucket();
  const lease = new EnvironmentLease(aws,'normal');
  await lease.acquire();
  try { await lease.run(execute); } finally { await lease.release(); }
}
try { await main(); }
catch (error) { const code = setupDiagnosticCode(error); process.stderr.write(`${messages[code] ?? `処理に失敗しました (${code})。認証・権限・入力とREADMEの復旧手順を確認してください。秘密値は表示しません。`}\n`); process.exitCode = 1; }
