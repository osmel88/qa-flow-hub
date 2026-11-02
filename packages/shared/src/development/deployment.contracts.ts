import { z } from 'zod';
import type { EnvironmentKind, EnvironmentStatus } from './environment.contracts.js';
import { paginationQuerySchema } from '../common/pagination.js';
import { buildDurationMs, buildMetadataSchema } from './build.contracts.js';
import type { BuildMetadata } from './build.contracts.js';
import {
  COMMIT_SHA_PATTERN,
  DEVELOPMENT_PROVIDERS,
  developmentUrlSchema,
} from './development.contracts.js';
import type { DevelopmentArtifactView } from './development.contracts.js';

/**
 * Deployments (S5-F5): the `deployment` development artifact as a release of
 * a build to an environment. A rollback is a new deployment that points to
 * the original (`rollbackOf`); the original becomes `rolled_back`.
 */
export const DEPLOYMENT_STATUSES = [
  'pending',
  'deploying',
  'succeeded',
  'failed',
  'rolled_back',
  'cancelled',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** `succeeded` only leaves through a rollback; the rest of the terminals never move. */
export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  pending: ['deploying', 'failed', 'cancelled'],
  deploying: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  rolled_back: [],
  cancelled: [],
};

export const DEPLOYMENT_FINISHED_STATUSES: readonly DeploymentStatus[] = [
  'succeeded',
  'failed',
  'rolled_back',
  'cancelled',
];

export function isFinishedDeploymentStatus(status: string | null): boolean {
  return status !== null && (DEPLOYMENT_FINISHED_STATUSES as readonly string[]).includes(status);
}

/** A deployment without a status counts as pending. */
export function canTransitionDeployment(from: string | null, to: DeploymentStatus): boolean {
  const current = (from ?? 'pending') as DeploymentStatus;
  return (DEPLOYMENT_TRANSITIONS[current] ?? []).includes(to);
}

export const DEPLOYMENT_TRIGGERS = [
  'manual',
  'pipeline',
  'schedule',
  'api',
  'rollback',
  'other',
] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

const idSchema = z.string().min(1).max(64);
const text = (max: number) => z.string().trim().min(1).max(max);
const dateSchema = z.string().datetime({ offset: true });
const logSchema = z.string().trim().min(1).max(20_000);

export const createDeploymentSchema = z
  .object({
    projectId: idSchema,
    identifier: text(200),
    environmentId: idSchema,
    provider: z.enum(DEVELOPMENT_PROVIDERS).default('local'),
    externalId: text(200).optional(),
    title: text(300).optional(),
    url: developmentUrlSchema.optional(),
    buildId: idSchema.optional(),
    releaseId: idSchema.optional(),
    commitSha: z
      .string()
      .trim()
      .regex(COMMIT_SHA_PATTERN, 'A commit SHA is 7 to 64 hexadecimal characters')
      .transform((value) => value.toLowerCase())
      .optional(),
    status: z.enum(['pending', 'deploying', 'succeeded', 'failed', 'cancelled']).default('pending'),
    trigger: z.enum(DEPLOYMENT_TRIGGERS).default('manual'),
    startedAt: dateSchema.optional(),
    finishedAt: dateSchema.optional(),
    workItemIds: z.array(idSchema).max(20).default([]),
    metadata: buildMetadataSchema.optional(),
    logSummary: logSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.finishedAt !== undefined && !isFinishedDeploymentStatus(value.status)) {
      context.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'Only a finished deployment has finishedAt',
      });
    }
  });
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

