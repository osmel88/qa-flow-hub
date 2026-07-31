import { z } from 'zod';

/**
 * Stable, machine-readable error codes. The HTTP status tells a client *how
 * bad* something is; the code tells it *what happened*, which is what a UI
 * needs in order to react (for example, redirecting on TOKEN_EXPIRED).
 *
 * Codes are part of the public contract: renaming one is a breaking change.
 */
export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_REUSE_DETECTED',
  'ACCOUNT_LOCKED',
  'FORBIDDEN',
  'ORGANIZATION_CONTEXT_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE_RESOURCE',
  'INVALID_STATE_TRANSITION',
  'RATE_LIMITED',
  'INTEGRATION_NOT_CONFIGURED',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Field-level detail, only ever produced by validation failures. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    requestId: z.string().optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;
