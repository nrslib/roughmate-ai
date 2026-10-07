import { AppError } from './contracts.js';
import { requireIdentity, type GroupConfig, type GroupIdentity } from './groups.js';
import type { Storage } from './storage.js';

export interface AnswerEdit extends GroupIdentity {
  pk: string; requestId: string; actorId: string; draftTs: string; configVersion: number; expiresAt: number; viewId: string;
}
export async function requireAnswerEdit(store: Storage, config: GroupConfig, user: string, viewId: string, receiptId: string): Promise<AnswerEdit> {
  if (!/^answer-edit#[a-f0-9]{32}$/.test(receiptId)) throw new AppError('forbidden');
  const receipt = await store.get<AnswerEdit>(receiptId);
  if (!receipt || receipt.pk !== receiptId || receipt.actorId !== user || receipt.viewId !== viewId || receipt.configVersion !== config.version || receipt.expiresAt <= Math.floor(Date.now()/1000)) throw new AppError('forbidden');
  requireIdentity(receipt, config);
  return receipt;
}
