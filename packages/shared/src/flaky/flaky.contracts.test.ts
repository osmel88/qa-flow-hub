import { describe, expect, it } from 'vitest';
import type { FlakySample } from './flaky.contracts.js';
import { FLAKY_WINDOW, analyzeFlakiness, effectiveFlakyStatus } from './flaky.contracts.js';

const series = (
  pattern: string,
  options: { version?: (index: number) => number; row?: (index: number) => string } = {},
): FlakySample[] =>
  [...pattern].map((char, index) => ({
    status: char === 'P' ? 'passed' : 'failed',
    executedAt: new Date(Date.UTC(2027, 0, 1, 0, index)),
    caseVersion: options.version?.(index) ?? 1,
    iterationKey: options.row?.(index) ?? '',
  }));

describe('flaky detection', () => {
  it('needs a minimum of executions before judging', () => {
    expect(analyzeFlakiness(series('PFPF')).status).toBe('insufficient_data');
    expect(analyzeFlakiness([]).lastStatus).toBeNull();
  });

  it('tells flaky from a stable failure, a fix and a suspect', () => {
    const flaky = analyzeFlakiness(series('PFPPFPFP'));
    expect(flaky).toMatchObject({
      status: 'flaky',
      flips: 6,
      comparisons: 7,
      passed: 5,
      failed: 3,
    });
    expect(analyzeFlakiness(series('PPPPPFFF')).status).toBe('failing');
    expect(analyzeFlakiness(series('FFFFF')).status).toBe('failing');
    expect(analyzeFlakiness(series('FFFPPP')).status).toBe('stable');
    expect(analyzeFlakiness(series('PPPPP')).status).toBe('stable');
    // Two flips in nineteen comparisons stay below the flip-rate threshold.
    expect(analyzeFlakiness(series('PPPPPPPPPFPPPPPPPPPP')).status).toBe('suspect');
  });

  it('does not count outcome changes across versions or dataset rows', () => {
    // Fails on v1, passes after the edit to v2: explained by the edit.
    const edited = analyzeFlakiness(series('FPFPFP', { version: (index) => index + 1 }));
    expect(edited).toMatchObject({ comparisons: 0, flips: 0 });
    // Row a always passes, row b always fails: not flaky, failing.
    const rows = analyzeFlakiness(
      series('PFPFPFPF', { row: (index) => (index % 2 === 0 ? 'a' : 'b') }),
    );
    expect(rows).toMatchObject({ flips: 0, status: 'failing' });
  });

  it('uses only the most recent window', () => {
    const analysis = analyzeFlakiness(series(`${'PF'.repeat(10)}${'P'.repeat(FLAKY_WINDOW)}`));
    expect(analysis).toMatchObject({ executions: FLAKY_WINDOW, failed: 0, status: 'stable' });
  });

  it('applies confirmations, and dismissals until a newer flip', () => {
    const analysis = analyzeFlakiness(series('PFPFPF'));
    expect(effectiveFlakyStatus(analysis, null).status).toBe('flaky');
    expect(
      effectiveFlakyStatus(
        { status: 'stable', lastFlipAt: null },
        { state: 'flaky', markedAt: '2027-01-02T00:00:00Z' },
      ),
    ).toMatchObject({ status: 'flaky', confirmed: true });
    expect(
      effectiveFlakyStatus(analysis, { state: 'not_flaky', markedAt: '2027-01-02T00:00:00Z' }),
    ).toMatchObject({ status: 'stable', dismissed: true });
    expect(
      effectiveFlakyStatus(analysis, { state: 'not_flaky', markedAt: '2026-12-31T00:00:00Z' }),
    ).toMatchObject({ status: 'flaky', dismissed: false });
    expect(
      effectiveFlakyStatus(analysis, { state: 'cleared', markedAt: '2027-01-02T00:00:00Z' }).status,
    ).toBe('flaky');
  });
});
