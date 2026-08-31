import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashInvitationToken,
  hashesMatch,
  issueInvitationToken,
} from './organization-invitations.repository';

describe('invitation tokens', () => {
  it('issues a token with 256 bits of entropy in a URL-safe form', () => {
    const { token } = issueInvitationToken();

    // base64url of 32 bytes: 43 characters, and nothing that needs escaping in
    // a query string.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never issues the same token twice', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => issueInvitationToken().token));

    expect(tokens.size).toBe(500);
  });

  it('stores a hash from which the token cannot be read', () => {
    const { token, tokenHash } = issueInvitationToken();

    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('hashes deterministically, which is what makes lookup by token possible', () => {
    const { token, tokenHash } = issueInvitationToken();

    // A per-row salt would be better against brute force and would make
    // acceptance a full table scan. With 256 bits of entropy there is nothing
    // to brute force, so the deterministic hash is the right trade.
    expect(hashInvitationToken(token)).toBe(tokenHash);
  });

  it('compares hashes without leaking their contents through timing', () => {
    const { tokenHash } = issueInvitationToken();
    const other = issueInvitationToken().tokenHash;

    expect(hashesMatch(tokenHash, tokenHash)).toBe(true);
    expect(hashesMatch(tokenHash, other)).toBe(false);
    expect(hashesMatch(tokenHash, 'ab')).toBe(false);
  });
});
