import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { password, input } from '@inquirer/prompts';
import { configureRuntime } from '../app/src/runtime.js';
import { googleRuntime } from '../app/src/google-runtime.js';
import { ConfigurationAccess } from '../app/src/configuration-tokens.js';
import { Storage } from '../app/src/storage.js';
import { AppError, string } from '../app/src/contracts.js';
import { setupGoogleSlack, removeGoogleSlack, type GoogleSlackTarget } from './lib/google-slack.js';
import { diagnosticCode } from '../app/src/diagnostics.js';
interface Configuration { schemaVersion: 1; project: string; project_number: string; region: string; environment: string; stateBucket: string; image: string; services_enabled: boolean; }
const APIs = ['run.googleapis.com', 'firestore.googleapis.com', 'cloudtasks.googleapis.com', 'secretmanager.googleapis.com', 'cloudscheduler.googleapis.com', 'storage.googleapis.com', 'artifactregistry.googleapis.com', 'cloudbuild.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'logging.googleapis.com'];
function run(command: string, args: string[], capture = false, extraEnv: Record<string, string> = {}): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, ...extraEnv } }) ?? '';
}
export function validateGoogleConfiguration(value: unknown): Configuration {
  if (!value || typeof value !== 'object') throw new AppError('google_configuration_invalid');
  const config = value as Configuration;
  if (config.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project) || !/^[0-9]{6,20}$/.test(config.project_number) || !/^[a-z]+-[a-z]+[0-9]+$/.test(config.region) || !/^[a-z][a-z0-9-]{0,9}$/.test(config.environment) || config.environment.includes('-bot') || !/^[a-z0-9][a-z0-9.-]{2,61}$/.test(config.stateBucket) || typeof config.image !== 'string' || typeof config.services_enabled !== 'boolean' || `roughmate-${config.environment}-worker-${config.project_number}`.length > 63) throw new AppError('google_configuration_invalid');
  return config;
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, project: { type: 'string' }, region: { type: 'string' }, env: { type: 'string' }, 'state-bucket': { type: 'string' }, name: { type: 'string' }, 'recover-app-id': { type: 'string' } } });
  if (values.help) {
    process.stdout.write('Google Cloudセルフホスティング:\n  bootstrap --project PROJECT --region REGION --env ENV --state-bucket BUCKET\n  plan|deploy|setup-slack|connect-registration|remove-slack|uninstall --env ENV\n  setup-slackは --name NAME、未知作成結果の復旧は --recover-app-id APP を指定できます。\n  uninstallはSlack Appと実行資源を削除し、Firestore・子Bot秘密・stateを保持します。完全purgeは未対応です。\n'); return;
  }
  if (positionals.length !== 1) throw new AppError('command_required');
  const command = positionals[0], environment = string(values.env), directory = resolve('.roughmate-google', environment);
  if (!/^[a-z][a-z0-9-]{0,9}$/.test(environment) || environment.includes('-bot')) throw new AppError('environment_invalid');
  const path = resolve(directory, 'config.json');
  let config: Configuration;
  if (command === 'bootstrap') {
    const project = string(values.project), region = string(values.region), projectNumber = run('gcloud', ['projects', 'describe', project, '--format=value(projectNumber)'], true).trim();
    config = validateGoogleConfiguration({ schemaVersion: 1, project, project_number: projectNumber, region, environment, stateBucket: string(values['state-bucket']), image: '', services_enabled: false });
    let existing = false;
    try { await access(path); existing = true; } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
    if (existing) {
      const saved = validateGoogleConfiguration(JSON.parse(await readFile(path, 'utf8')));
      if (saved.project !== config.project || saved.project_number !== config.project_number || saved.region !== config.region || saved.environment !== config.environment || saved.stateBucket !== config.stateBucket) throw new AppError('google_configuration_boundary');
      config = saved;
    } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    run('gcloud', ['services', 'enable', ...APIs, '--project', project]);
    // A dedicated, versioned state bucket is retained through normal uninstall.
    run('gcloud', ['storage', 'buckets', 'create', `gs://${config.stateBucket}`, '--project', project, '--location', region, '--uniform-bucket-level-access', '--public-access-prevention']);
    run('gcloud', ['storage', 'buckets', 'update', `gs://${config.stateBucket}`, '--versioning']);
    await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    }
  } else {
    config = validateGoogleConfiguration(JSON.parse(await readFile(path, 'utf8')));
    if (values.project && values.project !== config.project || values.region && values.region !== config.region || values['state-bucket'] && values['state-bucket'] !== config.stateBucket) throw new AppError('google_configuration_boundary');
  }
  const name = `roughmate-${environment}`, publicUrl = `https://${name}-http-${config.project_number}.${config.region}.run.app`, workerUrl = `https://${name}-worker-${config.project_number}.${config.region}.run.app`, buildAccount = `${name}-build@${config.project}.iam.gserviceaccount.com`;
  const target: GoogleSlackTarget = { project: config.project, projectNumber: config.project_number, region: config.region, environment, publicUrl };
  const vars = resolve(directory, 'runtime.tfvars.json'), dataDirectory = resolve(directory, 'terraform');
  const tfvars = () => writeFile(vars, JSON.stringify({ project: config.project, project_number: config.project_number, region: config.region, environment, image: config.image, services_enabled: config.services_enabled }, null, 2) + '\n', { mode: 0o600 });
  const terraform = (args: string[]) => run('terraform', ['-chdir=infra/google-cloud', ...args], false, { TF_DATA_DIR: dataDirectory });
  const initialize = () => terraform(['init', '-reconfigure', `-backend-config=bucket=${config.stateBucket}`, `-backend-config=prefix=roughmate/${environment}`]);
  if (['bootstrap', 'deploy', 'plan', 'uninstall'].includes(command)) {
    await tfvars(); initialize();
    if (command === 'bootstrap') terraform(['apply', `-var-file=${vars}`]);
    if (command === 'plan') terraform(['plan', `-var-file=${vars}`]);
    if (command === 'deploy') {
      const repository = `${config.region}-docker.pkg.dev/${config.project}/${name}/runtime`, tag = new Date().toISOString().replace(/[^0-9]/g, '');
      run('gcloud', ['builds', 'submit', '.', '--project', config.project, '--region', config.region, '--config=infra/google-cloud/cloudbuild.yaml', `--service-account=projects/${config.project}/serviceAccounts/${buildAccount}`, `--gcs-source-staging-dir=gs://${config.project_number}-${name}-build/source`, `--substitutions=_IMAGE=${repository}:${tag}`]);
      const imageDigest = run('gcloud', ['artifacts', 'docker', 'images', 'describe', `${repository}:${tag}`, '--project', config.project, '--format=value(image_summary.digest)'], true).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new AppError('image_digest_invalid');
      config.image = `${repository}@${imageDigest}`; config.services_enabled = true;
      await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); await tfvars();
      terraform(['apply', `-var-file=${vars}`]);
      for (const [role, expected] of [['http', publicUrl], ['worker', workerUrl]]) {
        const observed = run('gcloud', ['run', 'services', 'describe', `${name}-${role}`, '--project', config.project, '--region', config.region, '--format=json'], true), service = JSON.parse(observed) as { status?: { url?: string }; metadata?: { annotations?: Record<string, string> } };
        const urls = service.metadata?.annotations?.['run.googleapis.com/urls'];
        if (service.status?.url !== expected && (!urls || !(JSON.parse(urls) as string[]).includes(expected))) throw new AppError('cloud_run_url_mismatch');
      }
      process.stdout.write(publicUrl + '\n');
    }
  }
  if (['setup-slack', 'connect-registration', 'remove-slack', 'uninstall'].includes(command)) {
    if (!config.services_enabled) throw new AppError('deploy_required');
    configureRuntime(googleRuntime({ project: config.project, projectNumber: config.project_number, database: name, environment: name, location: config.region, workerUrl, taskAccount: `${name}-tasks@${config.project}.iam.gserviceaccount.com` }));
    process.env.TABLE_NAME = name; process.env.SECRET_ARN = `projects/${config.project_number}/secrets/${name}-runtime`; process.env.CONFIGURATION_SECRET_ARN = `projects/${config.project_number}/secrets/${name}-configuration`; process.env.PUBLIC_URL = publicUrl;
    // CLI uses the operator's ADC. It does not impersonate or distribute runtime account keys.
    if (command === 'setup-slack') await setupGoogleSlack(target, values.name ?? 'Roughmate AI', values['recover-app-id']);
    if (command === 'connect-registration') {
      const store = new Storage(name, process.env.SECRET_ARN), refreshToken = string(await password({ message: '登録者本人のSlack Configuration refresh token:', mask: '*' }));
      await new ConfigurationAccess(store, name, process.env.CONFIGURATION_SECRET_ARN).connect(refreshToken);
      process.stdout.write('登録サービスを接続しました。\n');
    }
    if (command === 'remove-slack' || command === 'uninstall') {
      const expected = `${config.project}/${environment}`;
      if (await input({ message: `Slack Appを削除する対象 ${expected} を入力してください:` }) !== expected) throw new AppError('google_removal_cancelled');
      if (!await removeGoogleSlack(target)) return;
      if (command === 'uninstall') { terraform(['destroy', `-var-file=${vars}`]); process.stdout.write(`通常アンインストール完了。保持: Firestore ${name}、子Bot秘密、state bucket ${config.stateBucket}。Google Cloud完全purgeは未対応です。\n`); }
    }
  }
  if (!['bootstrap', 'plan', 'deploy', 'setup-slack', 'connect-registration', 'remove-slack', 'uninstall'].includes(command)) throw new AppError('unknown_command');
}
if (process.argv[1]?.endsWith('/google-cloud.ts')) void main().catch(error => { process.stderr.write(JSON.stringify({ event: 'roughmate_google_cli_failed', code: diagnosticCode(error), ...(error instanceof AppError ? { reason: error.code } : {}) }) + '\n'); process.exitCode = 1; });
