import { isDeepStrictEqual } from 'node:util';
import { AppError, object } from '../../app/src/contracts.js';
import type { SetupAws } from './aws.js';
import type { Target } from './config.js';
import { validatePlan, type PurgePlan } from './purge-model.js';
export interface PurgeAnchor {
  schemaVersion: 1;
  application: 'roughmate-purge-anchor';
  phase: 'planned' | 'slack' | 'verified' | 'history';
  plan: PurgePlan;
}
export function anchorKey(aws: SetupAws): string { return `environments/${aws.target.environment}/protected-purge/anchor.json`; }
export function validateAnchor(raw: unknown, target: Target): PurgeAnchor {
  const value = object(raw);
  if (Object.keys(value).sort().join(',') !== 'application,phase,plan,schemaVersion' || value.schemaVersion !== 1 || value.application !== 'roughmate-purge-anchor' || !['planned', 'slack', 'verified', 'history'].includes(String(value.phase)))
    throw new AppError('purge_journal');
  const plan = validatePlan(value.plan, target);
  if (plan.stage !== ({ planned: 'planned', slack: 'slack', verified: 'aws', history: 'history' } as const)[value.phase as PurgeAnchor['phase']])
    throw new AppError('purge_journal');
  return value as unknown as PurgeAnchor;
}
export function reconcileAnchor(plan: PurgePlan, anchor: PurgeAnchor): PurgePlan {
  const proof = anchor.plan;
  if (plan.id !== proof.id || !isDeepStrictEqual(plan.target, proof.target) || !isDeepStrictEqual(plan.descriptor, proof.descriptor) || !isDeepStrictEqual(plan.rootHistory,proof.rootHistory) || plan.ownerId !== proof.ownerId || plan.teamId !== proof.teamId)
    throw new AppError('purge_journal');
  const match = (a: unknown[], b: unknown[]) => a.length === b.length && a.every(item => b.some(other => isDeepStrictEqual(item, other)));
  if (['planned', 'stopped'].includes(plan.stage) && anchor.phase === 'slack') {
    if (!plan.apps.every(app => proof.apps.some(saved => isDeepStrictEqual(app, saved))) || !plan.resources.every(resource => proof.resources.some(saved => isDeepStrictEqual(resource, saved))))
      throw new AppError('purge_journal');
    return { ...plan, apps: proof.apps, resources: proof.resources, stage: 'slack' };
  }
  if (!match(plan.apps, proof.apps) || !match(plan.resources, proof.resources))
    throw new AppError('purge_journal');
  const valid = anchor.phase === 'planned' ? ['planned', 'stopped'] : anchor.phase === 'slack' ? ['slack'] : anchor.phase === 'verified' ? ['slack', 'aws', 'history'] : ['history'];
  if (!valid.includes(plan.stage))
    throw new AppError('purge_journal');
  return plan;
}
