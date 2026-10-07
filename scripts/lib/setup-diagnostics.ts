import { diagnosticCode } from '../../app/src/diagnostics.js';
import { AppError } from '../../app/src/contracts.js';

export function setupDiagnosticCode(error: unknown): string {
  const code = diagnosticCode(error);
  if (error instanceof AppError || code.startsWith('slack_')) return code;
  if (error && typeof error === 'object') {
    if ('data' in error && error.data && typeof error.data === 'object' && 'error' in error.data) {
      const slackCode = error.data.error;
      if (typeof slackCode === 'string' && ['invalid_manifest','invalid_arguments','token_expired','token_revoked','not_in_team','access_denied','no_permission','failed_creating_app','internal_error','fatal_error','enterprise_is_restricted'].includes(slackCode)) return 'slack_' + slackCode;
    }
    if ('code' in error && error.code === 'slack_webapi_request_error') return 'slack_request_failed';
  }
  return 'operation_failed';
}
