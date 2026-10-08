import { createServer, type IncomingMessage } from 'node:http';
import { configureRuntime } from './runtime.js';
import { googleRuntime, type GoogleRuntimeConfig } from './google-runtime.js';
import { env, object, string } from './contracts.js';
import { diagnosticCode } from './diagnostics.js';
import type { HttpRequest } from './http-contract.js';
export async function cloudRunRequest(request: IncomingMessage, receivedAt: number): Promise<HttpRequest> {
  const raw = request.url;
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) throw new Error('request_url_invalid');
  const queryAt = raw.indexOf('?'), rawPath = queryAt === -1 ? raw : raw.slice(0, queryAt), rawQueryString = queryAt === -1 ? '' : raw.slice(queryAt + 1);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk); bytes += value.length;
    if (bytes > 1_000_000) throw new Error('request_size_exceeded');
    chunks.push(value);
  }
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
  return { rawPath, rawQueryString, body: Buffer.concat(chunks).toString('base64'), isBase64Encoded: true, headers, cookies: headers.cookie ? [headers.cookie] : [], queryStringParameters: Object.fromEntries(new URLSearchParams(rawQueryString)), requestContext: { timeEpoch: receivedAt, http: { method: string(request.method) } } };
}
export async function startCloudRun(config: GoogleRuntimeConfig, role: 'http' | 'worker', port: number): Promise<void> {
  configureRuntime(googleRuntime(config, role === 'worker' ? 10_000 : 30_000));
  // Import after choosing the runtime so module-level queue ports have the same owner.
  const [{ handler }, { processConsultationJob }, { processWikiJob }, { provision }] = await Promise.all([import('./http.js'), import('./worker.js'), import('./wiki-runner.js'), import('./provisioner.js')]);
  const server = createServer(async (request, response) => {
    const receivedAt = Date.now();
    try {
      const event = await cloudRunRequest(request, receivedAt);
      if (event.rawPath === '/health') { response.writeHead(200); response.end('ok'); return; }
      if (role === 'http') {
        const result = await handler(event);
        response.statusCode = result.statusCode ?? 200;
        for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, String(value));
        if (result.cookies) response.setHeader('set-cookie', result.cookies);
        response.end(result.isBase64Encoded ? Buffer.from(result.body ?? '', 'base64') : result.body ?? '');
        return;
      }
      // Cloud Run IAM validates the Tasks/Scheduler OIDC token before this private service runs.
      if (event.requestContext.http.method !== 'POST' || !['/tasks', '/rotate'].includes(event.rawPath)) { response.writeHead(404); response.end(); return; }
      const raw = Buffer.from(event.body!, 'base64').toString('utf8'), job = object(JSON.parse(raw));
      if (event.rawPath === '/rotate') {
        if (job.kind !== 'rotate' || Object.keys(job).length !== 1) throw new Error('scheduler_job_invalid');
        await provision(raw);
      } else if (['provision', 'delete_bot'].includes(string(job.kind))) await provision(raw);
      else if (['wiki', 'wiki_ui', 'wiki_command', 'wiki_adoption', 'wiki_archive_retention'].includes(string(job.kind))) await processWikiJob(raw);
      else await processConsultationJob(raw);
      response.writeHead(204); response.end();
    } catch (error) {
      process.stderr.write(JSON.stringify({ event: 'roughmate_cloud_run_failed', code: diagnosticCode(error) }) + '\n');
      response.writeHead(503, { 'cache-control': 'no-store' }); response.end();
    }
  });
  server.requestTimeout = 180_000;
  server.listen(port, '0.0.0.0');
  process.once('SIGTERM', () => server.close());
}
if (process.env.ROUGH_MATE_CLOUD_RUN === '1') {
  const role = env('SERVICE_ROLE'); if (role !== 'http' && role !== 'worker') throw new Error('service_role_invalid');
  void startCloudRun({ project: env('GOOGLE_CLOUD_PROJECT'), projectNumber: env('GOOGLE_CLOUD_PROJECT_NUMBER'), database: env('FIRESTORE_DATABASE'), environment: env('TABLE_NAME'), location: env('GOOGLE_CLOUD_LOCATION'), workerUrl: env('WORKER_URL'), taskAccount: env('TASK_SERVICE_ACCOUNT') }, role, Number(env('PORT'))).catch(error => { process.stderr.write(JSON.stringify({ event: 'roughmate_start_failed', code: diagnosticCode(error) }) + '\n'); process.exitCode = 1; });
}
