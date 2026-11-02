import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import {
  COMMIT_SHA_PATTERN,
  BRANCH_NAME_PATTERN,
  DEVELOPMENT_LINK_MAX_ON_CREATE,
  DEVELOPMENT_PROVIDERS,
  developmentUrlSchema,
} from './development.contracts.js';
import type { DevelopmentArtifactView } from './development.contracts.js';

/**
 * Builds (S5-F4): the `build` development artifact with the fields of a CI
 * run. One record, so links, development status and isolation are the ones
 * of S5-F1/S5-F2. Providers other than `local` sync later through adapters
 * keyed by (provider, externalId); a repeated report is idempotent.
 */
export const BUILD_STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const BUILD_TERMINAL_STATUSES: readonly BuildStatus[] = ['passed', 'failed', 'cancelled'];

/** Valid moves; terminal statuses go nowhere (no re-run of the same build). */
export const BUILD_TRANSITIONS: Record<BuildStatus, readonly BuildStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['passed', 'failed', 'cancelled'],
  passed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalBuildStatus(status: string | null): boolean {
  return status !== null && (BUILD_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** A build without a status counts as queued. */
export function canTransitionBuild(from: string | null, to: BuildStatus): boolean {
  const current = (from ?? 'queued') as BuildStatus;
  return (BUILD_TRANSITIONS[current] ?? []).includes(to);
}

export const BUILD_TRIGGERS = [
  'push',
  'pull_request',
  'manual',
  'schedule',
  'api',
  'other',
] as const;
export type BuildTrigger = (typeof BUILD_TRIGGERS)[number];

export const BUILD_LOG_SUMMARY_MAX = 20_000;

const idSchema = z.string().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);

export const buildArtifactSchema = z.object({
  name: text(200),
  url: developmentUrlSchema.optional(),
  sizeBytes: z.number().int().min(0).max(1e13).optional(),
  checksum: text(200).optional(),
});

/** Artifacts produced by the build and a few flat facts; never secrets. */
export const buildMetadataSchema = z.object({
  artifacts: z.array(buildArtifactSchema).max(50).default([]),
  facts: z
    .record(
      z.string().trim().min(1).max(60),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((value) => Object.keys(value).length <= 30, 'At most 30 facts')
    .default({}),
});
export type BuildMetadata = z.infer<typeof buildMetadataSchema>;

const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(BRANCH_NAME_PATTERN, 'Not a valid branch name');
const shaSchema = z
  .string()
  .trim()
  .regex(COMMIT_SHA_PATTERN, 'A commit SHA is 7 to 64 hexadecimal characters')
  .transform((value) => value.toLowerCase());
const dateSchema = z.string().datetime({ offset: true });

export const createBuildSchema = z
  .object({
    projectId: idSchema,
    identifier: text(200),
    provider: z.enum(DEVELOPMENT_PROVIDERS).default('local'),
    externalId: text(200).optional(),
    title: text(300).optional(),
    url: developmentUrlSchema.optional(),
    branchName: branchSchema.optional(),
    commitSha: shaSchema.optional(),
    status: z.enum(BUILD_STATUSES).default('queued'),
    trigger: z.enum(BUILD_TRIGGERS).default('manual'),
    startedAt: dateSchema.optional(),
    finishedAt: dateSchema.optional(),
    releaseId: idSchema.optional(),
    workItemIds: z.array(idSchema).max(DEVELOPMENT_LINK_MAX_ON_CREATE).default([]),
    metadata: buildMetadataSchema.optional(),
    logSummary: z.string().trim().min(1).max(BUILD_LOG_SUMMARY_MAX).optional(),
  })
  .superRefine((value, context) => {
    if (value.finishedAt !== undefined && !isTerminalBuildStatus(value.status)) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'Only a finished build has finishedAt',
      });
    }
    if (
      value.startedAt !== undefined &&
      value.finishedAt !== undefined &&
      Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt is before startedAt',
      });
    }
  });
export type CreateBuildInput = z.infer<typeof createBuildSchema>;

