import { z } from 'zod';
import { ExternalReferenceView } from './jira-sync.contracts.js';

/**
 * What the client sees of the TestRail integration once it is connected (S2-F3).
 *
 * Suites, cases, runs and results are described with the fields any test
 * management tool has; nothing here is TestRail's own vocabulary (no
 * `section_id`, no `status_id`), which is what keeps the contract usable for
 * Xray or Zephyr later.
 */

export const TESTRAIL_SYNCABLE_ENTITIES = [
  'test_suite',
  'test_case',
  'test_run',
  'test_result',
] as const;
export type TestRailSyncableEntity = (typeof TESTRAIL_SYNCABLE_ENTITIES)[number];
export const testRailSyncableEntitySchema = z.enum(TESTRAIL_SYNCABLE_ENTITIES);

export interface ExternalSuiteView {
  externalId: string;
  projectKey: string | null;
  name: string;
  description: string | null;
  url: string | null;
  caseCount: number;
  updatedAt: string;
}

export interface ExternalCaseView {
  externalId: string;
  key: string | null;
  url: string | null;
  suiteExternalId: string;
  sectionName: string | null;
  title: string;
  type: string;
  priority: string;
  stepCount: number;
  updatedAt: string;
}

export interface ExternalRunView {
  externalId: string;
  url: string | null;
  suiteExternalId: string;
  name: string;
  status: string;
  caseCount: number;
  statusCounts: Record<string, number>;
  updatedAt: string;
}

export interface ExternalResultView {
  externalId: string;
  runExternalId: string;
  caseExternalId: string;
  status: string;
  comment: string | null;
  elapsedSeconds: number | null;
  recordedAt: string;
}

export interface TestManagementCatalogView {
  statuses: string[];
  priorities: string[];
  caseTypes: string[];
}

export const listExternalSuitesQuerySchema = z.object({
  projectKey: z.string().trim().min(1).max(32).optional(),
});
export type ListExternalSuitesQuery = z.infer<typeof listExternalSuitesQuerySchema>;

export const listExternalCasesQuerySchema = z.object({
  suiteExternalId: z.string().trim().min(1).max(64),
});
export type ListExternalCasesQuery = z.infer<typeof listExternalCasesQuerySchema>;

/**
 * References are listed per project for suites, cases and runs, and per run for
 * results — the screen that shows results is the run execution screen, and a
 * project-wide result list would be the large download the roadmap forbids.
 */
export const listTestRailReferencesQuerySchema = z
  .object({
    entityType: testRailSyncableEntitySchema,
    projectId: z.string().min(1).optional(),
    testRunId: z.string().min(1).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.entityType === 'test_result') {
      if (query.testRunId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['testRunId'],
          message: 'testRunId is required for test_result references',
        });
      }
    } else if (query.projectId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projectId'],
        message: 'projectId is required',
      });
    }
  });
export type ListTestRailReferencesQuery = z.infer<typeof listTestRailReferencesQuerySchema>;

export type TestRailSyncAction = 'created' | 'updated' | 'unchanged';

/**
 * A sync of one entity may have to sync what it depends on first (a case needs
 * its suite, a result needs its run). Those dependent references are returned
 * so the client can refresh every column at once instead of discovering them.
 */
export interface TestRailSyncResultView {
  entityType: TestRailSyncableEntity;
  entityId: string;
  action: TestRailSyncAction;
  reference: ExternalReferenceView;
  dependencies: ExternalReferenceView[];
}
