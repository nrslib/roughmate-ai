import { AwsDocumentStore } from './aws-document-store.js';
import type { DocumentStore } from './document-store.js';
import type { SecretStore, JobQueue, ChildResourceManager } from './runtime-ports.js';
import { AwsSecretStore, AwsJobQueue, AwsChildResources } from './aws-runtime.js';
export interface Runtime {
  documents(region?: string): DocumentStore;
  secrets(region?: string): SecretStore;
  queue(region?: string): JobQueue;
  children: ChildResourceManager;
}
const aws: Runtime = { documents: region => new AwsDocumentStore(region), secrets: region => new AwsSecretStore(region), queue: region => new AwsJobQueue(region), children: new AwsChildResources() };
let selected: Runtime = aws;
export function runtime(): Runtime { return selected; }
export function configureRuntime(value: Runtime): void { selected = value; }
