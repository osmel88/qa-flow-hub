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
