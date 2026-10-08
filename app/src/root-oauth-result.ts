import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { AppError, string, validateSecrets, requireInstalledSecrets, type Secrets } from './contracts.js';
import { botScopes } from './slack.js';
export interface RootOAuthResult {
  environmentId: string; appId: string; requestId: string; operationId: string;
  teamId: string; ownerId: string; expiresAt: number; cipher: string; iv: string; tag: string;
}
type ResultIdentity = Omit<RootOAuthResult, 'cipher' | 'iv' | 'tag'>;
const purpose = 'roughmate-root-oauth-result-v1';
function requireIdentity(value: ResultIdentity, environmentId: string, appId: string, requestId: string, operationId: string): void {
  if (value.environmentId !== environmentId || value.appId !== appId || value.requestId !== requestId || value.operationId !== operationId || !/^oauth#[a-f0-9]{64}$/.test(requestId) || !/^[a-f0-9-]{36}$/.test(operationId) || !/^T[A-Z0-9]+$/.test(value.teamId) || !/^[UW][A-Z0-9]+$/.test(value.ownerId) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Math.floor(Date.now() / 1000)) throw new AppError('root_oauth_pending');
}
function aad(value: ResultIdentity): Buffer { return Buffer.from(JSON.stringify([purpose, value.environmentId, value.appId, value.requestId, value.operationId, value.teamId, value.ownerId, value.expiresAt])); }
function key(secrets: Secrets, environmentId: string): Buffer { return Buffer.from(hkdfSync('sha256', string(secrets.signingSecret), environmentId, purpose, 32)); }
function requireResult(value: Secrets, base: Secrets, identity: ResultIdentity): void {
  const installed = requireInstalledSecrets(validateSecrets(value)), receipt = installed.rootOAuth;
  if (!receipt || receipt.requestId !== identity.requestId || receipt.teamId !== identity.teamId || receipt.ownerId !== identity.ownerId || !installed.botScopes || botScopes.some(scope => !installed.botScopes!.includes(scope)) || installed.botScopes.some(scope => !botScopes.some(allowed => allowed === scope)) || base.botUserId !== undefined && installed.botUserId !== base.botUserId) throw new AppError('root_oauth_pending');
  for (const field of ['appId', 'clientId', 'clientSecret', 'signingSecret', 'model', 'apiKey'] as const) if (value[field] !== base[field]) throw new AppError('root_oauth_pending');
}
export function encryptRootOAuthResult(base: Secrets, value: Secrets, identity: ResultIdentity): RootOAuthResult {
  requireIdentity(identity, identity.environmentId, base.appId, identity.requestId, identity.operationId); requireResult(value, base, identity);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(base, identity.environmentId), iv); cipher.setAAD(aad(identity));
  return { ...identity, cipher: Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function decryptRootOAuthResult(base: Secrets, value: RootOAuthResult, expected: { environmentId: string; requestId: string; operationId: string; expiresAt: number }): Secrets {
  requireIdentity(value, expected.environmentId, base.appId, expected.requestId, expected.operationId);
  if (value.expiresAt !== expected.expiresAt) throw new AppError('root_oauth_pending');
  let restored: Secrets;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(base, expected.environmentId), Buffer.from(string(value.iv), 'base64'));
    decipher.setAAD(aad(value)); decipher.setAuthTag(Buffer.from(string(value.tag), 'base64'));
    restored = validateSecrets(JSON.parse(Buffer.concat([decipher.update(Buffer.from(string(value.cipher), 'base64')), decipher.final()]).toString('utf8')));
  } catch { throw new AppError('root_oauth_pending'); }
  requireResult(restored, base, value); return restored;
}
