import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from './contracts.js';
export function verifySignature(body: string, timestamp: string, signature: string, secret: string, now: number): void {
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300) throw new AppError('invalid_signature');
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, Buffer.from(expected))) throw new AppError('invalid_signature');
}
export function stateKey(state: string): string { return 'oauth#' + createHash('sha256').update(state).digest('hex'); }
export function authorizeWorkspace(workspace: { teamId: string }, team: string): void {
  if (workspace.teamId !== team) throw new AppError('forbidden');
}
export function authorizeOwner(workspace: { teamId: string; ownerId: string }, team: string, user: string): void {
  authorizeWorkspace(workspace, team);
  if (workspace.ownerId !== user) throw new AppError('forbidden');
}
