import { describe, expect, it } from 'vitest';
import {
  analyticsQuerySchema,
  bucketStarts,
  compare,
  coverageKpis,
  emptyExecutionCounts,
  executionKpis,
  percentage,
  previousPeriod,
  resolveAnalyticsPeriod,
  truncateToBucket,
} from './analytics.contracts.js';

const now = new Date('2026-10-04T10:00:00.000Z');

describe('analytics period', () => {
  it('defaults to the last 30 days in daily buckets', () => {
    const period = resolveAnalyticsPeriod({}, now);

    expect(period.to).toEqual(now);
    expect(period.from).toEqual(new Date('2026-09-04T10:00:00.000Z'));
    expect(period.bucket).toBe('day');
  });

  it('extends forward from `from` when `to` is missing', () => {
    const period = resolveAnalyticsPeriod({ from: new Date('2026-01-01T00:00:00Z') }, now);

    expect(period.to).toEqual(new Date('2026-01-31T00:00:00Z'));
  });

  it('sizes the bucket to the window', () => {
    const week = resolveAnalyticsPeriod(
      { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') },
      now,
    );
    const month = resolveAnalyticsPeriod(
      { from: new Date('2025-10-04T00:00:00Z'), to: new Date('2026-10-04T00:00:00Z') },
      now,
    );

    expect(week.bucket).toBe('week');
    expect(month.bucket).toBe('month');
  });

  it('rejects an inverted or an oversized window', () => {
    expect(analyticsQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(analyticsQuerySchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(analyticsQuerySchema.safeParse({ bucket: 'hour' }).success).toBe(false);
    expect(analyticsQuerySchema.parse({ from: '2026-01-01', to: '2026-02-01' }).from).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });

  it('computes the previous window of the same length', () => {
    const period = resolveAnalyticsPeriod({}, now);
    const previous = previousPeriod(period);

    expect(previous.to).toEqual(period.from);
    expect(previous.from).toEqual(new Date('2026-08-05T10:00:00.000Z'));
  });
});

describe('buckets', () => {
  it('truncates like date_trunc in UTC, weeks starting on Monday', () => {
    const sunday = new Date('2026-10-04T23:59:00Z');

    expect(truncateToBucket(sunday, 'day')).toEqual(new Date('2026-10-04T00:00:00Z'));
    expect(truncateToBucket(sunday, 'week')).toEqual(new Date('2026-09-28T00:00:00Z'));
    expect(truncateToBucket(sunday, 'month')).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('lists every bucket overlapping the window', () => {
    const days = bucketStarts({
      from: new Date('2026-10-01T12:00:00Z'),
      to: new Date('2026-10-04T10:00:00Z'),
      bucket: 'day',
    });
    const months = bucketStarts({
      from: new Date('2026-11-15T00:00:00Z'),
      to: new Date('2027-02-01T00:00:00Z'),
      bucket: 'month',
    });

    expect(days.map((day) => day.toISOString().slice(0, 10))).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(months.map((month) => month.toISOString().slice(0, 7))).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });
});

describe('KPI formulas', () => {
  it('returns null rather than 0 when there is nothing to divide by', () => {
    const kpis = executionKpis(emptyExecutionCounts());

    expect(percentage(0, 0)).toBeNull();
    expect(kpis).toMatchObject({ planned: 0, passRate: null, progress: null });
    expect(coverageKpis(0, 0).percentage).toBeNull();
  });

  it('keeps untested and skipped out of the pass-rate denominator', () => {
    const kpis = executionKpis({ passed: 2, failed: 1, blocked: 1, skipped: 1, untested: 1 });

    expect(kpis).toMatchObject({
      planned: 6,
      executed: 5,
      pending: 1,
      verdicts: 4,
      passRate: 50,
      failedRate: 25,
      blockedRate: 25,
      skippedRate: 16.7,
      untestedRate: 16.7,
      progress: 83.3,
    });
  });

  it('a plan nobody executed has 0% progress and no pass rate', () => {
    const kpis = executionKpis({ ...emptyExecutionCounts(), untested: 4 });

    expect(kpis.progress).toBe(0);
    expect(kpis.passRate).toBeNull();
    expect(kpis.untestedRate).toBe(100);
  });

  it('derives uncovered and the coverage percentage', () => {
    expect(coverageKpis(3, 2)).toEqual({
      requirements: 3,
      covered: 2,
      uncovered: 1,
      percentage: 66.7,
    });
  });

  it('compares periods only when both sides exist', () => {
    expect(compare(75, 50)).toEqual({ current: 75, previous: 50, delta: 25 });
    expect(compare(75, null).delta).toBeNull();
  });
});
