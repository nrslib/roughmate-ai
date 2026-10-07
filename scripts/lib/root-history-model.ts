import { AppError, object, string } from '../../app/src/contracts.js';
export interface RootHistory {
  genesisId: string;
  tableId: string;
  appIds: string[];
  generationCount: number;
  ownerId?: string;
  teamId?: string;
}
export function validateRootHistory(raw: unknown): RootHistory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AppError('purge_root_history');
  const value = object(raw);
  if (Object.keys(value).some(key => !['genesisId', 'tableId', 'appIds', 'generationCount', 'ownerId', 'teamId'].includes(key)) || !/^[a-f0-9-]{36}$/.test(string(value.genesisId)) || !/^[a-f0-9-]{36}$/.test(string(value.tableId)) || !Array.isArray(value.appIds) || value.appIds.some(id => typeof id !== 'string' || !/^A[A-Z0-9]+$/.test(id)) || new Set(value.appIds).size !== value.appIds.length || value.generationCount !== value.appIds.length || value.ownerId !== undefined && !/^[UW][A-Z0-9]+$/.test(string(value.ownerId)) || value.teamId !== undefined && !/^T[A-Z0-9]+$/.test(string(value.teamId)) || (value.ownerId === undefined) !== (value.teamId === undefined))
    throw new AppError('purge_root_history');
  return value as unknown as RootHistory;
}
export function advanceRootHistory(history: RootHistory | undefined, appId: string): RootHistory | undefined {
  if (!history)
    return undefined;
  const previous = validateRootHistory(history);
  if (previous.appIds.includes(appId))
    return previous;
  return validateRootHistory({ ...previous, appIds: [...previous.appIds, appId], generationCount: previous.generationCount + 1 });
}
