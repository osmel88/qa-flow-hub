import { describe, expect, it } from 'vitest';
import {
  canTransitionBuild,
  computeBuildMetrics,
  createBuildSchema,
  redactBuildMetadata,
  redactSecrets,
} from './build.contracts.js';

describe('build transitions', () => {
  it('moves forward only and never leaves a terminal status', () => {
    expect(canTransitionBuild('queued', 'running')).toBe(true);
    expect(canTransitionBuild(null, 'running')).toBe(true);
    expect(canTransitionBuild('running', 'passed')).toBe(true);
    expect(canTransitionBuild('queued', 'passed')).toBe(false);
    expect(canTransitionBuild('running', 'queued')).toBe(false);
    for (const terminal of ['passed', 'failed', 'cancelled']) {
      expect(canTransitionBuild(terminal, 'running')).toBe(false);
      expect(canTransitionBuild(terminal, 'passed')).toBe(false);
    }
  });

  it('accepts finishedAt only on finished builds, after startedAt', () => {
    const base = { projectId: 'p', identifier: 'b-1' };
    expect(
      createBuildSchema.safeParse({ ...base, finishedAt: '2027-01-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(
      createBuildSchema.safeParse({
        ...base,
        status: 'passed',
        startedAt: '2027-01-01T00:10:00Z',
        finishedAt: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('build metrics', () => {
  it('rates finished builds and summarises durations', () => {
    const at = (minutes: number) => new Date(Date.UTC(2027, 0, 1, 0, minutes)).toISOString();
    const metrics = computeBuildMetrics([
      { status: 'passed', startedAt: at(0), finishedAt: at(2) },
      { status: 'passed', startedAt: at(0), finishedAt: at(4) },
      { status: 'failed', startedAt: at(0), finishedAt: at(6) },
      { status: 'cancelled', startedAt: at(0), finishedAt: at(1) },
      { status: 'running', startedAt: at(0), finishedAt: null },
    ]);
    expect(metrics.total).toBe(5);
    expect(metrics.byStatus).toEqual({ queued: 0, running: 1, passed: 2, failed: 1, cancelled: 1 });
    expect([metrics.successRate, metrics.failureRate]).toEqual([0.667, 0.333]);
    expect(metrics.durationMs).toEqual({
      average: 240_000,
      median: 240_000,
      p85: 360_000,
      samples: 3,
    });
    expect(computeBuildMetrics([]).successRate).toBeNull();
  });
});

describe('secret redaction', () => {
  it('masks tokens, credentials and private keys', () => {
    const log = [
      'auth with ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Authorization: Bearer abc.def.ghi123',
      'password=hunter2 TOKEN: "s3cr3t"',
      'clone https://ci:pa55w0rd@git.example.test/repo.git',
      'key AKIAABCDEFGHIJKLMNOP done',
      'export NPM_TOKEN=abc123xyz',
    ].join('\n');
    const clean = redactSecrets(log);
    for (const secret of [
      'ghp_abcdef',
      'abc.def.ghi123',
      'hunter2',
      's3cr3t',
      'pa55w0rd',
      'AKIAABCDEFGHIJKLMNOP',
    ]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('https://ci:[redacted]@git.example.test/repo.git');
    expect(
      redactBuildMetadata({
        artifacts: [],
        facts: { apiToken: 'x', image: 'node:24', note: 'secret=abc' },
      }).facts,
    ).toEqual({ apiToken: '[redacted]', image: 'node:24', note: 'secret=[redacted]' });
  });
});
