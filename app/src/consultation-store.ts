import type { Consultation } from './contracts.js';
import type { GroupConfig, GroupIdentity, KnowledgeCatalog } from './groups.js';
import type { WikiRoot } from './wiki-model.js';

export type ConsultationCondition =
  | { kind: 'generation_lease_expired'; now: number }
  | { kind: 'posting_owner'; owner: string }
  | { kind: 'posting_guard_elapsed'; now: number }
  | { kind: 'question_missing' };

export interface ConsultationStateStore {
  get(pk: string): Promise<Consultation | undefined>;
  transition(pk: string, from: Consultation['status'], patch: Partial<Consultation>, condition?: ConsultationCondition): Promise<boolean>;
}
export interface ConsultationStore extends ConsultationStateStore {
  createConsultation(config: GroupConfig, item: Consultation): Promise<boolean>;
}
export interface AnswerStore extends ConsultationStateStore {
  cancelAnswerClaim(item: Consultation): Promise<boolean>;
}
export interface AnswerClaimStore extends AnswerStore {
  claimAnswer(item: Consultation, patch: Partial<Consultation>, config: GroupConfig, catalog: KnowledgeCatalog): Promise<boolean>;
}
export interface DraftPublicationStore {
  reservePublication(config: GroupConfig, catalog: KnowledgeCatalog, owner: string): Promise<void>;
  releasePublication(owner: string): Promise<void>;
}
export interface ConsultationEvidenceStore {
  group(identity: GroupIdentity): Promise<GroupConfig>;
  knowledge(identity: GroupIdentity): Promise<KnowledgeCatalog>;
  wiki: {
    root(identity: GroupIdentity): Promise<WikiRoot>;
    get<T>(pk: string): Promise<T | undefined>;
  };
}
