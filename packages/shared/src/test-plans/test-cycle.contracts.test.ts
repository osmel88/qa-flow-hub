import { describe, expect, it } from 'vitest';
import {
  canTransitionTestCycle,
  createTestCycleSchema,
  isEditableTestCycle,
  updateTestCycleSchema,
} from './test-cycle.contracts.js';

describe('test cycles', () => {
  it('moves through the lifecycle and never leaves archived', () => {
    expect(canTransitionTestCycle('planned', 'active')).toBe(true);
    expect(canTransitionTestCycle('active', 'completed')).toBe(true);
    expect(canTransitionTestCycle('active', 'archived')).toBe(false);
    expect(canTransitionTestCycle('completed', 'active')).toBe(false);
    expect(canTransitionTestCycle('cancelled', 'archived')).toBe(true);
    expect(canTransitionTestCycle('archived', 'planned')).toBe(false);
    expect([isEditableTestCycle('active'), isEditableTestCycle('completed')]).toEqual([
      true,
      false,
    ]);
  });

  it('validates names, dates and empty updates', () => {
    expect(createTestCycleSchema.safeParse({ testPlanId: 'p', name: 'C1' }).success).toBe(false);
    expect(
      createTestCycleSchema.safeParse({
        testPlanId: 'p',
        name: 'Cycle 1',
        startDate: '2027-03-02',
        endDate: '2027-03-01',
      }).success,
    ).toBe(false);
    expect(updateTestCycleSchema.safeParse({ version: 3 }).success).toBe(false);
  });
});
