import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/package', { recursive: true });
await build({ entryPoints: ['app/src/http.ts', 'app/src/worker.ts', 'app/src/provisioner.ts', 'app/src/wiki-runner.ts'], outdir: 'dist/package', bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false });
execFileSync('zip', ['-q', '-j', 'dist/roughmate.zip', 'dist/package/http.js', 'dist/package/worker.js', 'dist/package/provisioner.js', 'dist/package/wiki-runner.js']);
