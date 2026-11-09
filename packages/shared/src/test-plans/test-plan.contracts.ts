import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { TestResultStatus } from '../test-runs/test-run.contracts.js';

/**
 * Test plans (S7-F1): the planning layer above suites and runs. A plan
 * groups suites and individual cases (its scope), environments, an optional
 * release and the runs that execute it. Starting the plan freezes the scope
 * as a versioned snapshot; progress, coverage and defects are derived on
 * read from the runs attached to the plan.
 *
 * draft → active → completed → archived; draft and active can be cancelled,
 * a draft can be archived directly. `archived` is terminal and read-only.
 */
export const TEST_PLAN_STATUSES = [
  'draft',
  'active',
  'completed',
  'cancelled',
  'archived',
] as const;
export type TestPlanStatus = (typeof TEST_PLAN_STATUSES)[number];

export const TEST_PLAN_TRANSITIONS: Record<TestPlanStatus, readonly TestPlanStatus[]> = {
  draft: ['active', 'cancelled', 'archived'],
  active: ['completed', 'cancelled'],
  completed: ['archived'],
  cancelled: ['archived'],
  archived: [],
};

export const TEST_PLAN_ACTIONS = ['start', 'complete', 'cancel', 'archive'] as const;
export type TestPlanAction = (typeof TEST_PLAN_ACTIONS)[number];
export const TEST_PLAN_ACTION_TARGET: Record<TestPlanAction, TestPlanStatus> = {
  start: 'active',
  complete: 'completed',
  cancel: 'cancelled',
  archive: 'archived',
};

export function canTransitionTestPlan(from: TestPlanStatus, to: TestPlanStatus): boolean {
  return TEST_PLAN_TRANSITIONS[from].includes(to);
}

/** Draft and active plans accept edits; the scope only while it is not frozen. */
export function isEditableTestPlan(status: TestPlanStatus): boolean {
  return status === 'draft' || status === 'active';
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a valid date');

const idSchema = z.string().min(1).max(64);
const ids = (max: number) =>
  z
    .array(idSchema)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'Duplicated ids');

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

export const createTestPlanSchema = z
  .object({
    projectId: idSchema,
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().max(20_000).nullish(),
    /** Defaults to the creator. */
    ownerId: idSchema.nullish(),
    releaseId: idSchema.nullish(),
    environmentIds: ids(20).default([]),
    suiteIds: ids(100).default([]),
    testCaseIds: ids(1000).default([]),
    startDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
  })
  .refine(datesInOrder, DATE_ORDER);
export type CreateTestPlanInput = z.infer<typeof createTestPlanSchema>;

export const updateTestPlanSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().max(20_000).nullish(),
    ownerId: idSchema.nullish(),
    releaseId: idSchema.nullish(),
    environmentIds: ids(20).optional(),
    /** Scope: refused once the plan is frozen. */
    suiteIds: ids(100).optional(),
    testCaseIds: ids(1000).optional(),
    startDate: isoDate.nullish(),
    endDate: isoDate.nullish(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update')
  .refine(datesInOrder, DATE_ORDER);
export type UpdateTestPlanInput = z.infer<typeof updateTestPlanSchema>;

export const testPlanActionSchema = z.object({ version: z.number().int().min(1).optional() });
export type TestPlanActionInput = z.infer<typeof testPlanActionSchema>;

export const attachPlanRunSchema = z.object({ testRunId: idSchema });
export type AttachPlanRunInput = z.infer<typeof attachPlanRunSchema>;

export const listTestPlansQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(TEST_PLAN_STATUSES).optional(),
  releaseId: idSchema.optional(),
  environmentId: idSchema.optional(),
  ownerId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListTestPlansQuery = z.infer<typeof listTestPlansQuerySchema>;

export interface TestPlanView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: TestPlanStatus;
  owner: { id: string; fullName: string } | null;
  release: { id: string; name: string; version: string } | null;
  environments: Array<{ id: string; name: string }>;
  suites: Array<{ id: string; name: string }>;
  directCases: Array<{ id: string; key: string; title: string }>;
  runs: Array<{ id: string; name: string; status: string; environment: string | null }>;
  startDate: string | null;
  endDate: string | null;
  scope: { frozen: boolean; version: number; frozenAt: string | null; caseCount: number };
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

export type PlanCaseSource = 'direct' | 'suite';

export interface PlanCaseProgress {
  testCaseId: string;
  key: string;
  title: string;
  suite: string | null;
  source: PlanCaseSource;
  /** The case version in the scope: frozen once the plan or cycle starts. */
  caseVersion: number;
  status: TestResultStatus;
  /** The plan run of the latest result, or the run that holds the case. */
  run: { id: string; name: string } | null;
  executedAt: string | null;
}

export interface PlanProgressCounts {
  untested: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  total: number;
  executed: number;
}

export interface TestPlanProgressView {
  plan: { id: string; name: string; status: TestPlanStatus };
  scope: { frozen: boolean; version: number };
  counts: PlanProgressCounts;
  /** Executed / total, in percent with one decimal. */
  completion: number;
  /** Passed / executed, in percent with one decimal; null with nothing executed. */
  passRate: number | null;
  /** Cases of the scope that are in at least one plan run. */
  coverage: { planned: number; total: number; percent: number };
  cases: PlanCaseProgress[];
  defects: {
    open: number;
    total: number;
    items: Array<{ id: string; key: string; title: string; severity: string; status: string }>;
  };
}

const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/** Pure aggregation over the scope: one row per case with its latest status. */
export function computePlanProgress(
  cases: ReadonlyArray<{ status: TestResultStatus; inRun: boolean }>,
): Pick<TestPlanProgressView, 'counts' | 'completion' | 'passRate' | 'coverage'> {
  const counts: PlanProgressCounts = {
    untested: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    total: cases.length,
    executed: 0,
  };
  let planned = 0;
  for (const entry of cases) {
    counts[entry.status] += 1;
    if (entry.inRun) {
      planned += 1;
    }
  }
  counts.executed = counts.total - counts.untested;
  return {
    counts,
    completion: percent(counts.executed, counts.total),
    passRate: counts.executed === 0 ? null : percent(counts.passed, counts.executed),
    coverage: { planned, total: counts.total, percent: percent(planned, counts.total) },
  };
}
