import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { TenantContextService } from '../../../database/tenant-context.service';
import { UnauthenticatedError } from '../../../errors';
import { SessionsRepository } from '../sessions.repository';
import { TokenService } from '../token.service';

/**
 * Registered globally in AuthModule, so authentication is the default and
 * `@Public()` is the exception.
 *
 * That default matters: with an opt-in guard, forgetting a decorator publishes
 * an endpoint; with an opt-out guard, forgetting one merely breaks it loudly.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsRepository,
    private readonly context: TenantContextService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (header === undefined || !header.startsWith('Bearer ')) {
      throw new UnauthenticatedError('A bearer token is required');
    }

    const payload = this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());

    /**
     * The access token is short-lived but not instantly revocable on its own.
     * Checking the session row on each request makes "log out everywhere" and
     * "change password" take effect immediately, at the cost of one indexed
     * lookup. For an internal tool that trade is obviously right; the
     * alternative (accepting a stale token for up to fifteen minutes) is the
     * kind of detail that fails a security review.
     */
    const session = await this.sessions.findById(payload.sid);
    if (session === null || session.revokedAt !== null || session.userId !== payload.sub) {
      throw new UnauthenticatedError('The session is no longer valid');
    }

    this.context.setUser(payload.sub, payload.email);
    return true;
  }
}
