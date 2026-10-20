import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { API_KEY_TOKEN_PATTERN } from '@qa-flow-hub/shared';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_LENGTH = 12;

export interface GeneratedToken {
  token: string;
  prefix: string;
  secretHash: string;
}

/**
 * `qfh_<prefix>_<secret>`. The prefix (12 alphanumerics, ~71 bits) is stored
 * in clear to find the row; the secret (32 random bytes) is never stored, only
 * the SHA-256 of the whole token. A fast hash is enough here, unlike for
 * passwords: the input has 256 bits of entropy, so there is nothing to
 * brute-force. The `qfh_` marker lets secret scanners recognise a leaked key.
 */
export function generateToken(): GeneratedToken {
  const prefix = randomAlphanumeric(PREFIX_LENGTH);
  const secret = randomBytes(32).toString('base64url');
  const token = `qfh_${prefix}_${secret}`;
  return { token, prefix, secretHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The prefix of a well-formed token, or null: nothing else is parsed. */
export function prefixOf(token: string): string | null {
  return API_KEY_TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

export function tokenMatches(token: string, secretHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(secretHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Reads `Authorization: Bearer <token>` or `X-Api-Key: <token>`. */
export function tokenFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const single = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const authorization = single(headers['authorization']);
  const bearer = authorization === undefined ? null : /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (bearer !== null) {
    return bearer[1] ?? null;
  }
  const apiKey = single(headers['x-api-key']);
  return apiKey === undefined ? null : apiKey.trim();
}

function randomAlphanumeric(length: number): string {
  // Rejection sampling: 62 does not divide 256, so `byte % 62` would bias.
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) {
        out += ALPHANUMERIC[byte % 62];
      }
    }
  }
  return out;
}
