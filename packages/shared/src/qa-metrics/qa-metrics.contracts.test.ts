import { describe, expect, it } from 'vitest';
import {
  QA_METRICS_MIN_EXECUTED_FOR_DENSITY,
  defectDensity,
  qaMetricsQuerySchema,
  sampledRates,
} from './qa-metrics.contracts.js';

describe('QA metrics', () => {
  it('hides rates below the minimum sample and flags it', () => {
    expect(
      sampledRates({ verdicts: 0, passRate: null, failedRate: null, blockedRate: null }),
    ).toEqual({ passRate: null, failedRate: null, blockedRate: null, insufficientData: false });
    expect(sampledRates({ verdicts: 4, passRate: 75, failedRate: 25, blockedRate: 0 })).toEqual({
      passRate: null,
      failedRate: null,
      blockedRate: null,
      insufficientData: true,
    });
    expect(sampledRates({ verdicts: 5, passRate: 60, failedRate: 20, blockedRate: 20 })).toEqual({
      passRate: 60,
      failedRate: 20,
      blockedRate: 20,
      insufficientData: false,
    });
  });

  it('computes defect density only with enough executed cases', () => {
    expect(defectDensity(3, QA_METRICS_MIN_EXECUTED_FOR_DENSITY - 1)).toBeNull();
    expect(defectDensity(3, 20)).toBe(0.15);
    expect(defectDensity(0, 40)).toBe(0);
  });

  it('validates the window and the filters', () => {
    expect(qaMetricsQuerySchema.safeParse({ from: '2027-02-01', to: '2027-01-01' }).success).toBe(
      false,
    );
    expect(qaMetricsQuerySchema.safeParse({ testPlanId: '' }).success).toBe(false);
    expect(qaMetricsQuerySchema.parse({ releaseId: 'r1' }).releaseId).toBe('r1');
  });
});
