import { z } from 'zod';
import { ExternalReferenceView } from './jira-sync.contracts.js';

/**
 * What the client sees of the GitHub integration once it is connected (S2-F4).
 *
 * The automation side is read-only: qa-flow-hub never creates a repository, a
 * workflow or a run — CI does. What it does is *observe* a workflow run and
 * *import* the automated results it produced. Repositories, workflows, runs,
 * jobs and artifacts are described with the fields any CI exposes, so a
 * GitLab or Azure Pipelines adapter would fill the same views.
 */

export const GITHUB_SYNCABLE_ENTITIES = ['test_run', 'test_result'] as const;
export type GitHubSyncableEntity = (typeof GITHUB_SYNCABLE_ENTITIES)[number];
export const gitHubSyncableEntitySchema = z.enum(GITHUB_SYNCABLE_ENTITIES);

export const WORKFLOW_RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export type WorkflowRunStatusView = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_RUN_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
] as const;
export type WorkflowRunConclusionView = (typeof WORKFLOW_RUN_CONCLUSIONS)[number];

export interface ExternalRepositoryView {
  externalId: string;
  fullName: string;
  defaultBranch: string;
  url: string | null;
  isPrivate: boolean;
  updatedAt: string;
}

export interface ExternalBranchView {
  name: string;
  headSha: string;
  isProtected: boolean;
}

export interface ExternalWorkflowView {
  externalId: string;
  repositoryExternalId: string;
  name: string;
  path: string;
  state: 'active' | 'disabled';
}

export interface ExternalWorkflowRunView {
  externalId: string;
  repositoryExternalId: string;
  workflowExternalId: string;
  workflowName: string;
  runNumber: number;
  url: string | null;
  status: WorkflowRunStatusView;
  conclusion: WorkflowRunConclusionView | null;
  event: string;
  headBranch: string;
  headSha: string;
  commitMessage: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalJobStepView {
  name: string;
  status: WorkflowRunStatusView;
  conclusion: WorkflowRunConclusionView | null;
}

export interface ExternalJobView {
  externalId: string;
  runExternalId: string;
  name: string;
  status: WorkflowRunStatusView;
  conclusion: WorkflowRunConclusionView | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: ExternalJobStepView[];
}

export interface ExternalArtifactView {
  externalId: string;
  runExternalId: string;
  name: string;
  kind: 'playwright_report' | 'junit' | 'other';
  sizeInBytes: number;
  expired: boolean;
  url: string | null;
}

export interface AutomatedResultView {
  externalId: string;
  runExternalId: string;
  testIdentifier: string;
  caseTags: string[];
  framework: 'playwright' | 'other';
  file: string | null;
  project: string | null;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  durationMs: number | null;
  message: string | null;
  executedAt: string;
}

const externalIdSchema = z.string().trim().min(1).max(128);

export const repositoryQuerySchema = z.object({
  repositoryExternalId: externalIdSchema,
});
export type RepositoryQuery = z.infer<typeof repositoryQuerySchema>;

export const listWorkflowRunsQuerySchema = repositoryQuerySchema.extend({
  workflowExternalId: externalIdSchema.optional(),
});
export type ListWorkflowRunsQuery = z.infer<typeof listWorkflowRunsQuerySchema>;

export const workflowRunQuerySchema = repositoryQuerySchema.extend({
  runExternalId: externalIdSchema,
});
export type WorkflowRunQuery = z.infer<typeof workflowRunQuerySchema>;

/**
 * Run references are listed per project (the runs screen); result references
 * per run (the execution screen) — same split as TestRail, for the same
 * reason: a project-wide result list is the large download the roadmap forbids.
 */
export const listGitHubReferencesQuerySchema = z
  .object({
    entityType: gitHubSyncableEntitySchema,
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
export type ListGitHubReferencesQuery = z.infer<typeof listGitHubReferencesQuerySchema>;

/**
 * Linking a test run to a workflow run is a choice, so the first call names the
 * run; a later call without a body re-reads the run already linked (its status
 * and conclusion move while CI is running).
 */
export const linkWorkflowRunSchema = z
  .object({
    repositoryExternalId: externalIdSchema,
    runExternalId: externalIdSchema,
  })
  .strict();
export type LinkWorkflowRunInput = z.infer<typeof linkWorkflowRunSchema>;
/** The request body of a link call: absent (or `null`) means "refresh what is linked". */
export const optionalLinkWorkflowRunSchema = linkWorkflowRunSchema.nullish();
export type OptionalLinkWorkflowRunInput = z.infer<typeof optionalLinkWorkflowRunSchema>;

export type GitHubSyncAction = 'created' | 'updated' | 'unchanged';

export interface GitHubSyncResultView {
  entityType: GitHubSyncableEntity;
  entityId: string;
  action: GitHubSyncAction;
  reference: ExternalReferenceView;
}

/** Why an automated result produced no `TestResult`. */
export type AutomatedResultSkipReason =
  'no_case_tag' | 'case_not_in_run' | 'run_not_completed' | 'already_imported';

export interface SkippedAutomatedResultView {
  externalId: string;
  testIdentifier: string;
  caseTags: string[];
  reason: AutomatedResultSkipReason;
}

/**
 * Importing is a fan-out: one workflow run, many automated results, each one
 * either becoming a `TestResult` (with its own reference) or being reported
 * with the reason it did not. Nothing is silently dropped — a Playwright test
 * that nobody tagged is exactly what a QA lead wants to see listed.
 */
export interface ImportAutomatedResultsView {
  testRunId: string;
  workflowRun: ExternalReferenceView;
  imported: GitHubSyncResultView[];
  skipped: SkippedAutomatedResultView[];
}
