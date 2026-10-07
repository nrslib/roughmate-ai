import { AppError } from './contracts.js';
export const SLACK_REQUEST_BUDGET_MS = 2500;
export class RequestDeadline {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  readonly signal = this.controller.signal;
  constructor(private expiresAt: number) {
    this.timer = setTimeout(() => this.controller.abort(new AppError('request_deadline')), Math.max(0, expiresAt - Date.now()));
  }
  private check(): void {
    if (Date.now() >= this.expiresAt) this.controller.abort(new AppError('request_deadline'));
    this.signal.throwIfAborted();
  }
  requireRemaining(milliseconds: number): void {
    this.check();
    if (this.expiresAt - Date.now() < milliseconds) this.controller.abort(new AppError('request_deadline'));
    this.signal.throwIfAborted();
  }
  async step<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const result = await operation();
    this.check();
    return result;
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    let onAbort: () => void = () => {};
    try {
      this.check();
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(this.signal.reason);
        this.signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([this.step(operation), expired]);
    } finally {
      clearTimeout(this.timer);
      this.signal.removeEventListener('abort', onAbort);
    }
  }
  async runAwaited<T>(operation: () => Promise<T>): Promise<T> {
    // この経路のACKは、signalで中断したI/Oの完了後に返し、副作用をレスポンス後へ残さない。
    try { return await this.step(operation); }
    finally { clearTimeout(this.timer); }
  }
}
