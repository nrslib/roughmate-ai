import { environmentFence, environmentSignal } from './environment-lease.js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AppError } from '../../app/src/contracts.js';
import { location, type Target } from './config.js';
export class Terraform {
  private dataDir: string;
  constructor(private binary: string, private target: Target, private spawnCommand = spawn) { this.dataDir = resolve('.roughmate', target.accountId, target.region, target.environment, 'terraform'); }
  private async run(args: string[], capture: boolean, temporaryDir?: string): Promise<string> {
    await environmentFence();
    const signal = environmentSignal();
    const dataDir = temporaryDir ?? this.dataDir;
    await mkdir(dataDir, { recursive: true });
    return new Promise((resolvePromise, reject) => {
      const child = this.spawnCommand(this.binary, ['-chdir=infra/aws', ...args], { env: { ...process.env, TF_DATA_DIR: dataDir, TF_WORKSPACE: 'default', ...(temporaryDir ? { TF_INPUT: '0', TF_CLI_ARGS: '', TF_CLI_ARGS_init: '', TF_CLI_ARGS_destroy: '' } : {}) }, stdio: temporaryDir ? ['ignore','pipe','pipe'] : capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', signal, ...(temporaryDir ? { timeout: args[0] === 'init' ? 120_000 : 600_000 } : {}) });
      if (temporaryDir) child.stderr?.resume();
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => { if (!temporaryDir) output += chunk.toString(); });
      child.on('error', () => { if (!signal?.aborted) reject(new AppError('terraform_unavailable')); });
      child.on('close', code => signal?.aborted ? reject(signal.reason) : code === 0 ? resolvePromise(output) : reject(new AppError('terraform_failed')));
    });
  }
  async init(): Promise<void> {
    const place = location(this.target);
    await this.run(['init', '-reconfigure', `-backend-config=bucket=${place.bucket}`, `-backend-config=key=${place.stateKey}`, `-backend-config=workspace_key_prefix=environments/${this.target.environment}/workspaces`, `-backend-config=region=${this.target.region}`, '-backend-config=encrypt=true', '-backend-config=use_lockfile=true'], false);
  }
  async apply(destroy: boolean): Promise<void> {
    await this.run([destroy ? 'destroy' : 'apply', `-var=account_id=${this.target.accountId}`, `-var=region=${this.target.region}`, `-var=environment=${this.target.environment}`, `-var=artifact=${resolve('dist/roughmate.zip')}`], false);
  }
  async purge(): Promise<void> {
    const directory = await mkdtemp(resolve(tmpdir(), 'roughmate-purge-'));
    const place = location(this.target);
    try {
      await this.run(['init','-input=false','-reconfigure',`-backend-config=bucket=${place.bucket}`,`-backend-config=key=${place.stateKey}`,`-backend-config=workspace_key_prefix=environments/${this.target.environment}/workspaces`,`-backend-config=region=${this.target.region}`,'-backend-config=encrypt=true','-backend-config=use_lockfile=true'], true, directory);
      await this.run(['destroy','-input=false','-auto-approve',`-var=account_id=${this.target.accountId}`,`-var=region=${this.target.region}`,`-var=environment=${this.target.environment}`,`-var=artifact=${resolve('dist/roughmate.zip')}`], true, directory);
    } finally { await rm(directory, {recursive:true,force:true}); }
  }
  async output(): Promise<unknown> { return JSON.parse(await this.run(['output', '-json', 'setup'], true)); }
}
