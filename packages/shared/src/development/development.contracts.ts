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
  pull_request: ['draft', 'open', 'merged', 'closed'],
  build: ['queued', 'running', 'succeeded', 'failed', 'cancelled'],
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
  artifacts: Array<DevelopmentArtifactView & { linkId: string; linkedAt: string }>;
  /** Count per kind, for the summary badges. */
  counts: Record<DevelopmentArtifactKind, number>;
}

export interface DevelopmentLinkResult {
  created: boolean;
  workItemId: string;
  artifactId: string;
}
