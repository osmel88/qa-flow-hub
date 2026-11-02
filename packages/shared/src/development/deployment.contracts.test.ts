import { describe, expect, it } from 'vitest';
import { canTransitionDeployment, computeDeploymentMetrics } from './deployment.contracts.js';
import { computeDevelopmentStatus } from './development.contracts.js';

describe('deployment transitions', () => {
  it('moves forward only; terminals never move', () => {
    expect(canTransitionDeployment(null, 'deploying')).toBe(true);
    expect(canTransitionDeployment('pending', 'succeeded')).toBe(false);
    expect(canTransitionDeployment('deploying', 'succeeded')).toBe(true);
    for (const terminal of ['succeeded', 'failed', 'rolled_back', 'cancelled']) {
      expect(canTransitionDeployment(terminal, 'deploying')).toBe(false);
      expect(canTransitionDeployment(terminal, 'succeeded')).toBe(false);
    }
  });

  it('counts a rolled back deployment as no longer deployed', () => {
    const signal = (status: string, id: string) => ({
      id,
      kind: 'deployment' as const,
      status,
      occurredAt: null,
      createdAt: '2027-01-01T00:00:00.000Z',
    });
    expect(computeDevelopmentStatus([signal('rolled_back', 'a')]).status).toBe('no_development');
    expect(
      computeDevelopmentStatus([signal('rolled_back', 'a'), signal('succeeded', 'b')]).status,
    ).toBe('deployed');
  });
});

describe('deployment metrics', () => {
  it('rates finished deployments and counts rollbacks', () => {
    const at = (minutes: number) => new Date(Date.UTC(2027, 0, 1, 0, minutes)).toISOString();
    const metrics = computeDeploymentMetrics([
      { status: 'rolled_back', startedAt: at(0), finishedAt: at(2) },
      { status: 'succeeded', startedAt: at(0), finishedAt: at(4), rollbackOfId: 'x' },
      { status: 'failed', startedAt: at(0), finishedAt: at(6) },
      { status: 'cancelled', startedAt: null, finishedAt: null },
    ]);
    expect([metrics.successRate, metrics.failureRate, metrics.rollbacks]).toEqual([
      0.667, 0.333, 1,
    ]);
    expect(metrics.durationMs).toEqual({
      average: 240_000,
      median: 240_000,
      p85: 360_000,
      samples: 3,
    });
  });
});
