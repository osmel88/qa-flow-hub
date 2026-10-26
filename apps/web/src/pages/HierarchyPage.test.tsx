import { computeRollup } from '@qa-flow-hub/shared';
import { describe, expect, it } from 'vitest';
import { rollupText } from './HierarchyPage';

describe('rollupText', () => {
  it('is empty for a leaf', () => {
    expect(rollupText(computeRollup([]))).toBe('');
  });

  it('counts done items over the non-cancelled ones', () => {
    const rollup = computeRollup([
      { status: 'done', estimate: 3 },
      { status: 'in_progress', estimate: 2 },
      { status: 'cancelled', estimate: null },
    ]);
    expect(rollupText(rollup)).toBe('1/2 done (50%) · 5 estimated');
  });
});
