import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { WorkItemStatus, WorkItemType } from '../work-items/work-item.contracts.js';

/**
 * Development links (S5-F1): internal, provider-neutral records of branches,
 * commits, pull requests, builds and deployments, related many-to-many to
 * work items. Only `local` is used today; other providers sync later through
 * adapters keyed by (provider, externalId).
 */
export const DEVELOPMENT_ARTIFACT_KINDS = [
  'branch',
  'commit',
  'pull_request',
  'build',
  'deployment',
] as const;
export type DevelopmentArtifactKind = (typeof DEVELOPMENT_ARTIFACT_KINDS)[number];

export const DEVELOPMENT_PROVIDERS = [
  'local',
  'github',
  'gitlab',
  'azure_devops',
  'bitbucket',
] as const;
export type DevelopmentProvider = (typeof DEVELOPMENT_PROVIDERS)[number];

/** Statuses each kind may carry; commits have none. */
export const DEVELOPMENT_STATUSES = {
  branch: ['active', 'merged', 'deleted'],
  commit: [],
  pull_request: ['draft', 'open', 'approved', 'merged', 'closed'],
  build: ['queued', 'running', 'passed', 'failed', 'cancelled'],
  deployment: ['pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'],
} as const satisfies Record<DevelopmentArtifactKind, readonly string[]>;

export const ALL_DEVELOPMENT_STATUSES = [
  ...new Set(Object.values(DEVELOPMENT_STATUSES).flat()),
] as string[];

export function statusesFor(kind: DevelopmentArtifactKind): readonly string[] {
  return DEVELOPMENT_STATUSES[kind];
}

export const DEVELOPMENT_LINK_MAX_ON_CREATE = 20;

const idSchema = z.string().min(1).max(64);
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

/** Only http(s): a stored URL is rendered as a link. */
export const developmentUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Use an http(s) URL' });

export const BRANCH_NAME_PATTERN = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9._\-/]+(?<!\/)$/;
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

const referenceFields = {
  branchName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(BRANCH_NAME_PATTERN, 'Not a valid branch name')
    .optional(),
  commitSha: z
    .string()
    .trim()
    .regex(COMMIT_SHA_PATTERN, 'A commit SHA is 7 to 64 hexadecimal characters')
    .transform((value) => value.toLowerCase())
    .optional(),
  prNumber: z.number().int().min(1).max(10_000_000).optional(),
  identifier: optionalText(200),
};

const descriptiveFields = {
  title: optionalText(300),
  url: developmentUrlSchema.optional(),
  environment: optionalText(100),
  status: z.string().trim().min(1).max(40).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
};

export const createDevelopmentArtifactSchema = z
  .object({
    projectId: idSchema,
    kind: z.enum(DEVELOPMENT_ARTIFACT_KINDS),
    provider: z.enum(DEVELOPMENT_PROVIDERS).default('local'),
    externalId: optionalText(200),
    ...referenceFields,
    ...descriptiveFields,
    /** Work items of the same project to link right away. */
    workItemIds: z.array(idSchema).max(DEVELOPMENT_LINK_MAX_ON_CREATE).default([]),
  })
  .superRefine((value, context) => {
    const required: Record<DevelopmentArtifactKind, keyof typeof referenceFields> = {
      branch: 'branchName',
      commit: 'commitSha',
      pull_request: 'prNumber',
      build: 'identifier',
      deployment: 'identifier',
    };
    const field = required[value.kind];
    if (value[field] === undefined) {
      context.addIssue({ code: 'custom', path: [field], message: `Required for a ${value.kind}` });
    }
    if (value.status !== undefined && !statusesFor(value.kind).includes(value.status)) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `A ${value.kind} has no status ${value.status}`,
      });
    }
    if (value.environment !== undefined && value.kind !== 'deployment') {
      context.addIssue({
        code: 'custom',
        path: ['environment'],
        message: 'Only deployments have an environment',
      });
    }
  });
export type CreateDevelopmentArtifactInput = z.infer<typeof createDevelopmentArtifactSchema>;

