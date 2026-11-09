import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { TestPlanProgressView } from './test-plan.contracts.js';

/**
 * Test cycles (S7-F2): a planned execution inside a test plan, optionally for
 * one environment and release. While `planned` its scope is the plan's;
 * starting it copies the plan's scope into its own frozen snapshot, so later
 * plan changes (a scope refresh, new suites) never alter a running or past
 * cycle. Progress is derived on read from the runs attached to the cycle.
 *
 * planned → active → completed → archived; planned and active can be
 * cancelled, a planned cycle can be archived directly.
 */
export const TEST_CYCLE_STATUSES = [
  'planned',
  'active',
  'completed',
  'cancelled',
  'archived',
] as const;
export type TestCycleStatus = (typeof TEST_CYCLE_STATUSES)[number];

export const TEST_CYCLE_TRANSITIONS: Record<TestCycleStatus, readonly TestCycleStatus[]> = {
  planned: ['active', 'cancelled', 'archived'],
  active: ['completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

export const TEST_CYCLE_ACTIONS = ['start', 'complete', 'cancel', 'archive'] as const;
export type TestCycleAction = (typeof TEST_CYCLE_ACTIONS)[number];
export const TEST_CYCLE_ACTION_TARGET: Record<TestCycleAction, TestCycleStatus> = {
  start: 'active',
  complete: 'completed',
  cancel: 'cancelled',
  archive: 'archived',
};

export function canTransitionTestCycle(from: TestCycleStatus, to: TestCycleStatus): boolean {
  return TEST_CYCLE_TRANSITIONS[from].includes(to);
}

export function isEditableTestCycle(status: TestCycleStatus): boolean {
  return status === 'planned' || status === 'active';
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a valid date');
const idSchema = z.string().min(1).max(64);

function datesInOrder(value: {
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
}): boolean {
  return (
    value.startDate === undefined ||
    value.startDate === null ||
    value.endDate === undefined ||
    value.endDate === null ||
    value.startDate <= value.endDate
  );
}
const DATE_ORDER = { message: 'The end date cannot be before the start date', path: ['endDate'] };

export const createTestCycleSchema = z
  .object({
    testPlanId: idSchema,
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().max(20_000).nullish(),
    /** Defaults to the creator. */
    ownerId: idSchema.nullish(),
    environmentId: idSchema.nullish(),
    /** Defaults to the plan's release. */
    releaseId: idSchema.nullish(),
    startDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
  })
  .refine(datesInOrder, DATE_ORDER);
export type CreateTestCycleInput = z.infer<typeof createTestCycleSchema>;

export const updateTestCycleSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().max(20_000).nullish(),
    ownerId: idSchema.nullish(),
    /** Execution target: refused once the cycle is frozen. */
    environmentId: idSchema.nullish(),
    releaseId: idSchema.nullish(),
    startDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update')
  .refine(datesInOrder, DATE_ORDER);
export type UpdateTestCycleInput = z.infer<typeof updateTestCycleSchema>;

export const testCycleActionSchema = z.object({ version: z.number().int().min(1).optional() });
export type TestCycleActionInput = z.infer<typeof testCycleActionSchema>;

export const attachCycleRunSchema = z.object({ testRunId: idSchema });
export type AttachCycleRunInput = z.infer<typeof attachCycleRunSchema>;

export const listTestCyclesQuerySchema = paginationQuerySchema.extend({
  testPlanId: idSchema,
  status: z.enum(TEST_CYCLE_STATUSES).optional(),
  environmentId: idSchema.optional(),
  releaseId: idSchema.optional(),
  ownerId: idSchema.optional(),
});
export type ListTestCyclesQuery = z.infer<typeof listTestCyclesQuerySchema>;

export interface TestCycleView {
  id: string;
  projectId: string;
  testPlan: { id: string; name: string; status: string };
  name: string;
  description: string | null;
  status: TestCycleStatus;
  owner: { id: string; fullName: string } | null;
  environment: { id: string; name: string } | null;
  release: { id: string; name: string; version: string } | null;
  runs: Array<{ id: string; name: string; status: string; environment: string | null }>;
  startDate: string | null;
  endDate: string | null;
  /** `planVersion`: the plan scope version the cycle copied when it started. */
  scope: {
    frozen: boolean;
    frozenAt: string | null;
    planVersion: number | null;
    caseCount: number;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

export type TestCycleProgressView = Omit<TestPlanProgressView, 'plan' | 'scope'> & {
  cycle: { id: string; name: string; status: TestCycleStatus };
  scope: { frozen: boolean; planVersion: number | null };
};
