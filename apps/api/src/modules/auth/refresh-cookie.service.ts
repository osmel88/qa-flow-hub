import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthTokens,
  REFRESH_COOKIE_NAME,
  REFRESH_TRANSPORT_HEADER,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { parseDuration } from './token.service';

/**
 * Where the refresh token travels.
 *
 * A browser gets it as an `HttpOnly` cookie and never sees the value: script on
 * the page cannot read it, so an XSS payload cannot steal a 30-day credential.
 * A client without a cookie jar — an integration test, a CI script, a future
 * server-to-server caller — asks for the body form explicitly with
 * `X-Refresh-Transport: body`.
 *
 * The default is the safe one on purpose: forgetting the header costs a
 * confusing failure in a script, while defaulting to the body would silently
 * hand the token back to every browser.
 */
@Injectable()
export class RefreshCookieService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Sets the cookie and decides whether the caller also gets the raw value.
   * Returns the payload to send, with `refreshToken: null` for browsers.
   */
  handOver<T extends AuthTokens>(tokens: T, request: FastifyRequest, reply: FastifyReply): T {
    if (tokens.refreshToken === null) {
      return tokens;
    }

    void reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
      httpOnly: true,
      // Strict, not Lax: nothing in this product is a cross-site navigation
      // that must arrive authenticated, and Strict removes CSRF on refresh.
      sameSite: 'strict',
      // Over plain HTTP in development the browser would drop a Secure cookie
      // and the session would silently never restore.
      secure: this.config.isProduction,
      // The only endpoints that read it. A cookie scoped to `/` would ride
      // along on every request, including the ones that have no use for it.
      path: this.cookiePath,
      maxAge: parseDuration(this.config.jwt.refreshTtl),
    });

    return this.wantsBody(request) ? tokens : { ...tokens, refreshToken: null };
  }

  read(request: FastifyRequest): string | undefined {
    return request.cookies[REFRESH_COOKIE_NAME];
  }

  clear(reply: FastifyReply): void {
    void reply.clearCookie(REFRESH_COOKIE_NAME, { path: this.cookiePath });
  }

  private get cookiePath(): string {
    return `/${this.config.apiPrefix}/v1/auth`;
  }

  private wantsBody(request: FastifyRequest): boolean {
    return request.headers[REFRESH_TRANSPORT_HEADER] === 'body';
  }
}
