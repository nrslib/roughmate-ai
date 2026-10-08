import { isDeepStrictEqual } from 'node:util';

export type Comparison = '=' | '<>' | '<' | '<=' | '>' | '>=';
export type DocumentCondition =
  | { kind: 'all' | 'any'; conditions: DocumentCondition[] }
  | { kind: 'group'; condition: DocumentCondition }
  | { kind: 'exists' | 'absent'; field: string }
  | { kind: 'compare'; field: string; comparison: Comparison; parameter: string }
  | { kind: 'contains'; field: string; parameter: string };
export type DocumentChange = { kind: 'set' | 'setAbsent'; field: string; parameter: string } | { kind: 'remove'; field: string };
export const c = {
  all: (...conditions: (DocumentCondition | undefined)[]): DocumentCondition => ({ kind: 'all', conditions: conditions.filter((value): value is DocumentCondition => value !== undefined) }),
  any: (...conditions: DocumentCondition[]): DocumentCondition => ({ kind: 'any', conditions }),
  group: (condition: DocumentCondition): DocumentCondition => ({ kind: 'group', condition }),
  exists: (field: string): DocumentCondition => ({ kind: 'exists', field }),
  absent: (field: string): DocumentCondition => ({ kind: 'absent', field }),
  compare: (field: string, comparison: Comparison, parameter: string): DocumentCondition => ({ kind: 'compare', field, comparison, parameter }),
  contains: (field: string, parameter: string): DocumentCondition => ({ kind: 'contains', field, parameter }),
  set: (field: string, parameter: string): DocumentChange => ({ kind: 'set', field, parameter }),
  setAbsent: (field: string, parameter: string): DocumentChange => ({ kind: 'setAbsent', field, parameter }),
  remove: (field: string): DocumentChange => ({ kind: 'remove', field })
};
export interface DocumentInput {
  namespace: string;
  key?: { pk: string };
  item?: object;
  condition?: DocumentCondition;
  changes?: DocumentChange[];
  fields?: Record<string, string>;
  parameters?: Record<string, unknown>;
  consistent?: boolean;
  projection?: string[];
  returnPrevious?: 'ALL_OLD';
}
export type DocumentOperation = { check: DocumentInput } | { put: DocumentInput } | { update: DocumentInput } | { delete: DocumentInput };
export interface DocumentOptions { abortSignal?: AbortSignal; }
export interface DocumentStore {
  get(input: DocumentInput, options?: DocumentOptions): Promise<{ item?: Record<string, unknown> }>;
  put(input: DocumentInput, options?: DocumentOptions): Promise<void>;
  update(input: DocumentInput, options?: DocumentOptions): Promise<void>;
  delete(input: DocumentInput, options?: DocumentOptions): Promise<{ previous?: Record<string, unknown> }>;
  transaction(input: { operations: DocumentOperation[] }, options?: DocumentOptions): Promise<void>;
}
export function documentField(field: string, input: DocumentInput): string {
  return field.split('.').map(part => {
    if (!part.startsWith('#')) return part;
    const resolved = input.fields?.[part];
    if (!resolved) throw new Error('document_field_missing');
    return resolved;
  }).join('.');
}
export function documentParameter(parameter: string, input: DocumentInput): unknown {
  if (!input.parameters || !Object.hasOwn(input.parameters, parameter) || input.parameters[parameter] === undefined) throw new Error('document_parameter_missing');
  return input.parameters[parameter];
}
function fieldValue(item: Record<string, unknown> | undefined, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, item);
}
export function matchesDocument(item: Record<string, unknown> | undefined, condition: DocumentCondition | undefined, input: DocumentInput): boolean {
  if (!condition) return true;
  switch (condition.kind) {
    case 'all': return condition.conditions.every(term => matchesDocument(item, term, input));
    case 'any': return condition.conditions.some(term => matchesDocument(item, term, input));
    case 'group': return matchesDocument(item, condition.condition, input);
    case 'exists': return fieldValue(item, documentField(condition.field, input)) !== undefined;
    case 'absent': return fieldValue(item, documentField(condition.field, input)) === undefined;
    case 'contains': {
      const stored = fieldValue(item, documentField(condition.field, input)), expected = documentParameter(condition.parameter, input);
      return Array.isArray(stored) ? stored.some(value => isDeepStrictEqual(value, expected)) : typeof stored === 'string' && typeof expected === 'string' && stored.includes(expected);
    }
    case 'compare': {
      const stored = fieldValue(item, documentField(condition.field, input)), expected = documentParameter(condition.parameter, input);
      if (stored === undefined) return false;
      if (condition.comparison === '=') return isDeepStrictEqual(stored, expected);
      if (condition.comparison === '<>') return !isDeepStrictEqual(stored, expected);
      let order: number;
      if (typeof stored === 'number' && typeof expected === 'number') order = Math.sign(stored - expected);
      else if (typeof stored === 'string' && typeof expected === 'string') order = stored < expected ? -1 : stored === expected ? 0 : 1;
      else return false;
      switch (condition.comparison) {
        case '<': return order < 0;
        case '<=': return order <= 0;
        case '>': return order > 0;
        case '>=': return order >= 0;
      }
    }
  }
}
export function changedDocument(previous: Record<string, unknown> | undefined, input: DocumentInput): Record<string, unknown> {
  if (!input.key || !input.changes?.length) throw new Error('document_update_missing');
  const next = structuredClone(previous ?? { pk: input.key.pk });
  for (const change of input.changes) {
    const field = documentField(change.field, input);
    if (field.includes('.')) throw new Error('document_nested_update_unsupported');
    if (change.kind === 'remove') delete next[field];
    else if (change.kind === 'set' || next[field] === undefined) next[field] = structuredClone(documentParameter(change.parameter, input));
  }
  return next;
}
export function documentFailure(transaction: boolean, failed: boolean[]): Error {
  return Object.assign(new Error('document_condition_failed'), { name: transaction ? 'TransactionCanceledException' : 'ConditionalCheckFailedException', CancellationReasons: failed.map(value => ({ Code: value ? 'ConditionalCheckFailed' : 'None' })) });
}

export function projectedDocument(item: Record<string, unknown> | undefined, input: DocumentInput): Record<string, unknown> | undefined {
  if (!item || !input.projection) return item;
  const result: Record<string, unknown> = {};
  for (const path of input.projection) {
    const field = documentField(path, input), value = fieldValue(item, field);
    if (value === undefined) continue;
    const parts = field.split('.'); let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!target[part]) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return result;
}
