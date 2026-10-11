import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` — the scheme
 * Stripe popularised. Signing the timestamp together with the body is what
 * makes the tolerance window meaningful: an attacker who captured a delivery
 * cannot refresh `t` without the secret, so a replay older than the window is
 * refused even before the event-id check runs.
 */
export const SIGNATURE_HEADER = 'x-qaflow-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict = 'valid' | 'missing' | 'malformed' | 'stale' | 'mismatch';

function digest(secret: string, timestamp: number, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

export function signWebhook(secret: string, rawBody: Buffer | string, timestamp: number): string {
  return `t=${timestamp},v1=${digest(secret, timestamp, rawBody)}`;
}

/**
 * Several `v1` entries are accepted so that a secret can be rotated: during the
 * overlap the provider signs with both.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  now: Date,
  toleranceSeconds: number = SIGNATURE_TOLERANCE_SECONDS,
): SignatureVerdict {
  if (header === undefined || header.length === 0) {
    return 'missing';
  }

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return 'malformed';
  }

  // Both directions: a timestamp from the future is as suspicious as an old one.
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) {
    return 'stale';
  }

  const expected = Buffer.from(digest(secret, timestamp, rawBody), 'hex');
  const matches = signatures.some((candidate) =>
    timingSafeEqual(Buffer.from(candidate, 'hex'), expected),
  );
  return matches ? 'valid' : 'mismatch';
}
