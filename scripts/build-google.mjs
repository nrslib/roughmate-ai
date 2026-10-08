import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist/google-cloud', { recursive: true });
await build({ entryPoints: ['app/src/google-cloud-run.ts'], outfile: 'dist/google-cloud/server.cjs', bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'cjs', sourcemap: false });
