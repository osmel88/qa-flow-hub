import { describe, expect, it } from 'vitest';
import { referenceFields, referenceLabel } from './DevelopmentPage';

describe('development references', () => {
  it('labels and builds the reference of each kind', () => {
    expect(referenceLabel('pull_request')).toBe('Pull request number');
    expect(referenceLabel('deployment')).toBe('Deployment identifier');
    expect(referenceFields('pull_request', ' 12 ')).toEqual({ prNumber: 12 });
    expect(referenceFields('commit', 'abc1234')).toEqual({ commitSha: 'abc1234' });
    expect(referenceFields('branch', 'feature/x')).toEqual({ branchName: 'feature/x' });
    expect(referenceFields('build', 'b-7')).toEqual({ identifier: 'b-7' });
  });
});