export const updateDeploymentSchema = z
  .object({
    title: text(300).nullable().optional(),
    url: developmentUrlSchema.nullable().optional(),
    releaseId: idSchema.nullable().optional(),
    metadata: buildMetadataSchema.nullable().optional(),
    logSummary: logSchema.nullable().optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateDeploymentInput = z.infer<typeof updateDeploymentSchema>;

export const transitionDeploymentSchema = z.object({
  status: z.enum(['deploying', 'succeeded', 'failed', 'cancelled']),
  at: dateSchema.optional(),
  logSummary: logSchema.optional(),
  version: z.number().int().positive().optional(),
});
export type TransitionDeploymentInput = z.infer<typeof transitionDeploymentSchema>;

export const rollbackDeploymentSchema = z.object({
  /** The build to go back to; by default the build of the previous succeeded deployment there. */
  toBuildId: idSchema.optional(),
  reason: text(1000).optional(),
  version: z.number().int().positive().optional(),
});
export type RollbackDeploymentInput = z.infer<typeof rollbackDeploymentSchema>;

export const listDeploymentsQuerySchema = paginationQuerySchema.extend({
  projectId: idSchema,
  status: z.enum(DEPLOYMENT_STATUSES).optional(),
  environmentId: idSchema.optional(),
  releaseId: idSchema.optional(),
  buildId: idSchema.optional(),
  provider: z.enum(DEVELOPMENT_PROVIDERS).optional(),
  workItemId: idSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuerySchema>;

export const deploymentMetricsQuerySchema = z.object({
  projectId: idSchema,
  environmentId: idSchema.optional(),
  releaseId: idSchema.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type DeploymentMetricsQuery = z.infer<typeof deploymentMetricsQuerySchema>;

export interface DeploymentView extends DevelopmentArtifactView {
  environmentRef: {
    id: string;
    name: string;
    kind: EnvironmentKind;
    status: EnvironmentStatus;
    protected: boolean;
  } | null;
  build: { id: string; identifier: string | null; status: string | null } | null;
  release: { id: string; name: string; version: string } | null;
  rollbackOf: { id: string; identifier: string | null } | null;
  rolledBackBy: { id: string; identifier: string | null } | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: DeploymentTrigger | null;
  actor: { id: string; fullName: string } | null;
  metadata: BuildMetadata | null;
  logSummary: string | null;
}

export interface CreateDeploymentResult {
  created: boolean;
  deployment: DeploymentView;
}

export interface DeploymentMetricsView {
  projectId: string;
  windowDays: number;
  total: number;
  byStatus: Record<DeploymentStatus, number>;
  /** Succeeded (also later rolled back) / (that + failed). */
  successRate: number | null;
  failureRate: number | null;
  rollbacks: number;
  durationMs: {
    average: number | null;
    median: number | null;
    p85: number | null;
    samples: number;
  };
}

export function computeDeploymentMetrics(
  rows: ReadonlyArray<{
    status: string | null;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    rollbackOfId?: string | null;
  }>,
): Omit<DeploymentMetricsView, 'projectId' | 'windowDays'> {
  const byStatus = Object.fromEntries(DEPLOYMENT_STATUSES.map((status) => [status, 0])) as Record<
    DeploymentStatus,
    number
  >;
  const durations: number[] = [];
  let rollbacks = 0;
  for (const row of rows) {
    const status = (row.status ?? 'pending') as DeploymentStatus;
    if (status in byStatus) {
      byStatus[status] += 1;
    }
    if (row.rollbackOfId !== undefined && row.rollbackOfId !== null) {
      rollbacks += 1;
    }
    const duration = buildDurationMs(row.startedAt, row.finishedAt);
    if (duration !== null && ['succeeded', 'failed', 'rolled_back'].includes(status)) {
      durations.push(duration);
    }
  }
  durations.sort((a, b) => a - b);
  const good = byStatus.succeeded + byStatus.rolled_back;
  const decided = good + byStatus.failed;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const pick = (fraction: number) =>
    durations.length === 0
      ? null
      : (durations[Math.min(durations.length - 1, Math.ceil(fraction * durations.length) - 1)] ??
        null);
  return {
    total: rows.length,
    byStatus,
    successRate: decided === 0 ? null : round(good / decided),
    failureRate: decided === 0 ? null : round(byStatus.failed / decided),
    rollbacks,
    durationMs: {
      average:
        durations.length === 0
          ? null
          : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      median: pick(0.5),
      p85: pick(0.85),
      samples: durations.length,
    },
  };
}
