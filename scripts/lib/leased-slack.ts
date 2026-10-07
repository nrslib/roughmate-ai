import { WebClient, LogLevel, type WebAPICallResult } from '@slack/web-api';
import { environmentFence, environmentSignal } from './environment-lease.js';

// WebClient binds generated API methods during construction, so the fence belongs on the subclass prototype.
class LeasedWebClient extends WebClient {
  override async apiCall(...args: Parameters<WebClient['apiCall']>): Promise<WebAPICallResult> {
    await environmentFence();
    return super.apiCall(...args);
  }
}
export function slackClient(token?: string, signal?: AbortSignal, timeoutMs = 1800): WebClient {
  const leaseSignal = environmentSignal();
  const combined = leaseSignal && signal ? AbortSignal.any([leaseSignal,signal]) : leaseSignal ?? signal;
  return new LeasedWebClient(token, { fetch: combined ? (url,init) => { combined.throwIfAborted(); return fetch(url,{...init,signal:init?.signal ? AbortSignal.any([combined,init.signal]) : combined}); } : undefined, logLevel:LogLevel.ERROR, logger:{debug(){},info(){},warn(){},error(){},setLevel(){},getLevel(){return LogLevel.ERROR;},setName(){}}, retryConfig:{retries:0}, timeout:timeoutMs, rejectRateLimitedCalls:true });
}
