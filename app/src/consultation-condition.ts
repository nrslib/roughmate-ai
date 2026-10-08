import { c, type DocumentCondition } from './document-store.js';
import type { ConsultationCondition } from './consultation-store.js';

// StorageとWikiStorageは同じ条件を原子的な更新へ組み込む。
export function documentConsultationCondition(condition: ConsultationCondition | undefined): { condition: DocumentCondition; values: Record<string, unknown> } | undefined {
  if (!condition) return undefined;
  switch (condition.kind) {
    case 'generation_lease_expired':
      return { condition: c.compare('leaseUntil', '<', ':now'), values: { ':now': condition.now } };
    case 'posting_owner':
      return { condition: c.compare('postingOwner', '=', ':owner'), values: { ':owner': condition.owner } };
    case 'posting_guard_elapsed':
      return { condition: c.group(c.any(c.absent('postingUntil'), c.compare('postingUntil', '<=', ':now'))), values: { ':now': condition.now } };
    case 'question_missing':
      return { condition: c.group(c.any(c.absent('question'), c.compare('question', '=', ':empty'))), values: { ':empty': '' } };
  }
}
