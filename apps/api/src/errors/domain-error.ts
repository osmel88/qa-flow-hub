import type { ApiErrorCode } from '@qa-flow-hub/shared';

/**
 * Base class for every error the domain raises on purpose.
 *
 * Services throw domain errors instead of HttpException so that business rules
 * stay independent from the transport: the same service can back an HTTP
 * controller, a queue consumer or a CLI command. A single exception filter
 * translates these into HTTP responses.
 */
export abstract class DomainError extends Error {
  abstract readonly code: ApiErrorCode;
  abstract readonly httpStatus: number;

  /**
   * Extra context for logs and audit. It must never contain secrets: whatever
   * lands here can end up in the response body.
   */
  readonly context: Record<string, unknown>;

  protected constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND' as const;
  readonly httpStatus = 404;

  constructor(resource: string, identifier?: string) {
    // The identifier is deliberately kept out of the message: telling an
    // attacker "Project 42 not found" versus "not found" leaks existence.
    super(`${resource} not found`, identifier === undefined ? {} : { identifier });
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT' as const;
  readonly httpStatus = 409;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, context);
  }
}

export class DuplicateResourceError extends DomainError {
  readonly code = 'DUPLICATE_RESOURCE' as const;
  readonly httpStatus = 409;

  constructor(resource: string, field: string) {
    super(`A ${resource} with this ${field} already exists`, { resource, field });
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION' as const;
  readonly httpStatus = 422;

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot move from "${from}" to "${to}"`, { entity, from, to });
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN' as const;
  readonly httpStatus = 403;

  constructor(message = 'You are not allowed to perform this action') {
    super(message);
  }
}

export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED' as const;
  readonly httpStatus = 401;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

/**
 * Deliberately says nothing about *which* half was wrong. "Unknown email" and
 * "wrong password" are the same response, because the difference is an account
 * enumeration oracle.
 */
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS' as const;
  readonly httpStatus = 401;

  constructor() {
    super('Invalid email or password');
  }
}

export class TokenExpiredError extends DomainError {
  readonly code = 'TOKEN_EXPIRED' as const;
  readonly httpStatus = 401;

  constructor(message = 'The token has expired') {
    super(message);
  }
}

/**
 * Raised when a refresh token that was already rotated is presented again.
 * Either the user replayed an old token or somebody stole one; the response is
 * the same, and the whole token family is revoked.
 */
export class TokenReuseDetectedError extends DomainError {
  readonly code = 'TOKEN_REUSE_DETECTED' as const;
  readonly httpStatus = 401;

  constructor() {
    super('The session was terminated because a used token was presented again');
  }
}

export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED' as const;
  readonly httpStatus = 429;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message, retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly httpStatus = 400;

  constructor(
    message: string,
    readonly details: Array<{ path: string; message: string }> = [],
  ) {
    super(message, { details });
  }
}

export class NotImplementedError extends DomainError {
  readonly code = 'NOT_IMPLEMENTED' as const;
  readonly httpStatus = 501;
}

/**
 * The organization has not configured, or has disconnected, the provider a
 * request needs. A 409 rather than a 400: the request is well formed, the
 * organization's state is what refuses it.
 */
export class IntegrationNotConfiguredError extends DomainError {
  readonly code = 'INTEGRATION_NOT_CONFIGURED' as const;
  readonly httpStatus = 409;

  constructor(provider: string, reason: string) {
    super(`${provider} is not available: ${reason}`, { provider });
  }
}

/**
 * The provider answered, and the answer was a failure. 502 is the honest
 * status: the fault lies upstream of this API, and retrying may well succeed.
 * `context.provider` is safe to expose; a provider's raw response is not, so
 * adapters pass a message and never the body they received.
 */
export class IntegrationProviderError extends DomainError {
  readonly code = 'INTEGRATION_ERROR' as const;
  readonly httpStatus = 502;

  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`, { provider });
  }
}

/** The declared type, the extension or the bytes are not on the allow-list. */
export class UnsupportedFileTypeError extends DomainError {
  readonly code = 'UNSUPPORTED_FILE_TYPE' as const;
  readonly httpStatus = 415;

  constructor(message: string) {
    super(message);
  }
}

export class FileTooLargeError extends DomainError {
  readonly code = 'FILE_TOO_LARGE' as const;
  readonly httpStatus = 413;

  constructor(maxSizeBytes: number) {
    super(`File exceeds the maximum size of ${maxSizeBytes} bytes`, { maxSizeBytes });
  }
}

/**
 * The storage provider failed to read, write or delete an object. 503 and not
 * 500: the request was valid and the metadata is consistent, the backing
 * store is what is unavailable. The provider's own message is logged, never
 * returned — a local path or a bucket name is nobody's business.
 */
export class StorageError extends DomainError {
  readonly code = 'STORAGE_ERROR' as const;
  readonly httpStatus = 503;

  constructor(
    operation: 'put' | 'get' | 'head' | 'delete',
    readonly underlying: unknown,
  ) {
    super(`Storage ${operation} failed`, { operation });
  }
}

/**
 * Creating one more project, member or byte of evidence would exceed the
 * organization's effective plan. 402 Payment Required: the request is valid,
 * and paying for a larger plan is what makes it succeed. Existing data is never
 * affected — only the creation is refused. The resource travels as the single
 * `details` entry so a client can link to the billing page for the right reason.
 */
export class PlanLimitReachedError extends DomainError {
  readonly code = 'PLAN_LIMIT_REACHED' as const;
  readonly httpStatus = 402;

  constructor(resource: 'projects' | 'members' | 'storage', plan: string, limit: number, used: number) {
    super(`The ${plan} plan allows ${limit} ${resource === 'storage' ? 'bytes of evidence' : resource}; ${used} in use`, {
      details: [{ path: resource, message: `limit ${limit}, used ${used}, plan ${plan}` }],
      resource,
      plan,
      limit,
      used,
    });
  }
}

/**
 * A billing webhook that is unsigned, stale, tampered with or malformed. One
 * message for all of them: telling a forger *which* check failed is help.
 */
export class InvalidWebhookError extends DomainError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly httpStatus = 400;

  constructor(readonly reason: string) {
    super('The webhook could not be verified');
  }
}

/**
 * The import file exceeds a structural limit (bytes, rows, columns, record size
 * or cases). 413: the request is well formed and simply too big to process.
 */
export class ImportTooLargeError extends DomainError {
  readonly code = 'IMPORT_TOO_LARGE' as const;
  readonly httpStatus = 413;

  constructor(limit: string, max: number) {
    super(`The import exceeds the limit of ${max} ${limit}`, {
      details: [{ path: limit, message: `max ${max}` }],
    });
  }
}

/**
 * The database changed between the dry run and the commit (a case it would
 * create now exists, a referenced requirement is gone…). Nothing was written;
 * running the dry run again produces a plan that matches the current state.
 */
export class ImportStaleError extends DomainError {
  readonly code = 'IMPORT_STALE' as const;
  readonly httpStatus = 409;

  constructor(reason: string) {
    super(`The project changed since the dry run (${reason}); run the dry run again`);
  }
}

/** An export would produce more rows than `EXPORT_MAX_ROWS`; filters narrow it. */
export class ExportTooLargeError extends DomainError {
  readonly code = 'EXPORT_TOO_LARGE' as const;
  readonly httpStatus = 422;

  constructor(rows: number, max: number) {
    super(`The export would contain ${rows} rows; the limit is ${max}. Narrow it with filters`);
  }
}
