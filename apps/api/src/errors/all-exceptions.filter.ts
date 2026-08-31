import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorCode, ApiErrorResponse } from '@qa-flow-hub/shared';
import { DomainError } from './domain-error';

interface NormalisedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: Array<{ path: string; message: string }>;
  /** Logged, never returned to the client. */
  cause?: unknown;
}

/** Anything at or above this is our fault, and is logged as such. */
const SERVER_ERROR = 500;

/**
 * A lookup and not a `switch`, because a status is a plain number here — domain
 * errors declare `httpStatus = 404` without importing Nest — and comparing a
 * number against enum members is the kind of mixed comparison that reads as
 * exhaustive while silently never matching.
 */
const CODE_BY_STATUS: Readonly<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.NOT_IMPLEMENTED]: 'NOT_IMPLEMENTED',
};

/**
 * The single place where an error becomes an HTTP response.
 *
 * Two rules drive the design:
 *  1. The response shape is always `{ error: { code, message, ... } }`, so a
 *     client never has to guess whether it got a Nest error or ours.
 *  2. Unexpected errors are logged with their stack and answered with a generic
 *     message. Stack traces, SQL fragments and Prisma metadata never reach the
 *     client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const normalised = this.normalise(exception);

    if (normalised.status >= SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${normalised.status} ${normalised.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(
        `${request.method} ${request.url} -> ${normalised.status} ${normalised.code}: ${normalised.message}`,
      );
    }

    const body: ApiErrorResponse = {
      error: {
        code: normalised.code,
        message: normalised.message,
        ...(normalised.details ? { details: normalised.details } : {}),
        ...(request.id ? { requestId: String(request.id) } : {}),
      },
    };

    void reply.status(normalised.status).send(body);
  }

  private normalise(exception: unknown): NormalisedError {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        ...(Array.isArray(exception.context['details'])
          ? { details: exception.context['details'] as Array<{ path: string; message: string }> }
          : {}),
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: exception.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        code: this.codeForStatus(exception.getStatus()),
        message: this.messageFromHttpException(exception),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      cause: exception,
    };
  }

  private messageFromHttpException(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const { message } = response;
      if (typeof message === 'string') {
        return message;
      }
      if (Array.isArray(message)) {
        return message.join('; ');
      }
    }
    return exception.message;
  }

  private codeForStatus(status: number): ApiErrorCode {
    return (
      CODE_BY_STATUS[status] ?? (status >= SERVER_ERROR ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR')
    );
  }
}
