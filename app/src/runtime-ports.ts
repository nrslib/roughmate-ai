import type { BotResources, Registration, Registrations } from './registration.js';
export interface RuntimeOptions { abortSignal?: AbortSignal; }
export class SecretVersionUnavailableError extends Error {
  readonly name = 'ResourceNotFoundException';
  constructor(readonly outcome: 'missing' | 'unsent' | 'rejected' | 'unknown') { super('secret_version_unavailable'); }
}
export interface SecretStore {
  read(input: { id: string; version?: string }, options?: RuntimeOptions): Promise<string>;
  write(input: { id: string; operationId?: string; value: string }, options?: RuntimeOptions): Promise<void>;
}
export interface JobQueue {
  enqueue(input: { destination: string; body: string; delaySeconds?: number }, options?: RuntimeOptions): Promise<void>;
}
export interface ChildResourceManager {
  names(parent: string, secret: string, id: string): BotResources;
  validSecret(resources: BotResources, secret: string): boolean;
  ensure(registrations: Registrations, entry: Registration): Promise<string>;
}
