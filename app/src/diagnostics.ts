import { AppError } from './contracts.js';
export function diagnosticCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (!error || typeof error !== 'object') return 'external_error';
  if ('data' in error && error.data && typeof error.data === 'object' && 'error' in error.data) {
    const code = error.data.error;
    if (typeof code === 'string' && ['invalid_auth','invalid_manifest','not_in_team','token_expired','missing_scope','not_in_channel','channel_not_found','ratelimited','not_allowed_token_type','thread_not_found','no_permission','hash_conflict','not_found'].includes(code)) return 'slack_' + code;
  }
  if ('status' in error && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return 'external_http_' + error.status;
  if (error instanceof Error && ['CredentialsProviderError','TimeoutError','AbortError','ThrottlingException','AccessDeniedException','ResourceNotFoundException'].includes(error.name)) return error.name;
  return 'external_error';
}
