export class AppError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('invalid_input');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('invalid_input');
  return value;
}
export function env(name: string): string { return string(process.env[name]); }
export interface Workspace { teamId: string; ownerId: string; channelId?: string; settingsVersion?: number; settingsRequestId?: string; settingsNoticeUntil?: number; settingsNoticeOwner?: string; }
interface SecretSettings { appId: string; clientId: string; clientSecret: string; signingSecret: string; model: string; apiKey: string; botScopes?: string[]; rootOAuth?: { requestId: string; teamId: string; ownerId: string }; }
export type InstalledSecrets = SecretSettings & { botToken: string; botUserId: string };
export type Secrets = InstalledSecrets | (SecretSettings & { botToken?: undefined; botUserId?: undefined });
export function validateSecrets(raw: unknown): Secrets {
  const value = object(raw);
  for (const key of ['appId','clientId','clientSecret','signingSecret','model','apiKey']) string(value[key]);
  if (value.botToken !== undefined || value.botUserId !== undefined) {
    if (typeof value.botToken !== 'string' || !value.botToken.trim() || typeof value.botUserId !== 'string' || !value.botUserId.trim()) throw new AppError('invalid_bot_credentials');
  }
  return value as unknown as Secrets;
}
export function requireInstalledSecrets(secrets: Secrets): InstalledSecrets {
  if (secrets.botToken === undefined) throw new AppError('bot_not_installed');
  return secrets;
}
export interface Consultation {
  question?: string; questionCapture?:import('./wiki-model.js').QuestionEvidence; wikiAnswerId?: string;
  pk: string; environmentId?: string; appId?: string; knowledgeReferences?: import('./groups.js').KnowledgeReference[]; groupName?: string; teamId: string; sourceChannel: string; sourceTs: string; mentionTs: string; requesterId?:string;
  configVersion?: number; reviewChannel: string; reviewTs?: string; draftTs?: string; draft?: string;
  status: 'generating' | 'draft' | 'posting' | 'sent' | 'uncertain';
  leaseUntil?: number; postingUntil?: number; postingOwner?: string; answer?: string; actorId?: string; answerTs?: string;
  answerCancellation?: AnswerCancellation;
  stoppedAnswerReconciliation?: { stopId: string; postingOwner: string; publicationUntil: number; startedAt: number; completedAt: number; result: 'not_found'; };
}
export const workerDrainSeconds = 150;
export interface AnswerCancellation {
  postingOwner: string; actorId: string; postingUntil: number;
  environmentId: string; appId: string; teamId: string; configVersion: number; draftTs: string;
}
export interface QueueJob { kind: 'mention' | 'home' | 'settings' | 'review' | 'reconcile' | 'knowledge' | 'wiki' | 'wiki_ui' | 'wiki_command' | 'wiki_adoption' | 'wiki_archive_retention'; botId?: string; payload: Record<string, unknown>; }

export const metadataEvents = { consultation: 'roughmate_consultation', draft: 'roughmate_draft', notification: 'roughmate_notification', answer: 'roughmate_answer' } as const;
