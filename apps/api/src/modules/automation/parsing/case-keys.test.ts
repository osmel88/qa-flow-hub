import { describe, expect, it } from 'vitest';
import { caseKeysIn } from './case-keys';

describe('caseKeysIn', () => {
  it('finds the project case keys in names, tags and annotations', () => {
    expect(caseKeysIn('WEB', ['WEB-C-1 pays', '@WEB-C-2', 'issue: WEB-C-03', '[WEB-C-4]'])).toEqual(
      ['WEB-C-1', 'WEB-C-2', 'WEB-C-3', 'WEB-C-4'],
    );
  });

  it('ignores other projects, embedded keys and requirement keys', () => {
    expect(
      caseKeysIn('WEB', ['MOB-C-1', 'XWEB-C-1', 'WEB-C-1x', 'WEB-R-1', 'WEB-C-', 'web-c-1']),
    ).toEqual([]);
  });

  it('deduplicates, and escapes regex characters in the project key', () => {
    expect(caseKeysIn('WEB', ['WEB-C-1 and WEB-C-1', 'WEB-C-001'])).toEqual(['WEB-C-1']);
    expect(caseKeysIn('A.B', ['AXB-C-1', 'A.B-C-2'])).toEqual(['A.B-C-2']);
  });
});
