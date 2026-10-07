import type { PurgePlan } from './purge-model.js';
import { advanceRootHistory, validateRootHistory, type RootHistory } from './root-history-model.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AppError, object, string } from '../../app/src/contracts.js';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SetupAws } from './aws.js';
import type { Descriptor, Target } from './config.js';
import { location, validateDescriptor } from './config.js';
import { readStateJson } from './purge-journal.js';
import { environmentFence, environmentSignal, environmentLeaseKey } from './environment-lease.js';
import { PurgeAwsCli } from './purge-inventory.js';
interface Genesis {
  schemaVersion: 1;
  application: 'roughmate-root-genesis';
  target: Target;
  id: string;
  tableId?: string;
  ledgerPhase?: 'pending' | 'initialized';
}
export function genesisKey(target: Target): string { return `environments/${target.environment}/protected-purge/root-genesis.json`; }
function validateGenesis(raw: unknown, target: Target): Genesis {
  const value = object(raw), saved = object(value.target);
  if (Object.keys(value).some(key => !['schemaVersion', 'application', 'target', 'id', 'tableId', 'ledgerPhase'].includes(key)) || value.schemaVersion !== 1 || value.application !== 'roughmate-root-genesis' || Object.keys(saved).sort().join(',') !== 'accountId,environment,region' || saved.accountId !== target.accountId || saved.region !== target.region || saved.environment !== target.environment || !/^[a-f0-9-]{36}$/.test(string(value.id)) || value.tableId !== undefined && !/^[a-f0-9-]{36}$/.test(string(value.tableId)) || value.ledgerPhase !== undefined && (!value.tableId || !['pending','initialized'].includes(String(value.ledgerPhase))))
    throw new AppError('purge_root_history');
  return value as unknown as Genesis;
}
export async function readRootGenesis(aws: SetupAws): Promise<{value: Genesis; etag: string; versionId: string} | undefined> {
  try { return await genesisVersions(aws); }
  catch(error) { if(error instanceof AppError) throw error; throw new AppError('purge_state_unavailable'); }
}
async function genesisVersions(aws: SetupAws): Promise<{value: Genesis; etag: string; versionId: string} | undefined> {
  const key = genesisKey(aws.target), saved = await readStateJson(aws, key), current = saved ? validateGenesis(saved.value, aws.target) : undefined;
  const versions: Genesis[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let keyMarker: string | undefined, versionMarker: string | undefined;
  for (;;) {
    const page = await aws.s3.send(new ListObjectVersionsCommand({ Bucket: location(aws.target).bucket, Prefix: key, ExpectedBucketOwner: aws.target.accountId, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: environmentSignal() });
    if ((page.DeleteMarkers ?? []).some(marker => !marker.Key?.startsWith(key) || !marker.VersionId || marker.Key === key))
      throw new AppError('purge_root_history');
    for (const version of page.Versions ?? []) {
      if (!version.Key?.startsWith(key) || !version.VersionId) throw new AppError('purge_root_history');
      if (version.Key !== key)
        continue;
      if (!version.VersionId || ids.has(version.VersionId))
        throw new AppError('purge_root_history');
      ids.add(version.VersionId);
      const raw = await aws.s3.send(new GetObjectCommand({ Bucket: location(aws.target).bucket, Key: key, VersionId: version.VersionId, ExpectedBucketOwner: aws.target.accountId }), { abortSignal: environmentSignal() });
      const value = validateGenesis(JSON.parse(string(await raw.Body?.transformToString())), aws.target);
      if (!current || value.id !== current.id || value.tableId !== undefined && value.tableId !== current.tableId || versions.length === 0 && (version.VersionId !== saved?.versionId || value.tableId !== current.tableId || value.ledgerPhase !== current.ledgerPhase))
        throw new AppError('purge_root_history');
      versions.push(value);
    }
    if (!page.IsTruncated)
      break;
    if (!page.NextKeyMarker || cursors.has(`${page.NextKeyMarker}:${page.NextVersionIdMarker}`))
      throw new AppError('purge_history');
    keyMarker = page.NextKeyMarker; versionMarker = page.NextVersionIdMarker; cursors.add(`${keyMarker}:${versionMarker}`);
  }
  if (saved && !ids.has(saved.versionId))
    throw new AppError('purge_root_history');
  // S3 returns each key's versions newest first. A binding must never revert to unbound.
  let bound = false, phase = 0;
  for (const version of [...versions].reverse()) {
    const next = version.ledgerPhase === 'initialized' ? 3 : version.ledgerPhase === 'pending' ? 2 : version.tableId ? 1 : 0;
    if (next < phase) throw new AppError('purge_root_history');
    phase = next;
    if (version.tableId !== undefined) bound = true;
    else if (bound) throw new AppError('purge_root_history');
  }
  return saved && current ? {...saved,value:current} : undefined;
}
interface RootLedger {
  schemaVersion: 1;
  application: 'roughmate-root-ledger';
  target: Target;
  history: RootHistory;
  pending?: string;
}
export function rootLedgerKey(target: Target): string { return `environments/${target.environment}/protected-purge/root-ledger.json`; }
export async function rootEnrollment(aws: SetupAws): Promise<boolean> {
  const saved = await readStateJson(aws,genesisKey(aws.target));
  if (saved) validateGenesis(saved.value,aws.target);
  return !!saved;
}
function validateLedger(raw: unknown, target: Target): RootLedger {
  const value = object(raw), saved = object(value.target);
  if (Object.keys(value).some(key=>!['schemaVersion','application','target','history','pending'].includes(key)) || value.schemaVersion !== 1 || value.application !== 'roughmate-root-ledger' || Object.keys(saved).sort().join(',') !== 'accountId,environment,region' || saved.accountId !== target.accountId || saved.region !== target.region || saved.environment !== target.environment || value.pending !== undefined && !/^[a-f0-9-]{36}$/.test(string(value.pending))) throw new AppError('purge_root_history');
  return {...value,history:validateRootHistory(value.history)} as unknown as RootLedger;
}
function sameHistory(left: RootHistory, right: RootHistory): boolean {
  return left.genesisId === right.genesisId && left.tableId === right.tableId && left.appIds.join(',') === right.appIds.join(',') && (!left.ownerId || left.ownerId === right.ownerId && left.teamId === right.teamId);
}
export async function readRootLedger(aws: SetupAws): Promise<{value: RootLedger; etag: string; versionId: string} | undefined> {
  try {
    const key = rootLedgerKey(aws.target), saved = await readStateJson(aws,key), current = saved ? validateLedger(saved.value,aws.target) : undefined;
    const versions: RootLedger[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let keyMarker: string | undefined, versionMarker: string | undefined;
    for (;;) {
      const page = await aws.s3.send(new ListObjectVersionsCommand({Bucket:location(aws.target).bucket,Prefix:key,ExpectedBucketOwner:aws.target.accountId,KeyMarker:keyMarker,VersionIdMarker:versionMarker}),{abortSignal:environmentSignal()});
      if ((page.DeleteMarkers??[]).some(marker=>!marker.Key?.startsWith(key)||!marker.VersionId||marker.Key===key)) throw new AppError('purge_root_history');
      for (const version of page.Versions??[]) {
        if (!version.Key?.startsWith(key)||!version.VersionId) throw new AppError('purge_root_history');
        if (version.Key!==key) continue;
        if (ids.has(version.VersionId)) throw new AppError('purge_root_history');
        ids.add(version.VersionId);
        const raw = await aws.s3.send(new GetObjectCommand({Bucket:location(aws.target).bucket,Key:key,VersionId:version.VersionId,ExpectedBucketOwner:aws.target.accountId}),{abortSignal:environmentSignal()});
        const value = validateLedger(JSON.parse(string(await raw.Body?.transformToString())),aws.target);
        if (!current || value.history.genesisId!==current.history.genesisId || value.history.tableId!==current.history.tableId || versions.length===0 && (version.VersionId!==saved?.versionId || JSON.stringify(value)!==JSON.stringify(current))) throw new AppError('purge_root_history');
        versions.push(value);
      }
      if (!page.IsTruncated) break;
      if (!page.NextKeyMarker||cursors.has(`${page.NextKeyMarker}:${page.NextVersionIdMarker}`)) throw new AppError('purge_history');
      keyMarker=page.NextKeyMarker;versionMarker=page.NextVersionIdMarker;cursors.add(`${keyMarker}:${versionMarker}`);
    }
    if (saved&&!ids.has(saved.versionId)) throw new AppError('purge_root_history');
    const chronological=[...versions].reverse();
    for (let index=1;index<chronological.length;index++) {
      const before=chronological[index-1],after=chronological[index],older=before.history,newer=after.history;
      if (older.appIds.some((id,i)=>newer.appIds[i]!==id)||newer.generationCount<older.generationCount||older.ownerId&&(older.ownerId!==newer.ownerId||older.teamId!==newer.teamId)) throw new AppError('purge_root_history');
      if (before.pending) {
        if (after.pending ? after.pending!==before.pending||!sameHistory(older,newer) : newer.generationCount!==older.generationCount+1) throw new AppError('purge_root_history');
      }
      else if (!sameHistory(older,newer)) throw new AppError('purge_root_history');
    }
    return saved&&current?{...saved,value:current}:undefined;
  }
  catch(error) {if(error instanceof AppError)throw error;throw new AppError('purge_state_unavailable');}
}
async function writeLedger(aws: SetupAws, history: RootHistory, pending: string | undefined, etag?: string): Promise<void> {
  await environmentFence();
  try {
    await aws.s3.send(new PutObjectCommand({Bucket:location(aws.target).bucket,Key:rootLedgerKey(aws.target),ExpectedBucketOwner:aws.target.accountId,Body:JSON.stringify({schemaVersion:1,application:'roughmate-root-ledger',target:aws.target,history,...(pending?{pending}:{})}),ContentType:'application/json',ServerSideEncryption:'AES256',...(etag?{IfMatch:etag}:{IfNoneMatch:'*'})}),{abortSignal:environmentSignal()});
  }
  catch {throw new AppError('purge_state_unavailable');}
}
export async function protectedRootHistory(aws: SetupAws): Promise<RootHistory> {
  const genesis=await readRootGenesis(aws),ledger=await readRootLedger(aws);
  if (!genesis||!ledger||genesis.value.ledgerPhase==='pending'||ledger.value.pending||genesis.value.id!==ledger.value.history.genesisId||genesis.value.tableId!==ledger.value.history.tableId) throw new AppError('purge_root_history');
  return ledger.value.history;
}
export async function requireRootTableHistory(aws: SetupAws, history: RootHistory, allowAbsent = false, cli?: PurgeAwsCli): Promise<void> {
  const current=await tableId(aws,cli);
  if (!(allowAbsent&&!current)&&current!==history.tableId) throw new AppError('purge_root_history');
}
export async function bindPurgeRootOwner(aws: SetupAws, history: RootHistory, ownerId: string, teamId: string): Promise<void> {
  const protectedHistory=await protectedRootHistory(aws),saved=await readRootLedger(aws);
  if (!saved||!sameHistory(protectedHistory,history)||protectedHistory.ownerId&&(protectedHistory.ownerId!==ownerId||protectedHistory.teamId!==teamId)) throw new AppError('purge_root_history');
  if (!protectedHistory.ownerId) await writeLedger(aws,validateRootHistory({...protectedHistory,ownerId,teamId}),undefined,saved.etag);
}
export async function validateSavedRootHistory(aws: SetupAws, cli: PurgeAwsCli, plan: PurgePlan): Promise<void> {
  const current=await tableId(aws,cli);
  if (current&&current!==plan.rootHistory.tableId) throw new AppError('purge_root_history');
  // During final history erasure, the validated protected plan/anchor outlive upstream records.
  if (!current&&plan.stage==='history') return;
  const genesis=await readRootGenesis(aws),ledger=await readRootLedger(aws);
  if (!genesis||!ledger||genesis.value.ledgerPhase==='pending'||ledger.value.pending) throw new AppError('purge_root_history');
  const saved=ledger.value.history,frozen=plan.rootHistory;
  if (genesis.value.id!==frozen.genesisId||genesis.value.tableId!==frozen.tableId||saved.genesisId!==frozen.genesisId||saved.tableId!==frozen.tableId||saved.generationCount!==frozen.generationCount||saved.appIds.join(',')!==frozen.appIds.join(',')||saved.ownerId!==plan.ownerId||saved.teamId!==plan.teamId||frozen.ownerId!==plan.ownerId||frozen.teamId!==plan.teamId||saved.appIds.some(id=>!plan.apps.some(app=>!app.registrationId&&app.appId===id))) throw new AppError('purge_root_history');
}
async function inspectRootCreation(aws: SetupAws, progress: Record<string,unknown> | undefined, recoverAppId?: string): Promise<{history:RootHistory;reservationEtag?:string} | undefined> {
  if (!await rootEnrollment(aws)) {
    if (progress?.rootHistory) throw new AppError('purge_root_history');
    return undefined;
  }
  const cli=new PurgeAwsCli(aws.target);await cli.authorizeAdmin(await cli.call('sts','get-caller-identity',{}));
  const genesis=await readRootGenesis(aws),ledger=await readRootLedger(aws);
  if (!genesis||!ledger||genesis.value.ledgerPhase==='pending'||genesis.value.id!==ledger.value.history.genesisId||genesis.value.tableId!==ledger.value.history.tableId) throw new AppError('purge_root_history');
  const history=ledger.value.history;
  await requireRootTableHistory(aws,history);
  const ordinary=progress?.rootHistory?validateRootHistory(progress.rootHistory):undefined;
  const committedRecovery=!!recoverAppId&&!ledger.value.pending&&history.appIds.at(-1)===recoverAppId&&progress?.phase==='creating'&&!!ordinary&&sameHistory({...history,appIds:history.appIds.slice(0,-1),generationCount:history.generationCount-1},ordinary);
  if (ordinary ? !sameHistory(history,ordinary)&&!committedRecovery : history.appIds.length>0&&!ledger.value.pending) throw new AppError('purge_root_history');
  if ([progress?.appId,progress?.retiredAppId].some(id=>id&&!history.appIds.includes(String(id)))||recoverAppId&&history.appIds.includes(recoverAppId)&&!committedRecovery) throw new AppError('purge_root_history');
  if (committedRecovery) return {history};
  if (ledger.value.pending) {
    if (!recoverAppId) throw new AppError('slack_creation_ambiguous');
    return {history};
  }
  if (progress?.phase==='creating'||recoverAppId) throw new AppError('purge_root_history');
  const owner=progress?.rootHistory?validateRootHistory(progress.rootHistory):undefined;
  const next=validateRootHistory({...history,...(!history.ownerId&&owner?.ownerId?{ownerId:owner.ownerId,teamId:owner.teamId}:{})});
  return {history:next,reservationEtag:ledger.etag};
}
export async function validateRootCreation(aws: SetupAws, progress: Record<string,unknown> | undefined, recoverAppId?: string, expected?: {history:RootHistory|undefined}): Promise<RootHistory | undefined> {
  const history=(await inspectRootCreation(aws,progress,recoverAppId))?.history;
  if (expected && !isDeepStrictEqual(history,expected.history)) throw new AppError('purge_root_history');
  return history;
}
export async function prepareRootCreation(aws: SetupAws, progress: Record<string,unknown> | undefined, recoverAppId?: string, expected?: {history:RootHistory|undefined}): Promise<RootHistory | undefined> {
  const state=await inspectRootCreation(aws,progress,recoverAppId);
  if (expected && !isDeepStrictEqual(state?.history,expected.history)) throw new AppError('purge_root_history');
  if (state?.reservationEtag) await writeLedger(aws,state.history,randomUUID(),state.reservationEtag);
  return state?.history;
}
export async function finishRootCreation(aws: SetupAws, appId: string, expected?: RootHistory): Promise<RootHistory> {
  const ledger=await readRootLedger(aws);
  const genesis=await readRootGenesis(aws);
  if (!ledger || !genesis || genesis.value.ledgerPhase==='pending' || genesis.value.id!==ledger.value.history.genesisId || genesis.value.tableId!==ledger.value.history.tableId || expected && !isDeepStrictEqual(ledger.value.history,expected)) throw new AppError('purge_root_history');
  await requireRootTableHistory(aws,ledger.value.history);
  if (ledger&&!ledger.value.pending&&ledger.value.history.appIds.at(-1)===appId) return ledger.value.history;
  if (!ledger?.value.pending||ledger.value.history.appIds.includes(appId)) throw new AppError('purge_root_history');
  const history=advanceRootHistory(ledger.value.history,appId)!;
  await writeLedger(aws,history,undefined,ledger.etag);
  return history;
}
async function existingRootHistory(aws: SetupAws, genesis: Genesis, id: string, progress: Record<string, unknown>): Promise<RootHistory> {
  if (progress.phase === 'creating')
    throw new AppError('slack_creation_ambiguous');
  const history = validateRootHistory(progress.rootHistory), protectedHistory = await protectedRootHistory(aws);
  if (!sameHistory(protectedHistory,history)) throw new AppError('purge_root_history');
  if (history.genesisId !== genesis.id || genesis.tableId !== id || history.tableId !== id || progress.phase === 'created' && progress.retiredAppId === progress.appId || !['created','deleted'].includes(String(progress.phase)) || !history.appIds.includes(String(progress.appId)) || progress.retiredAppId !== undefined && !history.appIds.includes(String(progress.retiredAppId)) || history.appIds.length > 1 && !history.ownerId)
    throw new AppError('purge_root_history');
  const workspace = (await aws.db.send(new GetCommand({ TableName: `roughmate-${aws.target.environment}`, Key: {pk:'workspace'}, ConsistentRead: true }), {abortSignal:environmentSignal()})).Item;
  if (workspace) {
    if (!/^[UW][A-Z0-9]+$/.test(String(workspace.ownerId)) || !/^T[A-Z0-9]+$/.test(String(workspace.teamId)) || history.ownerId && history.ownerId !== workspace.ownerId || history.teamId && history.teamId !== workspace.teamId)
      throw new AppError('purge_root_history');
  }
  else if (progress.phase === 'deleted' && !history.ownerId || progress.phase === 'created' && history.ownerId)
    throw new AppError('purge_root_history');
  return history;
}
async function tableId(aws: SetupAws, cli = new PurgeAwsCli(aws.target)): Promise<string | undefined> {
  const raw = await cli.optional('dynamodb', 'describe-table', { TableName: `roughmate-${aws.target.environment}` }, ['ResourceNotFoundException']);
  if (!raw)
    return undefined;
  const table = object(raw.Table), arn = `arn:aws:dynamodb:${aws.target.region}:${aws.target.accountId}:table/roughmate-${aws.target.environment}`;
  if (table.TableArn !== arn || typeof table.TableId !== 'string' || !/^[a-f0-9-]{36}$/.test(table.TableId))
    throw new AppError('purge_root_history');
  return string(table.TableId);
}
async function requireColdRoot(aws: SetupAws, genesis: Genesis, id: string, descriptor?: Descriptor): Promise<void> {
  const ledger=await readRootLedger(aws);
  if (ledger) {
    if (ledger.value.pending||ledger.value.history.genesisId!==genesis.id||ledger.value.history.tableId!==id||ledger.value.history.generationCount!==0||ledger.value.history.ownerId) throw new AppError('purge_root_history');
  }
  else if (genesis.ledgerPhase==='initialized'||genesis.tableId&&genesis.ledgerPhase!=='pending') throw new AppError('purge_root_history');
  const cli=new PurgeAwsCli(aws.target),cursors=new Set<string>();let cursor:Record<string,unknown>|undefined, registrySeen=false;
  do {
    const page=await aws.db.send(new ScanCommand({TableName:`roughmate-${aws.target.environment}`,ConsistentRead:true,ExclusiveStartKey:cursor}),{abortSignal:environmentSignal()});
    if (!Array.isArray(page.Items)) throw new AppError('purge_root_history');
    for (const item of page.Items) {
      // 定期rotateは初回Root作成前にも空の登録台帳を保存できる。
      if (registrySeen || Object.keys(item).sort().join(',') !== 'entries,parentSecret,pk,version' || item.pk !== 'registrations' || !Number.isSafeInteger(item.version) || item.version < 1 || !Array.isArray(item.entries) || item.entries.length) throw new AppError('purge_root_history');
      const secretArn = descriptor ? validateDescriptor(descriptor, aws.target).secretArn : (await cli.call('secretsmanager','describe-secret',{SecretId:`roughmate-${aws.target.environment}/runtime`})).ARN;
      const prefix = `arn:aws:secretsmanager:${aws.target.region}:${aws.target.accountId}:secret:roughmate-${aws.target.environment}/runtime-`;
      if (typeof secretArn !== 'string' || !secretArn.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(secretArn.slice(prefix.length)) || item.parentSecret !== secretArn) throw new AppError('purge_root_history');
      registrySeen = true;
    }
    cursor=page.LastEvaluatedKey;
    if (cursor) {const key=JSON.stringify(cursor);if(cursors.has(key))throw new AppError('purge_root_history');cursors.add(key);}
  } while(cursor);
  const secret=await cli.optional('secretsmanager','get-secret-value',{SecretId:`roughmate-${aws.target.environment}/runtime`},['ResourceNotFoundException']);
  if (secret) throw new AppError('purge_root_history');
}
export async function beginRootHistory(aws: SetupAws): Promise<Genesis> {
  const saved = await readRootGenesis(aws);
  if (saved) {
    const genesis = validateGenesis(saved.value, aws.target), id = await tableId(aws);
    if (genesis.tableId && id !== genesis.tableId)
      throw new AppError('purge_root_history');
    if (!id) {
      if (await readRootLedger(aws)) throw new AppError('purge_root_history');
      const secret=await new PurgeAwsCli(aws.target).optional('secretsmanager','get-secret-value',{SecretId:`roughmate-${aws.target.environment}/runtime`},['ResourceNotFoundException']);
      if (secret) throw new AppError('purge_root_history');
    }
    if (id) {
      const progress = (await aws.db.send(new GetCommand({ TableName: `roughmate-${aws.target.environment}`, Key: { pk: 'setup#slack' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
      if (progress) {
        await existingRootHistory(aws,genesis,id,progress);
      }
      else {
        await requireColdRoot(aws,genesis,id);
      }
    }
    return genesis;
  }
  const key = environmentLeaseKey(aws), lease = await readStateJson(aws, key), owner = object(lease?.value).leaseOwner;
  let keyMarker: string | undefined, versionMarker: string | undefined;
  const cursors = new Set<string>();
  let leaseSeen = false;
  for (;;) {
    const page = await aws.s3.send(new ListObjectVersionsCommand({ Bucket: location(aws.target).bucket, Prefix: `environments/${aws.target.environment}/`, ExpectedBucketOwner: aws.target.accountId, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), { abortSignal: environmentSignal() });
    if ((page.Versions ?? []).some(version => version.Key === key && version.VersionId === lease?.versionId))
      leaseSeen = true;
    if ((page.DeleteMarkers ?? []).length || (page.Versions ?? []).some(version => version.Key !== key || version.VersionId !== lease?.versionId))
      throw new AppError('purge_root_history');
    if (!owner)
      throw new AppError('environment_lease_lost');
    if (!page.IsTruncated)
      break;
    if (!page.NextKeyMarker || cursors.has(`${page.NextKeyMarker}:${page.NextVersionIdMarker}`))
      throw new AppError('purge_history');
    keyMarker = page.NextKeyMarker;
    versionMarker = page.NextVersionIdMarker;
    cursors.add(`${keyMarker}:${versionMarker}`);
  }
  if (!leaseSeen)
    throw new AppError('purge_root_history');
  if (await tableId(aws))
    throw new AppError('purge_root_history');
  const genesis: Genesis = { schemaVersion: 1, application: 'roughmate-root-genesis', target: aws.target, id: randomUUID() };
  await environmentFence();
  await aws.s3.send(new PutObjectCommand({ Bucket: location(aws.target).bucket, Key: genesisKey(aws.target), ExpectedBucketOwner: aws.target.accountId, Body: JSON.stringify(genesis), ContentType: 'application/json', ServerSideEncryption: 'AES256', IfNoneMatch: '*' }), { abortSignal: environmentSignal() });
  return genesis;
}
export async function bindRootHistory(aws: SetupAws, descriptor: Descriptor, genesis: Genesis): Promise<RootHistory> {
  const id = await tableId(aws);
  if (!id || genesis.tableId && genesis.tableId !== id)
    throw new AppError('purge_root_history');
  const progress = (await aws.db.send(new GetCommand({ TableName: descriptor.tableName, Key: { pk: 'setup#slack' }, ConsistentRead: true }), { abortSignal: environmentSignal() })).Item;
  if (progress) {
    return existingRootHistory(aws,genesis,id,progress);
  }
  await requireColdRoot(aws,genesis,id,descriptor);
  const saved = await readRootGenesis(aws);
  if (!saved || saved.value.id !== genesis.id || saved.value.tableId && saved.value.tableId !== id)
    throw new AppError('purge_root_history');
  if (!saved.value.tableId) {
    await environmentFence();
    await aws.s3.send(new PutObjectCommand({ Bucket: location(aws.target).bucket, Key: genesisKey(aws.target), ExpectedBucketOwner: aws.target.accountId, Body: JSON.stringify({ ...genesis, tableId: id, ledgerPhase:'pending' }), ContentType: 'application/json', ServerSideEncryption: 'AES256', IfMatch: saved.etag }), { abortSignal: environmentSignal() });
  }
  const seed: RootHistory = {genesisId:genesis.id,tableId:id,appIds:[],generationCount:0};
  const ledger=await readRootLedger(aws);
  if (ledger) { if (ledger.value.pending||!sameHistory(seed,ledger.value.history)) throw new AppError('purge_root_history'); }
  else await writeLedger(aws,seed,undefined);
  const latest=await readRootGenesis(aws);
  if (!latest||latest.value.id!==genesis.id||latest.value.tableId!==id) throw new AppError('purge_root_history');
  if (latest.value.ledgerPhase!=='initialized') {
    await environmentFence();
    await aws.s3.send(new PutObjectCommand({Bucket:location(aws.target).bucket,Key:genesisKey(aws.target),ExpectedBucketOwner:aws.target.accountId,Body:JSON.stringify({...latest.value,ledgerPhase:'initialized'}),ContentType:'application/json',ServerSideEncryption:'AES256',IfMatch:latest.etag}),{abortSignal:environmentSignal()});
  }
  return seed;
}
export async function provenRootHistory(aws: SetupAws, descriptor: Descriptor, progress: Record<string, unknown> | undefined, currentAppId: string, ownerId: string, teamId: string): Promise<RootHistory> {
  const history = await protectedRootHistory(aws), ordinary=validateRootHistory(progress?.rootHistory), saved = await readRootGenesis(aws);
  if (!sameHistory(history,ordinary)) throw new AppError('purge_root_history');
  const genesis = saved ? validateGenesis(saved.value, aws.target) : undefined;
  if (!genesis || genesis.id !== history.genesisId || genesis.tableId !== history.tableId || await tableId(aws) !== history.tableId || !history.appIds.includes(currentAppId) || progress?.retiredAppId && !history.appIds.includes(String(progress.retiredAppId)) || history.appIds.length > 1 && !history.ownerId || history.ownerId && history.ownerId !== ownerId || history.teamId && history.teamId !== teamId)
    throw new AppError('purge_root_history');
  if (descriptor.tableName !== `roughmate-${aws.target.environment}`)
    throw new AppError('purge_root_history');
  return { ...history, ownerId, teamId };
}
