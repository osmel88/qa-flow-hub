import { describe, expect, it } from 'vitest';
import {
  canTransitionTestPlan,
  computePlanProgress,
  createTestPlanSchema,
  updateTestPlanSchema,
} from './test-plan.contracts.js';

describe('test plans', () => {
  it('moves through the lifecycle and never leaves archived', () => {
    expect(canTransitionTestPlan('draft', 'active')).toBe(true);
    expect(canTransitionTestPlan('active', 'completed')).toBe(true);
    expect(canTransitionTestPlan('completed', 'active')).toBe(false);
    expect(canTransitionTestPlan('active', 'archived')).toBe(false);
    expect(canTransitionTestPlan('cancelled', 'archived')).toBe(true);
    expect(canTransitionTestPlan('archived', 'draft')).toBe(false);
  });

  it('derives counts, completion, pass rate and coverage', () => {
    const result = computePlanProgress([
      { status: 'passed', inRun: true },
      { status: 'failed', inRun: true },
      { status: 'blocked', inRun: true },
      { status: 'untested', inRun: true },
      { status: 'untested', inRun: false },
    ]);
    expect(result.counts).toEqual({
      untested: 2,
      passed: 1,
      failed: 1,
      blocked: 1,
      skipped: 0,
      total: 5,
      executed: 3,
    });
    expect([result.completion, result.passRate, result.coverage]).toEqual([
      60,
      33.3,
      { planned: 4, total: 5, percent: 80 },
    ]);
    expect(computePlanProgress([]).passRate).toBeNull();
  });

  it('validates dates, duplicates and empty updates', () => {
    expect(
      createTestPlanSchema.safeParse({
        projectId: 'p',
        name: 'Plan',
        startDate: '2027-02-02',
        endDate: '2027-02-01',
      }).success,
    ).toBe(false);
    expect(
      createTestPlanSchema.safeParse({ projectId: 'p', name: 'Plan', suiteIds: ['a', 'a'] })
        .success,
    ).toBe(false);
    expect(updateTestPlanSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
