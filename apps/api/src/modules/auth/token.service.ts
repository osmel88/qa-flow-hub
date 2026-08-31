import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { TokenExpiredError, UnauthenticatedError } from '../../errors';

/**
 * Claims carried by the access token.
 *
 * `sid` matters as much as `sub`: it ties the access token to a session row, so
 * revoking a session can eventually invalidate access tokens too, and audit
 * entries can name the session a request came from.
 */
export interface AccessTokenPayload {
  sub: string;
  sid: string;
  email: string;
}

export interface IssuedRefreshToken {
  /** Returned to the client. Never stored. */
  token: string;
  /** Stored. A database dump does not yield usable tokens. */
  tokenHash: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwt.sign(payload, {
      secret: this.config.jwt.accessSecret,
      // Seconds rather than the "15m" string: one parser decides the lifetime,
      // so the token and its session row cannot disagree about when they die.
      expiresIn: this.accessTokenTtlSeconds,
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const payload = this.jwt.verify<AccessTokenPayload>(token, {
        secret: this.config.jwt.accessSecret,
      });
      return { sub: payload.sub, sid: payload.sid, email: payload.email };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        // A distinct code so the web client knows to refresh rather than to
        // send the user back to the login screen.
        throw new TokenExpiredError('The access token has expired');
      }
      throw new UnauthenticatedError('The access token is not valid');
    }
  }

  /**
   * Refresh tokens are opaque random strings, not JWTs.
   *
   * A JWT refresh token is self-validating, which is precisely the wrong
   * property here: it stays valid until it expires even after the user clicks
   * "log out". Every refresh must hit the database anyway to rotate the
   * session, so the token gains nothing by carrying claims — and an opaque
   * 256-bit random string cannot be decoded, cannot leak claims and cannot be
   * accepted by a bug in `alg` handling.
   */
  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hashRefreshToken(token) };
  }

  /**
   * HMAC-SHA256 rather than a bare SHA-256, keyed with the refresh secret.
   *
   * The secret acts as a pepper: an attacker with a copy of the database still
   * cannot precompute or verify hashes without also stealing the application
   * secret. Argon2 would be overkill — the input is 256 bits of entropy, not a
   * guessable human password, so there is nothing to brute force.
   */
  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.jwt.refreshSecret).update(token).digest('hex');
  }

  /** Constant-time comparison, so the response time reveals nothing. */
  matchesHash(token: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashRefreshToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  get accessTokenTtlSeconds(): number {
    return parseDuration(this.config.jwt.accessTtl);
  }

  get refreshTokenTtlSeconds(): number {
    return parseDuration(this.config.jwt.refreshTtl);
  }
}

/**
 * Turns "15m" or "30d" into seconds.
 *
 * `jsonwebtoken` accepts these strings for `expiresIn`, but we also need the
 * value as a number to compute `Session.expiresAt` and to report `expiresIn`
 * to the client. Keeping one parser avoids the classic bug where the JWT and
 * its database row disagree about when they die.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Unsupported duration "${value}". Use a form like 15m, 12h or 30d.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
  const multiplier = multipliers[unit ?? 's'];

  if (multiplier === undefined) {
    throw new Error(`Unsupported duration unit "${unit ?? ''}"`);
  }
  return amount * multiplier;
}
