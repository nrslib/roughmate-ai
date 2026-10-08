import { Firestore, Timestamp } from '@google-cloud/firestore';
import { changedDocument, documentFailure, matchesDocument, projectedDocument, type DocumentInput, type DocumentOperation, type DocumentOptions, type DocumentStore } from './document-store.js';
import { firestoreRpc } from './google-rpc.js';
export function encodeFirestoreDocument(item: object): { payload: string; expiresAt?: Timestamp } {
  const payload = JSON.stringify(item, function (this: unknown, _key, value: unknown) {
    if (value === undefined && Array.isArray(this)) throw new Error('document_value_invalid');
    if (typeof value === 'number' && !Number.isFinite(value) || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') throw new Error('document_value_invalid');
    return value;
  });
  if (Buffer.byteLength(payload, 'utf8') > 900_000) throw new Error('document_size_exceeded');
  const expiresAt = (item as Record<string, unknown>).expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new Error('document_expiry_invalid');
  return { payload, ...(typeof expiresAt === 'number' ? { expiresAt: Timestamp.fromMillis(expiresAt * 1000) } : {}) };
}
export function decodeFirestoreDocument(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  if (typeof data.payload !== 'string') throw new Error('document_payload_invalid');
  const item: unknown = JSON.parse(data.payload);
  if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).pk !== 'string') throw new Error('document_payload_invalid');
  return item as Record<string, unknown>;
}
export class FirestoreDocumentStore implements DocumentStore {
  constructor(private db: Firestore, private environment: string, private rpcTimeoutMs = 30_000) {}
  private reference(input: DocumentInput) {
    if (input.namespace !== this.environment && !new RegExp(`^${this.environment}-bot-[a-f0-9]{32}$`).test(input.namespace)) throw new Error('document_namespace_boundary');
    const key = input.key?.pk ?? (input.item as Record<string, unknown> | undefined)?.pk;
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1000) throw new Error('document_key_invalid');
    return this.db.collection('records').doc(Buffer.from(input.namespace + '\0' + key).toString('base64url'));
  }
  async get(input: DocumentInput, options?: DocumentOptions) {
    options?.abortSignal?.throwIfAborted();
    const snapshot = await firestoreRpc(this.rpcTimeoutMs, options, () => this.reference(input).get());
    options?.abortSignal?.throwIfAborted();
    return { item: projectedDocument(decodeFirestoreDocument(snapshot.data()), input) };
  }
  async put(input: DocumentInput, options?: DocumentOptions): Promise<void> { await this.write([{ put: input }], false, options); }
  async update(input: DocumentInput, options?: DocumentOptions): Promise<void> { await this.write([{ update: input }], false, options); }
  async delete(input: DocumentInput, options?: DocumentOptions) { const previous = await this.write([{ delete: input }], false, options); return { previous: input.returnPrevious ? previous[0] : undefined }; }
  async transaction(input: { operations: DocumentOperation[] }, options?: DocumentOptions): Promise<void> { await this.write(input.operations, true, options); }
  private async write(operations: DocumentOperation[], transaction: boolean, options?: DocumentOptions): Promise<(Record<string, unknown> | undefined)[]> {
    if (!operations.length || operations.length > 100) throw new Error('document_transaction_size');
    const inputs = operations.map(operation => 'check' in operation ? operation.check : 'put' in operation ? operation.put : 'update' in operation ? operation.update : operation.delete);
    const references = inputs.map(input => this.reference(input));
    if (new Set(references.map(ref => ref.path)).size !== references.length) throw new Error('document_transaction_duplicate');
    options?.abortSignal?.throwIfAborted();
    // Firestore may rerun this callback; it contains no external side effects.
    return firestoreRpc(this.rpcTimeoutMs, options, () => this.db.runTransaction(async tx => {
      options?.abortSignal?.throwIfAborted();
      const snapshots = await tx.getAll(...references);
      const previous = snapshots.map(snapshot => decodeFirestoreDocument(snapshot.data()));
      const failed = inputs.map((input, index) => !matchesDocument(previous[index], input.condition, input));
      if (failed.some(Boolean)) throw documentFailure(transaction, failed);
      options?.abortSignal?.throwIfAborted();
      operations.forEach((operation, index) => {
        if ('put' in operation) {
          if (!operation.put.item) throw new Error('document_item_missing');
          tx.set(references[index], encodeFirestoreDocument(operation.put.item));
        } else if ('update' in operation) tx.set(references[index], encodeFirestoreDocument(changedDocument(previous[index], operation.update)));
        else if ('delete' in operation) tx.delete(references[index]);
      });
      return previous;
    }, { maxAttempts: 1 }));
  }
}
