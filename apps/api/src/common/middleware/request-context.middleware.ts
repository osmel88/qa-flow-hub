import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { TenantContextService } from '../../database/tenant-context.service';

/**
 * Opens the per-request AsyncLocalStorage context.
 *
 * It runs as middleware, before any guard, so that everything downstream — the
 * authentication guard that fills in the user, the repositories that read the
 * organization, the audit interceptor that reads the request id — shares one
 * store. The `next()` call happens *inside* `run()`, which is what makes the
 * context survive every subsequent `await`.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly tenant: TenantContextService) {}

  use(request: FastifyRequest['raw'], reply: FastifyReply['raw'], next: () => void): void {
    const headerId = request.headers['x-request-id'];
    const requestId = typeof headerId === 'string' ? headerId : randomUUID();
    const forwardedFor = request.headers['x-forwarded-for'];
    const userAgent = request.headers['user-agent'];

    reply.setHeader('X-Request-Id', requestId);

    this.tenant.run(
      {
        requestId,
        ipAddress:
          (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0]?.trim() : undefined) ??
          request.socket.remoteAddress,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      },
      next,
    );
  }
}