/** The reference (natural key) never changes; descriptive fields do. */
export const updateDevelopmentArtifactSchema = z
  .object({
    title: descriptiveFields.title.nullable(),
    url: descriptiveFields.url.nullable(),
    environment: descriptiveFields.environment.nullable(),
    status: descriptiveFields.status.nullable(),
    occurredAt: descriptiveFields.occurredAt.nullable(),
    version: z.number().int().positive().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateDevelopmentArtifactInput = z.infer<typeof updateDevelopmentArtifactSchema>;

export const listDevelopmentArtifactsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  kind: z.enum(DEVELOPMENT_ARTIFACT_KINDS).optional(),
  provider: z.enum(DEVELOPMENT_PROVIDERS).optional(),
  status: z.string().trim().min(1).max(40).optional(),
  /** Only artifacts linked to this work item, or `none` for unlinked ones. */
  workItemId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListDevelopmentArtifactsQuery = z.infer<typeof listDevelopmentArtifactsQuerySchema>;

export const linkDevelopmentWorkItemSchema = z.object({ workItemId: idSchema });
export type LinkDevelopmentWorkItemInput = z.infer<typeof linkDevelopmentWorkItemSchema>;

export const linkDevelopmentArtifactSchema = z.object({ artifactId: idSchema });
export type LinkDevelopmentArtifactInput = z.infer<typeof linkDevelopmentArtifactSchema>;

/** What makes two artifacts of one provider and kind the same. */
export function naturalKeyOf(
  input: Pick<
    CreateDevelopmentArtifactInput,
    'kind' | 'branchName' | 'commitSha' | 'prNumber' | 'identifier'
  >,
): string {
  switch (input.kind) {
    case 'branch':
      return input.branchName ?? '';
    case 'commit':
      return (input.commitSha ?? '').toLowerCase();
    case 'pull_request':
      return `#${input.prNumber ?? ''}`;
    default:
      return input.identifier ?? '';
  }
}

/** Short human reference: branch name, short SHA, #PR, identifier. */
export function artifactReference(
  artifact: Pick<
    DevelopmentArtifactView,
    'kind' | 'branchName' | 'commitSha' | 'prNumber' | 'identifier'
  >,
): string {
  switch (artifact.kind) {
    case 'branch':
      return artifact.branchName ?? '';
    case 'commit':
      return (artifact.commitSha ?? '').slice(0, 7);
    case 'pull_request':
      return `#${artifact.prNumber ?? ''}`;
    default:
      return artifact.identifier ?? '';
  }
}

export interface DevelopmentWorkItemRef {
  linkId: string;
  workItemId: string;
  key: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  linkedAt: string;
}

export interface DevelopmentArtifactView {
  id: string;
  projectId: string;
  kind: DevelopmentArtifactKind;
  provider: DevelopmentProvider;
  externalId: string | null;
  url: string | null;
  title: string | null;
  branchName: string | null;
  commitSha: string | null;
  prNumber: number | null;
  identifier: string | null;
  environment: string | null;
  status: string | null;
  occurredAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Live work items it relates to, in backlog order. */
  workItems: DevelopmentWorkItemRef[];
}

/** Development activity of one work item, linked artifacts newest first. */
export interface WorkItemDevelopmentView {
  workItemId: string;
  /** Derived development status and the artifacts that justify it (S5-F2). */
  summary: DevelopmentStatusSummary;
  artifacts: Array<DevelopmentArtifactView & { linkId: string; linkedAt: string }>;
  /** Count per kind, for the summary badges. */
  counts: Record<DevelopmentArtifactKind, number>;
}

export interface DevelopmentLinkResult {
  created: boolean;
  workItemId: string;
  artifactId: string;
}

// --- Development status (S5-F2) ---------------------------------------------

/**
 * Development status of a work item, derived on read from its live linked
 * artifacts (never stored). Listed from lowest to highest precedence: the
 * status is the highest one any signal reaches.
 */
export const DEVELOPMENT_STATUS_VALUES = [
  'no_development',
  'branch_created',
  'commits',
  'pr_open',
  'pr_approved',
  'merged',
  'build_running',
  'build_passed',
  'build_failed',
  'deployed',
] as const;
export type DevelopmentStatus = (typeof DEVELOPMENT_STATUS_VALUES)[number];

export const developmentStatusFilterSchema = z.enum(DEVELOPMENT_STATUS_VALUES);

/** What derivation needs of one live artifact linked to the item. */
export interface DevelopmentSignal {
  id: string;
  kind: DevelopmentArtifactKind;
  status: string | null;
  occurredAt: string | null;
  createdAt: string;
  /** Code reviews count as pull request signals but not as artifacts (S5-F3). */
  source?: 'artifact' | 'code_review';
}

export interface DevelopmentStatusSummary {
  status: DevelopmentStatus;
  /** Artifacts that justify the status, most recent first. */
  evidence: string[];
  counts: Record<DevelopmentArtifactKind, number>;
  lastActivityAt: string | null;
}

const at = (signal: DevelopmentSignal): number => +new Date(signal.occurredAt ?? signal.createdAt);
/** Most recent first; ties broken by id so the order never depends on the query. */
const newestFirst = (a: DevelopmentSignal, b: DevelopmentSignal): number =>
  at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Precedence (highest first): a succeeded deployment; the latest build that
 * ran (failed, passed or running/queued); a merged, approved, open or draft
 * pull request; commits; a branch that was not deleted. Closed pull requests,
 * cancelled builds and failed or pending deployments never raise the status.
 */
export function computeDevelopmentStatus(
  signals: readonly DevelopmentSignal[],
): DevelopmentStatusSummary {
  const sorted = [...signals].sort(newestFirst);
  const counts = Object.fromEntries(DEVELOPMENT_ARTIFACT_KINDS.map((kind) => [kind, 0])) as Record<
    DevelopmentArtifactKind,
    number
  >;
  for (const signal of sorted) {
    if (signal.source !== 'code_review') {
      counts[signal.kind] += 1;
    }
  }
  const first = sorted[0];
  const lastActivityAt = first === undefined ? null : new Date(at(first)).toISOString();
  const result = (status: DevelopmentStatus, evidence: DevelopmentSignal[]) => ({
    status,
    evidence: evidence.map((signal) => signal.id),
    counts,
    lastActivityAt,
  });
  const of = (kind: DevelopmentArtifactKind, statuses?: readonly string[]) =>
    sorted.filter(
      (signal) =>
        signal.kind === kind &&
        (statuses === undefined || (signal.status !== null && statuses.includes(signal.status))),
    );

  const deployed = of('deployment', ['succeeded']);
  if (deployed.length > 0) {
    return result('deployed', deployed);
  }
  const build = of('build', ['queued', 'running', 'passed', 'failed'])[0];
  if (build !== undefined) {
    return result(
      build.status === 'failed'
        ? 'build_failed'
        : build.status === 'passed'
          ? 'build_passed'
          : 'build_running',
      [build],
    );
  }
  for (const [status, prStatuses] of [
    ['merged', ['merged']],
    ['pr_approved', ['approved']],
    ['pr_open', ['open', 'draft']],
  ] as const) {
    const prs = of('pull_request', prStatuses);
    if (prs.length > 0) {
      return result(status, prs);
    }
  }
  const commits = of('commit');
  if (commits.length > 0) {
    return result('commits', commits);
  }
  const branches = of('branch').filter((signal) => signal.status !== 'deleted');
  if (branches.length > 0) {
    return result('branch_created', branches);
  }
  return result('no_development', []);
}

/** Work items of a project per development status (Development page). */
export interface DevelopmentSummaryView {
  projectId: string;
  /** Live, not cancelled work items per status. */
  workItems: Record<DevelopmentStatus, number>;
  /** Live artifacts per kind. */
  artifacts: Record<DevelopmentArtifactKind, number>;
}

export const developmentSummaryQuerySchema = z.object({ projectId: idSchema });
