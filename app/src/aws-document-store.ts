import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DocumentStore, DocumentInput, DocumentCondition, DocumentOptions, DocumentOperation } from './document-store.js';
function conditionExpression(condition: DocumentCondition): string {
  switch (condition.kind) {
    case 'all': return condition.conditions.map(conditionExpression).join(' AND ');
    case 'any': return condition.conditions.map(conditionExpression).join(' OR ');
    case 'group': return '(' + conditionExpression(condition.condition) + ')';
    case 'exists': return `attribute_exists(${condition.field})`;
    case 'absent': return `attribute_not_exists(${condition.field})`;
    case 'compare': return `${condition.field} ${condition.comparison} ${condition.parameter}`;
    case 'contains': return `contains(${condition.field}, ${condition.parameter})`;
  }
}
function dynamoInput(input: DocumentInput) {
  const sets = input.changes?.filter(term => term.kind !== 'remove').map(term => {
    return `${term.field} = ${term.kind === 'setAbsent' ? `if_not_exists(${term.field}, ${term.parameter})` : term.parameter}`;
  }) ?? [];
  const removes = input.changes?.filter(term => term.kind === 'remove').map(term => term.field) ?? [];
  const update = (sets.length ? 'SET ' + sets.join(', ') : '') + (removes.length ? (sets.length ? ' ' : '') + 'REMOVE ' + removes.join(', ') : '');
  return { TableName: input.namespace, ...(input.key ? { Key: input.key } : {}), ...(input.item ? { Item: input.item } : {}), ...(input.condition ? { ConditionExpression: conditionExpression(input.condition) } : {}), ...(update ? { UpdateExpression: update } : {}), ...(input.fields ? { ExpressionAttributeNames: input.fields } : {}), ...(input.parameters ? { ExpressionAttributeValues: input.parameters } : {}), ...(input.consistent ? { ConsistentRead: true } : {}), ...(input.projection ? { ProjectionExpression: input.projection.join(', ') } : {}) };
}
export class AwsDocumentStore implements DocumentStore {
  private db: DynamoDBDocumentClient;
  constructor(region?: string) {
    this.db = DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 1, requestHandler: { requestTimeout: 900, throwOnRequestTimeout: true, connectionTimeout: 500 } }));
  }
  async get(input: DocumentInput, options?: DocumentOptions) { const result = await this.db.send(new GetCommand({ ...dynamoInput(input), Key: input.key }), options); return { item: result.Item }; }
  async put(input: DocumentInput, options?: DocumentOptions): Promise<void> { const next = dynamoInput(input); if (!next.Item) throw new Error('document_item_missing'); await this.db.send(new PutCommand({ ...next, Item: next.Item }), options); }
  async update(input: DocumentInput, options?: DocumentOptions): Promise<void> { const next = dynamoInput(input); if (!next.Key || !next.UpdateExpression) throw new Error('document_update_missing'); await this.db.send(new UpdateCommand({ ...next, Key: next.Key }), options); }
  async delete(input: DocumentInput, options?: DocumentOptions) { const next = dynamoInput(input); if (!next.Key) throw new Error('document_key_missing'); const result = await this.db.send(new DeleteCommand({ ...next, Key: next.Key, ...(input.returnPrevious ? { ReturnValues: input.returnPrevious } : {}) }), options); return { previous: result.Attributes }; }
  async transaction(input: { operations: DocumentOperation[] }, options?: DocumentOptions): Promise<void> {
    const writes = input.operations.map(operation => {
      if ('put' in operation) { const next = dynamoInput(operation.put); if (!next.Item) throw new Error('document_item_missing'); return { Put: { ...next, Item: next.Item } }; }
      if ('update' in operation) { const next = dynamoInput(operation.update); if (!next.Key || !next.UpdateExpression) throw new Error('document_update_missing'); return { Update: { ...next, Key: next.Key, UpdateExpression: next.UpdateExpression } }; }
      if ('delete' in operation) { const next = dynamoInput(operation.delete); if (!next.Key) throw new Error('document_key_missing'); return { Delete: { ...next, Key: next.Key } }; }
      const next = dynamoInput(operation.check); if (!next.Key || !next.ConditionExpression) throw new Error('document_check_missing'); return { ConditionCheck: { ...next, Key: next.Key, ConditionExpression: next.ConditionExpression } };
    });
    await this.db.send(new TransactWriteCommand({ TransactItems: writes }), options);
  }
}
