import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import type { TestResultStatus } from '../test-runs/test-run.contracts.js';

/**
 * planned → in_progress → released → archived; planned and in_progress can also
 * be archived directly (a cancelled release). `archived` is terminal. Runs keep
 * their release for ever: closing or archiving a release never touches them.
 */
export const RELEASE_STATUSES = ['planned', 'in_progress', 'released', 'archived'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Runs can be attached to a release only while it is still being built. */
export const OPEN_RELEASE_STATUSES = ['planned', 'in_progress'] as const;

export const RELEASE_TRANSITIONS: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  planned: ['in_progress', 'archived'],
  in_progress: ['released', 'archived'],
  released: ['archived'],
  archived: [],
};

export function isOpenRelease(status: ReleaseStatus): boolean {
  return (OPEN_RELEASE_STATUSES as readonly string[]).includes(status);
}

/** Semver-like or free-form, but printable and without spaces: it goes into CI URLs. */
export const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    // `Date.parse` rolls 2026-02-30 over to March; only a real calendar day survives the round trip.
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a valid date');

const releaseFields = {
  name: z.string().trim().min(1).max(160),
  version: z
    .string()
    .trim()
    .regex(RELEASE_VERSION_PATTERN, 'Letters, digits, dots, dashes, underscores or plus signs'),
  tag: z.string().trim().min(1).max(120).nullish(),
  description: z.string().trim().max(20_000).nullish(),
  startDate: isoDate.nullish(),
  targetDate: isoDate.nullish(),
};

function datesInOrder(value: {
  startDate?: string | null | undefined;
  targetDate?: string | null | undefined;
}): boolean {
  return (
    value.startDate === undefined ||
    value.startDate === null ||
    value.targetDate === undefined ||
    value.targetDate === null ||
    value.startDate <= value.targetDate
  );
}

const DATE_ORDER = {
  message: 'The target date cannot be before the start date',
  path: ['targetDate'],
};

export const createReleaseSchema = z
  .object({ projectId: z.string().min(1), ...releaseFields })
  .refine(datesInOrder, DATE_ORDER);
export type CreateReleaseInput = z.infer<typeof createReleaseSchema>;

export const updateReleaseSchema = z
  .object({
    name: releaseFields.name.optional(),
    tag: releaseFields.tag,
    description: releaseFields.description,
    startDate: releaseFields.startDate,
    targetDate: releaseFields.targetDate,
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  })
  .refine(datesInOrder, DATE_ORDER);
export type UpdateReleaseInput = z.infer<typeof updateReleaseSchema>;

export const listReleasesQuerySchema = paginationQuerySchema.extend({
  projectId: z.string().min(1),
  status: z.enum(RELEASE_STATUSES).optional(),
  search: z.string().trim().min(1).max(120).optional(),
});
export type ListReleasesQuery = z.infer<typeof listReleasesQuerySchema>;

export interface ReleaseView {
  id: string;
  projectId: string;
  name: string;
  version: string;
  tag: string | null;
  description: string | null;
  status: ReleaseStatus;
  startDate: string | null;
  targetDate: string | null;
  releasedAt: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  /** Non-deleted runs attached to the release. */
  runCount: number;
}

export type ReleaseStatusCounts = Record<TestResultStatus, number> & {
  total: number;
  executed: number;
  /** passed / executed, one decimal; null without executions. */
  passRate: number | null;
};

export interface ReleaseRunRow {
  id: string;
  name: string;
  status: string;
  environment: string | null;
  createdAt: string;
  completedAt: string | null;
  counts: ReleaseStatusCounts;
}

/**
 * The release dashboard. `cases` counts every case once: its status is the
 * latest result across all the release's runs, so re-running a failed case in
 * a later run of the same release replaces the failure.
 */
export interface ReleaseSummaryView {
  release: ReleaseView;
  runs: ReleaseRunRow[];
  cases: ReleaseStatusCounts;
  requirements: {
    /** Requirements of the project, excluding obsolete ones. */
    total: number;
    /** With at least one verifying case executed in the release. */
    verified: number;
    /** With every verifying case in the release passed. */
    passing: number;
  };
  defects: { total: number; open: number };
}

export interface ReleaseTraceabilityCase {
  testCaseId: string;
  key: string;
  title: string;
  /** Latest result across the release's runs; `untested` when not executed. */
  status: TestResultStatus;
  /** The run that recorded `status`; null when the case is not in the release. */
  testRunId: string | null;
  testRunName: string | null;
}

export interface ReleaseTraceabilityRow {
  requirementId: string;
  key: string;
  title: string;
  status: string;
  cases: ReleaseTraceabilityCase[];
}

/** requirements → verifying cases → their latest result in this release. */
export interface ReleaseTraceabilityView {
  releaseId: string;
  rows: ReleaseTraceabilityRow[];
}
