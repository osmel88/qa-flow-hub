import type { ApiErrorCode } from '@qa-flow-hub/shared';
import { DEFAULT_LOCALE } from './locales';
import { currentLocale, t } from './i18n';
import type { MessageKey } from './messages/en';

/**
 * The codes the Web can receive from its own requests. Ingestion reports
 * (API-key only), the organization header and refresh-token reuse never reach
 * a screen as a message, so they fall back to `apiError.unknown`.
 */
const KEYS: Partial<Record<ApiErrorCode, MessageKey>> = {
  UNAUTHENTICATED: 'apiError.UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'apiError.INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'apiError.TOKEN_EXPIRED',
  ACCOUNT_LOCKED: 'apiError.ACCOUNT_LOCKED',
  FORBIDDEN: 'apiError.FORBIDDEN',
  MFA_INVALID_CODE: 'apiError.MFA_INVALID_CODE',
  NOT_FOUND: 'apiError.NOT_FOUND',
  CONFLICT: 'apiError.CONFLICT',
  DUPLICATE_RESOURCE: 'apiError.DUPLICATE_RESOURCE',
  INVALID_STATE_TRANSITION: 'apiError.INVALID_STATE_TRANSITION',
  VALIDATION_ERROR: 'apiError.VALIDATION_ERROR',
  QUALITY_GATE_FAILED: 'apiError.QUALITY_GATE_FAILED',
  APPROVAL_REQUIRED: 'apiError.APPROVAL_REQUIRED',
  RATE_LIMITED: 'apiError.RATE_LIMITED',
  PLAN_LIMIT_REACHED: 'apiError.PLAN_LIMIT_REACHED',
  INTEGRATION_NOT_CONFIGURED: 'apiError.INTEGRATION_NOT_CONFIGURED',
  INTEGRATION_ERROR: 'apiError.INTEGRATION_ERROR',
  UNSUPPORTED_FILE_TYPE: 'apiError.UNSUPPORTED_FILE_TYPE',
  FILE_TOO_LARGE: 'apiError.FILE_TOO_LARGE',
  STORAGE_ERROR: 'apiError.STORAGE_ERROR',
  IMPORT_STALE: 'apiError.IMPORT_STALE',
  IMPORT_TOO_LARGE: 'apiError.IMPORT_TOO_LARGE',
  EXPORT_TOO_LARGE: 'apiError.EXPORT_TOO_LARGE',
  NOT_IMPLEMENTED: 'apiError.NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'apiError.INTERNAL_ERROR',
};

/**
 * The user-facing text of an API error, chosen by its stable `code`.
 *
 * The API writes its messages in English, more specific than a per-code text
 * ("A test suite with this name already exists"), so English keeps them. Any
 * other language shows the catalog text of the code, and an unknown code a
 * generic line; the server message stays on the error for debugging.
 */
export function apiErrorMessage(code: string, serverMessage: string): string {
  if (currentLocale() === DEFAULT_LOCALE && serverMessage !== '') {
    return serverMessage;
  }
  return t(KEYS[code as ApiErrorCode] ?? 'apiError.unknown');
}
