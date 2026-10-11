import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'test-billing-webhook-secret-of-32-chars!';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const T = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from('{"id":"evt_1","type":"subscription.updated"}');

describe('webhook signatures', () => {
  it('accepts the exact bytes that were signed', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY, T), NOW)).toBe('valid');
  });

  it('refuses a body changed by a single byte, or re-serialised', () => {
    const header = signWebhook(SECRET, BODY, T);
    expect(verifyWebhookSignature(SECRET, Buffer.from(`${BODY.toString()} `), header, NOW)).toBe(
      'mismatch',
    );
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));
    expect(verifyWebhookSignature(SECRET, reserialised, header, NOW)).toBe('mismatch');
  });

  it('refuses another secret', () => {
    const header = signWebhook('another-secret-with-at-least-32-chars', BODY, T);
    expect(verifyWebhookSignature(SECRET, BODY, header, NOW)).toBe('mismatch');
  });

  it('binds the timestamp: a refreshed t with the old v1 does not verify', () => {
    const original = signWebhook(SECRET, BODY, T - 1000);
    const forged = original.replace(`t=${T - 1000}`, `t=${T}`);
    expect(verifyWebhookSignature(SECRET, BODY, forged, NOW)).toBe('mismatch');
  });

  it('refuses deliveries outside the tolerance window, in both directions', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY, T - 300), NOW)).toBe(
      'valid',
    );
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY, T - 301), NOW)).toBe(
      'stale',
    );
    expect(verifyWebhookSignature(SECRET, BODY, signWebhook(SECRET, BODY, T + 301), NOW)).toBe(
      'stale',
    );
  });

  it('tells missing from malformed headers', () => {
    expect(verifyWebhookSignature(SECRET, BODY, undefined, NOW)).toBe('missing');
    expect(verifyWebhookSignature(SECRET, BODY, '', NOW)).toBe('missing');
    for (const header of [
      'garbage',
      `t=${T}`,
      'v1=abc',
      `t=abc,v1=${'0'.repeat(64)}`,
      `t=${T},v1=zz`,
    ]) {
      expect(verifyWebhookSignature(SECRET, BODY, header, NOW)).toBe('malformed');
    }
  });

  it('accepts any of several v1 entries, for secret rotation', () => {
    const current = signWebhook(SECRET, BODY, T).split(',')[1];
    const old = signWebhook('previous-secret-also-thirty-two-chars!', BODY, T).split(',')[1];
    expect(verifyWebhookSignature(SECRET, BODY, `t=${T},${old},${current}`, NOW)).toBe('valid');
  });
});
