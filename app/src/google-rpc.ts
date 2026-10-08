import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Firestore, setLogFunction } from '@google-cloud/firestore';
import { loggingUtils, grpc } from 'google-gax';
import { remainingRequestTime } from './deadline.js';
import type { RuntimeOptions } from './runtime-ports.js';
const firestoreBudget = new AsyncLocalStorage<{ timeout: number; expiresAt?: number; signal?: AbortSignal }>();
const requestBudgets = new WeakMap<object, { expiresAt: number; signal?: AbortSignal }>();
const applicationRequire = createRequire(resolve(process.argv[1] ?? 'package.json'));
const firestoreApiRequire = createRequire(applicationRequire.resolve('@google-cloud/firestore-api'));
const firestoreApiGax: typeof import('google-gax') = firestoreApiRequire('google-gax');
export function disableGooglePayloadLogging(): void { loggingUtils.setBackend(null); firestoreApiGax.loggingUtils.setBackend(null); setLogFunction(null); }
export function googleRpcOptions(timeout: number, options?: RuntimeOptions): { retry: null; timeout: number } {
  options?.abortSignal?.throwIfAborted();
  const remaining = options?.abortSignal ? remainingRequestTime(options.abortSignal) : undefined;
  return { retry: null, timeout: Math.min(timeout, remaining ?? timeout) };
}
export function firestoreRpc<T>(timeout: number, options: RuntimeOptions | undefined, operation: () => Promise<T>): Promise<T> {
  const signal = options?.abortSignal, now = Date.now();
  const remaining = signal ? remainingRequestTime(signal) : undefined;
  return firestoreBudget.run({ timeout, signal, ...(remaining === undefined ? {} : { expiresAt: now + remaining }) }, operation);
}
export function firestoreReceipt<T>(timeout: number, operation: () => Promise<T>): Promise<T> {
  return firestoreBudget.run({ timeout, expiresAt: Date.now() + timeout, signal: AbortSignal.timeout(timeout) }, operation);
}
export function createGoogleFirestore(projectId: string, databaseId: string, timeout = 30_000): Firestore {
  if (process.env.FIRESTORE_EMULATOR_HOST && !projectId.startsWith('demo-')) throw new Error('google_emulator_boundary');
  disableGooglePayloadLogging();
  const transform: grpc.CallInvocationTransformer = properties => {
    const now = Date.now(), argument: unknown = properties.argument;
    const request = argument !== null && typeof argument === 'object' ? argument : undefined;
    // GAX retry timers can lose the calling async context; retain its original request budget.
    const context = firestoreBudget.getStore() || { timeout };
    const budget = (request && requestBudgets.get(request)) || { expiresAt: Math.min(now + context.timeout, context.expiresAt ?? Infinity), signal: context.signal };
    if (request) requestBudgets.set(request, budget);
    const expiresAt = Math.min(now + timeout, budget?.expiresAt ?? Infinity, Number(properties.callOptions.deadline ?? Infinity));
    const expired = () => expiresAt <= Date.now() || budget?.signal?.aborted === true;
    const stopExpired: grpc.Interceptor = (options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        if (expired()) queueMicrotask(() => listener.onReceiveStatus({ code: grpc.status.CANCELLED, details: 'request_deadline', metadata: new grpc.Metadata() }));
        else next(metadata, listener);
      },
      sendMessage(message, next) { if (!expired()) next(message); },
      halfClose(next) { if (!expired()) next(); }
    });
    if (budget?.signal) {
      const signal = budget.signal, cancel = () => properties.call.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      properties.call.once('status', () => signal.removeEventListener('abort', cancel));
    }
    return { ...properties, callOptions: { ...properties.callOptions, deadline: new Date(expiresAt), interceptors: [...(properties.callOptions.interceptors ?? []), stopExpired] } };
  };
  // Legacy streaming retry-request retries terminal errors; use the public GAX retry policy instead.
  const methods = Object.fromEntries(['BatchGetDocuments', 'RunQuery', 'Commit', 'BeginTransaction', 'Rollback'].map(name => [name, { retry_codes_name: 'disabled' }]));
  return new Firestore({ projectId, databaseId, preferRest: false, gaxServerStreamingRetries: true, clientConfig: { interfaces: { 'google.firestore.v1.Firestore': { retry_codes: { disabled: [] }, methods } } }, 'grpc.callInvocationTransformer': transform });
}
