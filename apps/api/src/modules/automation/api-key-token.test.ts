import { API_KEY_TOKEN_PATTERN } from '@qa-flow-hub/shared';
import { describe, expect, it } from 'vitest';
import {
  generateToken,
  hashToken,
  prefixOf,
  tokenFromHeaders,
  tokenMatches,
} from './api-key-token';

describe('API key tokens', () => {
  it('generates unique tokens in the documented format, hashed with SHA-256', () => {
    const tokens = Array.from({ length: 200 }, () => generateToken());
    expect(new Set(tokens.map((t) => t.token)).size).toBe(200);
    expect(new Set(tokens.map((t) => t.prefix)).size).toBe(200);
    for (const generated of tokens) {
      expect(generated.token).toMatch(API_KEY_TOKEN_PATTERN);
      expect(generated.token.startsWith(`qfh_${generated.prefix}_`)).toBe(true);
      expect(generated.secretHash).toBe(hashToken(generated.token));
      expect(generated.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(prefixOf(generated.token)).toBe(generated.prefix);
    }
  });

  it('matches only the exact token', () => {
    const { token, secretHash } = generateToken();
    expect(tokenMatches(token, secretHash)).toBe(true);
    expect(tokenMatches(`${token}x`, secretHash)).toBe(false);
    expect(tokenMatches(token.slice(0, -1), secretHash)).toBe(false);
    expect(tokenMatches(token.toUpperCase(), secretHash)).toBe(false);
    expect(tokenMatches(token, 'not-a-hash')).toBe(false);
  });

  it('extracts the prefix only from a well-formed token', () => {
    for (const value of [
      '',
      'qfh_',
      'qfh_short_x',
      'abc_123456789012_' + 'a'.repeat(43),
      'eyJhbGciOi.x.y',
    ]) {
      expect(prefixOf(value)).toBeNull();
    }
  });

  it('reads Authorization: Bearer or X-Api-Key, nothing else', () => {
    const { token } = generateToken();
    expect(tokenFromHeaders({ authorization: `Bearer ${token}` })).toBe(token);
    expect(tokenFromHeaders({ authorization: `bearer ${token}` })).toBe(token);
    expect(tokenFromHeaders({ 'x-api-key': token })).toBe(token);
    expect(tokenFromHeaders({ 'x-api-key': [token, 'other'] })).toBe(token);
    expect(tokenFromHeaders({ authorization: `Basic ${token}` })).toBeNull();
    expect(tokenFromHeaders({})).toBeNull();
  });
});