export const updateBuildSchema = z
  .object({
    title: text(300).nullable().optional(),
    url: developmentUrlSchema.nullable().optional(),
    branchName: branchSchema.nullable().optional(),
    commitSha: shaSchema.nullable().optional(),
    releaseId: idSchema.nullable().optional(),
    metadata: buildMetadataSchema.nullable().optional(),
    logSummary: z.string().trim().min(1).max(BUILD_LOG_SUMMARY_MAX).nullable().optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateBuildInput = z.infer<typeof updateBuildSchema>;

export const transitionBuildSchema = z.object({
  status: z.enum(BUILD_STATUSES),
  /** When it happened; now by default. */
  at: dateSchema.optional(),
  logSummary: z.string().trim().min(1).max(BUILD_LOG_SUMMARY_MAX).optional(),
  version: z.number().int().positive().optional(),
});
export type TransitionBuildInput = z.infer<typeof transitionBuildSchema>;

export const listBuildsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(BUILD_STATUSES).optional(),
  provider: z.enum(DEVELOPMENT_PROVIDERS).optional(),
  branch: z.string().trim().min(1).max(255).optional(),
  /** A release id, or `none` for builds of no release. */
  releaseId: idSchema.optional(),
  workItemId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListBuildsQuery = z.infer<typeof listBuildsQuerySchema>;

export const buildMetricsQuerySchema = z.object({
  projectId: idSchema,
  branch: z.string().trim().min(1).max(255).optional(),
  releaseId: idSchema.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type BuildMetricsQuery = z.infer<typeof buildMetricsQuerySchema>;

export interface BuildView extends DevelopmentArtifactView {
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: BuildTrigger | null;
  release: { id: string; name: string; version: string } | null;
  metadata: BuildMetadata | null;
  logSummary: string | null;
  /** Live branch and commit artifacts of the project this build ran on. */
  related: { branchId: string | null; commitId: string | null };
}

export interface CreateBuildResult {
  /** False when the provider already reported this externalId. */
  created: boolean;
  build: BuildView;
}

export interface BuildMetricsView {
  projectId: string;
  windowDays: number;
  total: number;
  byStatus: Record<BuildStatus, number>;
  /** Passed / (passed + failed); cancelled builds do not count. Null without finished builds. */
  successRate: number | null;
  failureRate: number | null;
  durationMs: {
    average: number | null;
    median: number | null;
    p85: number | null;
    samples: number;
  };
}

export function buildDurationMs(
  startedAt: Date | string | null,
  finishedAt: Date | string | null,
): number | null {
  if (startedAt === null || finishedAt === null) {
    return null;
  }
  return Math.max(0, +new Date(finishedAt) - +new Date(startedAt));
}

const percentile = (sorted: readonly number[], fraction: number): number | null =>
  sorted.length === 0
    ? null
    : (sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null);

export function computeBuildMetrics(
  builds: ReadonlyArray<{
    status: string | null;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
  }>,
): Omit<BuildMetricsView, 'projectId' | 'windowDays'> {
  const byStatus = Object.fromEntries(BUILD_STATUSES.map((status) => [status, 0])) as Record<
    BuildStatus,
    number
  >;
  const durations: number[] = [];
  for (const build of builds) {
    const status = (build.status ?? 'queued') as BuildStatus;
    if (status in byStatus) {
      byStatus[status] += 1;
    }
    const duration = buildDurationMs(build.startedAt, build.finishedAt);
    if (duration !== null && (status === 'passed' || status === 'failed')) {
      durations.push(duration);
    }
  }
  durations.sort((a, b) => a - b);
  const decided = byStatus.passed + byStatus.failed;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    total: builds.length,
    byStatus,
    successRate: decided === 0 ? null : round(byStatus.passed / decided),
    failureRate: decided === 0 ? null : round(byStatus.failed / decided),
    durationMs: {
      average:
        durations.length === 0
          ? null
          : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      median: percentile(durations, 0.5),
      p85: percentile(durations, 0.85),
      samples: durations.length,
    },
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{16,}|qfh_[A-Za-z0-9_-]{16,})\b/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
  /(\b[A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /(\bhttps?:\/\/[^/\s:@]+:)[^/\s@]+@/gi,
];

export const SECRET_PLACEHOLDER = '[redacted]';

/** Masks credentials a CI log or metadata may carry, before anything is stored. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match: string, prefix?: string) =>
      typeof prefix === 'string' && match.startsWith(prefix)
        ? `${prefix}${SECRET_PLACEHOLDER}${prefix.startsWith('http') ? '@' : ''}`
        : SECRET_PLACEHOLDER,
    );
  }
  return result;
}

const SENSITIVE_FACT = /pass|secret|token|key|credential|auth/i;

export function redactBuildMetadata(metadata: BuildMetadata): BuildMetadata {
  return {
    artifacts: metadata.artifacts.map((artifact) => ({
      ...artifact,
      name: redactSecrets(artifact.name),
    })),
    facts: Object.fromEntries(
      Object.entries(metadata.facts).map(([key, value]) => [
        key,
        SENSITIVE_FACT.test(key)
          ? SECRET_PLACEHOLDER
          : typeof value === 'string'
            ? redactSecrets(value)
            : value,
      ]),
    ),
  };
}
