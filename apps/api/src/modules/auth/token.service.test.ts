import { describe, expect, it } from 'vitest';
import { parseDuration } from './token.service';

describe('parseDuration', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['12h', 43_200],
    ['30d', 2_592_000],
    [' 7d ', 604_800],
  ])('converts %s to %i seconds', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '15', 'm', '15 minutes', '1w', '-5m', '1.5h'])(
    'refuses the unsupported duration %j',
    (input) => {
      // Failing loudly at startup beats silently defaulting to a lifetime
      // nobody chose — an access token that never expires would be invisible.
      expect(() => parseDuration(input)).toThrow(/Unsupported duration/);
    },
  );
});
