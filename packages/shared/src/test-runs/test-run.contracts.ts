import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';

export const TEST_RUN_STATUSES = ['planned', 'in_progress', 'completed', 'aborted'] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export const TEST_RESULT_STATUSES = [
  'untested',
  'passed',
  'failed',
  'blocked',
  'skipped',
] as const;
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number];

/** `untested` is the absence of a result; it cannot be recorded as one. */
export const RECORDABLE_RESULT_STATUSES = [
  'passed',
  'failed',
  'blocked',
  'skipped',
] as const;
export type RecordableResultStatus = (typeof RECORDABLE_RESULT_STATUSES)[number];

/**
 * Which cases go into the run. Explicit ids or a filter, never both: "these
 * twelve cases" and "everything tagged smoke" are different intents, and
 * silently combining them would surprise whoever wrote the second one.
 */
export const runCaseSelectionSchema = z
  .object({
    testCaseIds: z.array(z.string().min(1)).min(1).max(1000).optional(),
    suiteId: z.string().min(1).optional(),
    sectionId: z.string().min(1).optional(),
    tag: z.string().trim().toLowerCase().min(1).max(32).optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  })
  .refine(
    (value) =>
      value.testCaseIds === undefined ||
      (value.suiteId === undefined &&
        value.sectionId === undefined &&
        value.tag === undefined &&
        value.priority === undefined),
    { message: 'Select cases either by id or by filter, not both' },
  );
export type RunCaseSelection = z.infer<typeof runCaseSelectionSchema>;

export const createTestRunSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(3).max(160),
  description: z.string().trim().max(20_000).nullish(),
  milestone: z.string().trim().max(120).nullish(),
  environment: z.string().trim().max(120).nullish(),
  selection: runCaseSelectionSchema.optional(),
});
export type CreateTestRunInput = z.infer<typeof createTestRunSchema>;

export const updateTestRunSchema = z
  .object({
    name: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().max(20_000).nullish(),
    milestone: z.string().trim().max(120).nullish(),
    environment: z.string().trim().max(120).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateTestRunInput = z.infer<typeof updateTestRunSchema>;

export const addRunCasesSchema = z.object({ selection: runCaseSelectionSchema });
export type AddRunCasesInput = z.infer<typeof addRunCasesSchema>;

export const assignRunCasesSchema = z.object({
  runCaseIds: z.array(z.string().min(1)).min(1).max(1000),
  /** `null` unassigns, which is why this is nullable rather than optional. */
  assignedToId: z.string().min(1).nullable(),
});
export type AssignRunCasesInput = z.infer<typeof assignRunCasesSchema>;

export const stepResultSchema = z.object({
  position: z.number().int().min(1),
  status: z.enum(RECORDABLE_RESULT_STATUSES),
  comment: z.string().trim().max(2000).nullish(),
});
export type StepResultInput = z.infer<typeof stepResultSchema>;

export const recordResultSchema = z.object({
  status: z.enum(RECORDABLE_RESULT_STATUSES),
  comment: z.string().trim().max(20_000).nullish(),
  elapsedSeconds: z.number().int().min(0).max(86_400).nullish(),
  stepResults: z.array(stepResultSchema).max(100).optional(),
});
export type RecordResultInput = z.infer<typeof recordResultSchema>;

export const listTestRunsQuerySchema = paginationQuerySchema.extend({
  projectId: z.string().min(1),
  status: z.enum(TEST_RUN_STATUSES).optional(),
  milestone: z.string().trim().max(120).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListTestRunsQuery = z.infer<typeof listTestRunsQuerySchema>;

export const listRunCasesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(TEST_RESULT_STATUSES).optional(),
  assignedToId: z.string().min(1).optional(),
});
export type ListRunCasesQuery = z.infer<typeof listRunCasesQuerySchema>;

export type RunProgress = Record<TestResultStatus, number> & {
  total: number;
  executed: number;
  /** Percentage of cases with any result, rounded to one decimal. */
  completion: number;
};

export interface TestRunView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  milestone: string | null;
  environment: string | null;
  status: TestRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  progress: RunProgress;
}

export interface RunCaseSnapshot {
  key: string;
  title: string;
  preconditions: string | null;
  expectedResult: string | null;
  priority: string;
  type: string;
  steps: Array<{ position: number; action: string; expectedResult: string | null }>;
}

export interface RunCaseView {
  id: string;
  testRunId: string;
  testCaseId: string;
  caseVersion: number;
  snapshot: RunCaseSnapshot;
  assignedToId: string | null;
  latestStatus: TestResultStatus;
  position: number;
}

export interface TestResultView {
  id: string;
  testRunCaseId: string;
  status: RecordableResultStatus;
  comment: string | null;
  elapsedSeconds: number | null;
  stepResults: StepResultInput[] | null;
  executedById: string | null;
  executedAt: string;
}
