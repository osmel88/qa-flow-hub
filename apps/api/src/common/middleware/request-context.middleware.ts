import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { REQUEST_ID_HEADER, resolveRequestId } from '../../bootstrap/request-id';
import { resolveClientIp } from '../../bootstrap/client-ip';
import { AppConfigService } from '../../config/app-config.service';
import { TenantContextService } from '../../database/tenant-context.service';

/**
 * Opens the per-request AsyncLocalStorage context.
 *
 * It runs as middleware, before any guard, so that everything downstream — the
 * authentication guard that fills in the user, the repositories that read the
 * organization, the audit interceptor that reads the request id — shares one
 * store. The `next()` call happens *inside* `run()`, which is what makes the
 * context survive every subsequent `await`.
 *
 * The request id is the one Fastify already resolved (see `createFastifyAdapter`),
 * so the response header, the error body, the log lines and the audit row all
 * carry the same value. The client address follows the same proxy-hop rule as
 * Fastify's `request.ip`, which the rate limiter keys on.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly config: AppConfigService,
  ) {}

  use(request: FastifyRequest['raw'], _reply: FastifyReply['raw'], next: () => void): void {
    const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    const userAgent = request.headers['user-agent'];

    // Absent rather than `undefined`: with exactOptionalPropertyTypes, "we do
    // not know the caller's address" is the field not being there.
    const ipAddress = resolveClientIp(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
      this.config.trustProxyHops,
    );

    this.tenant.run(
      {
        requestId,
        ...(ipAddress === undefined ? {} : { ipAddress }),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      },
      next,
    );
  }
}
