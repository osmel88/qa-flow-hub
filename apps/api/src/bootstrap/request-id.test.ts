import { describe, expect, it } from 'vitest';
import { resolveRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('reuses a well-formed caller id so a trace survives the hop', () => {
    expect(resolveRequestId('edge-7f3a9c2e-01')).toBe('edge-7f3a9c2e-01');
  });

  it.each([
    ['missing', undefined],
    ['repeated header', ['abcdefgh1', 'abcdefgh2']],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['log injection', 'abcdefgh\n{"level":"fatal"}'],
    ['quotes and spaces', 'abc def "ghi"'],
  ])('replaces a %s id with a fresh UUID', (_label, header) => {
    expect(resolveRequestId(header)).toMatch(UUID);
  });

  it('is idempotent, so two layers resolving the same header agree', () => {
    const first = resolveRequestId('not valid!');
    expect(resolveRequestId(first)).toBe(first);
  });
});
