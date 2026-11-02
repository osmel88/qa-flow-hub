import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_STATUS_VALUES, computeDevelopmentStatus } from './development.contracts.js';
import type { DevelopmentSignal } from './development.contracts.js';

let sequence = 0;
const signal = (
  kind: DevelopmentSignal['kind'],
  status: string | null = null,
  minutesAgo = 0,
): DevelopmentSignal => {
  sequence += 1;
  return {
    id: `a${String(sequence).padStart(3, '0')}`,
    kind,
    status,
    occurredAt: new Date(Date.UTC(2027, 0, 1, 12, 0) - minutesAgo * 60_000).toISOString(),
    createdAt: '2027-01-01T00:00:00.000Z',
  };
};
const statusOf = (signals: DevelopmentSignal[]) => computeDevelopmentStatus(signals).status;

describe('development status', () => {
  it('climbs the precedence from no development to deployed', () => {
    expect(statusOf([])).toBe('no_development');
    expect(statusOf([signal('branch', 'active')])).toBe('branch_created');
    expect(statusOf([signal('branch'), signal('commit')])).toBe('commits');
    expect(statusOf([signal('commit'), signal('pull_request', 'draft')])).toBe('pr_open');
    expect(statusOf([signal('pull_request', 'open'), signal('pull_request', 'approved')])).toBe(
      'pr_approved',
    );
    expect(statusOf([signal('pull_request', 'approved'), signal('pull_request', 'merged')])).toBe(
      'merged',
    );
    expect(statusOf([signal('pull_request', 'merged'), signal('build', 'running')])).toBe(
      'build_running',
    );
    expect(statusOf([signal('build', 'passed'), signal('pull_request', 'open')])).toBe(
      'build_passed',
    );
    expect(statusOf([signal('build', 'failed'), signal('deployment', 'succeeded')])).toBe(
      'deployed',
    );
    expect(DEVELOPMENT_STATUS_VALUES.at(-1)).toBe('deployed');
  });

  it('shows a failed latest build over commits and pull requests, and follows the latest build', () => {
    const failed = signal('build', 'failed', 1);
    const summary = computeDevelopmentStatus([
      signal('commit'),
      signal('pull_request', 'merged'),
      signal('build', 'passed', 10),
      failed,
    ]);
    expect(summary.status).toBe('build_failed');
    expect(summary.evidence).toEqual([failed.id]);
    expect(statusOf([signal('build', 'failed', 10), signal('build', 'passed', 1)])).toBe(
      'build_passed',
    );
    expect(statusOf([signal('build', 'cancelled'), signal('commit')])).toBe('commits');
  });

  it('ignores closed PRs, deleted branches and unsuccessful deployments', () => {
    expect(statusOf([signal('pull_request', 'closed'), signal('commit')])).toBe('commits');
    expect(statusOf([signal('branch', 'deleted')])).toBe('no_development');
    expect(
      statusOf([
        signal('deployment', 'failed'),
        signal('deployment', 'rolled_back'),
        signal('build', 'passed'),
      ]),
    ).toBe('build_passed');
  });

  it('is deterministic whatever the order of the links', () => {
    const signals = [
      signal('commit', null, 5),
      signal('pull_request', 'open', 4),
      signal('build', 'running', 3),
      signal('build', 'failed', 3),
      signal('branch', 'active', 9),
    ];
    const reference = computeDevelopmentStatus(signals);
    expect(computeDevelopmentStatus([...signals].reverse())).toEqual(reference);
    expect(
      computeDevelopmentStatus([signals[2]!, signals[0]!, signals[4]!, signals[3]!, signals[1]!]),
    ).toEqual(reference);
    expect(reference.counts).toEqual({
      branch: 1,
      commit: 1,
      pull_request: 1,
      build: 2,
      deployment: 0,
    });
    expect(reference.lastActivityAt).toBe('2027-01-01T11:57:00.000Z');
  });
});
