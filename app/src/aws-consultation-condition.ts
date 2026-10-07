import type { ConsultationCondition } from './consultation-store.js';

// StorageとWikiStorageは同じ条件を原子的な更新へ組み込む。
export function dynamoConsultationCondition(condition: ConsultationCondition | undefined): { expression: string; values: Record<string, unknown> } | undefined {
  if (!condition) return undefined;
  switch (condition.kind) {
    case 'generation_lease_expired':
      return { expression: 'leaseUntil < :now', values: { ':now': condition.now } };
    case 'posting_owner':
      return { expression: 'postingOwner = :owner', values: { ':owner': condition.owner } };
    case 'posting_guard_elapsed':
      return { expression: '(attribute_not_exists(postingUntil) OR postingUntil <= :now)', values: { ':now': condition.now } };
    case 'question_missing':
      return { expression: '(attribute_not_exists(question) OR question = :empty)', values: { ':empty': '' } };
  }
}
