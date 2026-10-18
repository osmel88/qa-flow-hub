import { describe, expect, it } from 'vitest';
import { decodeSectionPath, encodeSectionName, encodeSectionPath } from './import.contracts.js';

describe('section path encoding', () => {
  it('escapes the separator and the escape character inside a name', () => {
    expect(encodeSectionName('Login > Security')).toBe('Login \\> Security');
    expect(encodeSectionName('C:\\temp')).toBe('C:\\\\temp');
    expect(encodeSectionPath(['Auth', 'Login > Security', 'MFA'])).toBe(
      'Auth > Login \\> Security > MFA',
    );
  });

  it.each([
    [['Login > Security']],
    [['a > b > c >> d']],
    [['>Start']],
    [['End>']],
    [['>']],
    [['>>']],
    [['x, "y" >\nz']],
    [['Auth', 'Login > Security', 'MFA']],
    [['>Start', 'End>', '>', 'plain']],
    [['C:\\temp\\']],
    [['\\>']],
    [['a\\', 'b']],
    [['a\\', '>b']],
  ])('decodes the encoding of %j back to the same trimmed levels', (names) => {
    expect(decodeSectionPath(encodeSectionPath(names)).map((level) => level.trim())).toEqual(names);
  });

  it('splits on every unescaped separator and keeps empty levels for the caller', () => {
    expect(decodeSectionPath('Auth > Login \\> Security')).toEqual(['Auth ', ' Login > Security']);
    expect(decodeSectionPath('A >  > B')).toEqual(['A ', '  ', ' B']);
    expect(decodeSectionPath('> A')).toEqual(['', ' A']);
  });

  it('keeps a backslash before any other character as written', () => {
    expect(decodeSectionPath('C:\\temp > D:\\')).toEqual(['C:\\temp ', ' D:\\']);
  });
});
