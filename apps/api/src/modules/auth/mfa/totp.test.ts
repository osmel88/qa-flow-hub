import { describe, expect, it } from 'vitest';
import {
  MfaSecretBox,
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  hotp,
  matchTotp,
  mfaHash,
  otpauthUri,
  totpStep,
} from './totp';

/** RFC 6238 appendix B seed for SHA-1: ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('totp', () => {
  it('round-trips base32 and matches the RFC 4648 encoding', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
    const random = generateTotpSecret();
    expect(random).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(random))).toBe(random);
  });

  it('rejects characters outside the base32 alphabet', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('reproduces the RFC 6238 SHA-1 vector at T=%i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(expected);
  });

  it('accepts one step of drift either way and nothing further', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it('refuses a step that is not newer than the last accepted one (replay)', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(matchTotp(RFC_SECRET, '12345', now, null)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    const uri = new URL(otpauthUri('qa-flow-hub', 'ada@example.test', RFC_SECRET));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/qa-flow-hub:ada@example.test');
    expect(uri.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(uri.searchParams.get('issuer')).toBe('qa-flow-hub');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});

describe('MfaSecretBox', () => {
  const box = new MfaSecretBox('k'.repeat(40));

  it('seals with a fresh IV and opens back', () => {
    const a = box.seal(RFC_SECRET, 'user-1');
    const b = box.seal(RFC_SECRET, 'user-1');
    expect(a).not.toBe(b);
    expect(a).not.toContain(RFC_SECRET);
    expect(box.open(a, 'user-1')).toBe(RFC_SECRET);
  });

  it('refuses a ciphertext moved to another user', () => {
    const sealed = box.seal(RFC_SECRET, 'user-1');
    expect(() => box.open(sealed, 'user-2')).toThrow();
  });

  it('refuses tampered ciphertext, another key and unknown formats', () => {
    const sealed = box.seal(RFC_SECRET, 'user-1');
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');
    expect(() => box.open(tampered, 'user-1')).toThrow();
    expect(() => new MfaSecretBox('z'.repeat(40)).open(sealed, 'user-1')).toThrow();
    expect(() => box.open('v2.a.b.c', 'user-1')).toThrow(/format/);
  });
});

describe('recovery codes and hashes', () => {
  it('generates distinct codes in the documented shape', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    }
  });

  it('separates hashes by key and by purpose', () => {
    const key = 'k'.repeat(40);
    expect(mfaHash(key, 'recovery', 'abcde-12345')).toBe(mfaHash(key, 'recovery', 'abcde-12345'));
    expect(mfaHash(key, 'recovery', 'abcde-12345')).not.toBe(mfaHash(key, 'challenge', 'abcde-12345'));
    expect(mfaHash(key, 'recovery', 'abcde-12345')).not.toBe(
      mfaHash('j'.repeat(40), 'recovery', 'abcde-12345'),
    );
  });
});
