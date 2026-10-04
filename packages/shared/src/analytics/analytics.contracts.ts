import { z } from 'zod';
import { DefectSeverity, DefectStatus } from '../defects/defect.contracts.js';
import { PriorityValue } from '../requirements/requirement.contracts.js';
import { TestResultStatus } from '../test-runs/test-run.contracts.js';

/**
 * Analytics contracts (S2-F9).
 *
 * Every KPI is computed by the API from aggregate SQL; the client receives
 * numbers, never the rows behind them. Every response carries the window it
 * covers (`period`) and the instant it was computed (`computedAt`): a KPI
 * without its window is not a number, it is an opinion.
 *
 * The formulas live here, as pure functions, so the API and the documentation
 * share one definition and a unit test pins each of them.
 */

export const ANALYTICS_BUCKETS = ['day', 'week', 'month'] as const;
export type AnalyticsBucket = (typeof ANALYTICS_BUCKETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default window when the caller does not choose one. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;
/** Longest window accepted, so a trend never asks for thousands of buckets. */
export const MAX_ANALYTICS_WINDOW_DAYS = 366;

export const analyticsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    bucket: z.enum(ANALYTICS_BUCKETS).optional(),
  })
  .superRefine((value, context) => {
    if (value.from !== undefined && value.to !== undefined) {
      if (value.from.getTime() >= value.to.getTime()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['from'],
          message: '`from` must be earlier than `to`',
        });
      } else if (value.to.getTime() - value.from.getTime() > MAX_ANALYTICS_WINDOW_DAYS * DAY_MS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['from'],
          message: `The window cannot exceed ${MAX_ANALYTICS_WINDOW_DAYS} days`,
        });
      }
    }
  });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface AnalyticsPeriod {
  from: string;
  to: string;
  bucket: AnalyticsBucket;
}

/** Envelope shared by every analytics response. */
export interface AnalyticsEnvelope {
  period: AnalyticsPeriod;
  computedAt: string;
}

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  bucket: AnalyticsBucket;
}

/**
 * Applies the defaults: `to` = now, `from` = `to` − 30 days (or `from` + 30
 * days when only `from` is given), and a bucket sized to the window — daily up
 * to a month, weekly up to six months, monthly beyond.
 */
export function resolveAnalyticsPeriod(query: AnalyticsQuery, now: Date): ResolvedPeriod {
  const span = DEFAULT_ANALYTICS_WINDOW_DAYS * DAY_MS;
  const to = query.to ?? (query.from === undefined ? now : new Date(query.from.getTime() + span));
  const from = query.from ?? new Date(to.getTime() - span);
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  const bucket = query.bucket ?? (days <= 31 ? 'day' : days <= 186 ? 'week' : 'month');
  return { from, to, bucket };
}

export function toAnalyticsPeriod(period: ResolvedPeriod): AnalyticsPeriod {
  return { from: period.from.toISOString(), to: period.to.toISOString(), bucket: period.bucket };
}

/** The window of the same length immediately before `period`. */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
  const length = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - length), to: period.from, bucket: period.bucket };
}

/**
 * Start of the bucket containing `instant`, in UTC, matching PostgreSQL's
 * `date_trunc` (weeks start on Monday).
 */
export function truncateToBucket(instant: Date, bucket: AnalyticsBucket): Date {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  if (bucket === 'month') {
    return new Date(Date.UTC(year, month, 1));
  }
  const day = new Date(Date.UTC(year, month, instant.getUTCDate()));
  if (bucket === 'day') {
    return day;
  }
  const weekday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - weekday * DAY_MS);
}

export function nextBucket(start: Date, bucket: AnalyticsBucket): Date {
  if (bucket === 'month') {
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
  return new Date(start.getTime() + (bucket === 'day' ? 1 : 7) * DAY_MS);
}

/** Every bucket start that overlaps the window, oldest first. */
export function bucketStarts(period: ResolvedPeriod): Date[] {
  const starts: Date[] = [];
  for (
    let start = truncateToBucket(period.from, period.bucket);
    start.getTime() < period.to.getTime();
    start = nextBucket(start, period.bucket)
  ) {
    starts.push(start);
  }
  return starts;
}

/** `numerator / denominator` as a percentage with one decimal, or `null` when undefined. */
export function percentage(numerator: number, denominator: number): number | null {
  if (denominator === 0) {
    return null;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

export type ExecutionCounts = Record<TestResultStatus, number>;

export function emptyExecutionCounts(): ExecutionCounts {
  return { untested: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 };
}

export interface ExecutionKpis {
  counts: ExecutionCounts;
  /** Run cases in scope: every case planned in a run active during the window. */
  planned: number;
  /** Cases with any recorded result (`planned − untested`). */
  executed: number;
  /** Cases still `untested`. */
  pending: number;
  /** Cases with a verdict: passed + failed + blocked. */
  verdicts: number;
  /** passed / verdicts. Untested and skipped cases are not in the denominator. */
  passRate: number | null;
  /** failed / verdicts. */
  failedRate: number | null;
  /** blocked / verdicts. */
  blockedRate: number | null;
  /** skipped / planned. */
  skippedRate: number | null;
  /** untested / planned. */
  untestedRate: number | null;
  /** executed / planned. */
  progress: number | null;
}

/**
 * The execution formulas. Pass, failed and blocked rates share one
 * denominator — the cases that received a verdict — so they add up to 100 and
 * a run with half its cases untested still reports what it actually verified.
 * Skipped and untested are shares of the planned cases: they say how much of
 * the plan was not verified, which is what execution progress measures.
 */
export function executionKpis(counts: ExecutionCounts): ExecutionKpis {
  const planned = counts.untested + counts.passed + counts.failed + counts.blocked + counts.skipped;
  const verdicts = counts.passed + counts.failed + counts.blocked;
  const executed = planned - counts.untested;
  return {
    counts,
    planned,
    executed,
    pending: counts.untested,
    verdicts,
    passRate: percentage(counts.passed, verdicts),
    failedRate: percentage(counts.failed, verdicts),
    blockedRate: percentage(counts.blocked, verdicts),
    skippedRate: percentage(counts.skipped, planned),
    untestedRate: percentage(counts.untested, planned),
    progress: percentage(executed, planned),
  };
}

export interface CoverageKpis {
  /** Non-obsolete, non-deleted requirements created up to the end of the window. */
  requirements: number;
  /** Of those, the ones with at least one `requirement → test_case` link. */
  covered: number;
  uncovered: number;
  percentage: number | null;
}

export function coverageKpis(requirements: number, covered: number): CoverageKpis {
  return {
    requirements,
    covered,
    uncovered: requirements - covered,
    percentage: percentage(covered, requirements),
  };
}

/** Two values and their difference, for period-over-period comparison. */
export interface PeriodComparison {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

export function compare(current: number | null, previous: number | null): PeriodComparison {
  return {
    current,
    previous,
    delta:
      current === null || previous === null ? null : Math.round((current - previous) * 10) / 10,
  };
}

export interface MeanTimeToResolve {
  /** Mean hours from creation to resolution/closure, or null without data. */
  hours: number | null;
  /** Defects resolved or closed within the window that feed the mean. */
  sampleSize: number;
}

// ---------------------------------------------------------------- responses

export interface ProjectDashboardSummary extends AnalyticsEnvelope {
  projectId: string;
  execution: ExecutionKpis;
  coverage: CoverageKpis;
  defects: {
    open: number;
    openCritical: number;
    createdInPeriod: number;
    closedInPeriod: number;
    /** Defects raised from runs in scope / executed run cases. */
    perExecutedCase: number | null;
  };
  meanTimeToResolve: MeanTimeToResolve;
  comparison: {
    previousPeriod: { from: string; to: string };
    passRate: PeriodComparison;
    defectsCreated: PeriodComparison;
  };
}

export interface RunExecutionRow {
  id: string;
  name: string;
  milestone: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  execution: ExecutionKpis;
  /** Defects whose `testRunId` is this run. */
  defects: number;
  /** defects / executed cases of the run. */
  defectsPerExecutedCase: number | null;
}

export interface MilestoneExecutionRow {
  /** `null` groups runs without a milestone. */
  milestone: string | null;
  runs: number;
  execution: ExecutionKpis;
}

export interface ProjectTestResultsView extends AnalyticsEnvelope {
  projectId: string;
  execution: ExecutionKpis;
  /** Most recent runs in scope first, at most `RUN_ROWS_LIMIT`. */
  runs: RunExecutionRow[];
  milestones: MilestoneExecutionRow[];
}

export const RUN_ROWS_LIMIT = 20;
export const UNCOVERED_ROWS_LIMIT = 50;

export interface UncoveredRequirementRow {
  id: string;
  key: string;
  title: string;
  priority: PriorityValue;
  status: string;
}

export interface ProjectCoverageView extends AnalyticsEnvelope {
  projectId: string;
  coverage: CoverageKpis;
  byPriority: Array<{ priority: PriorityValue } & CoverageKpis>;
  /** Highest priority first, at most `UNCOVERED_ROWS_LIMIT`. */
  uncoveredRequirements: UncoveredRequirementRow[];
}

export interface ProjectDefectsView extends AnalyticsEnvelope {
  projectId: string;
  open: number;
  closed: number;
  openCritical: number;
  /** Open defects only. */
  bySeverity: Record<DefectSeverity, number>;
  /** Open defects only. */
  byPriority: Record<PriorityValue, number>;
  /** Every non-deleted defect. */
  byStatus: Record<DefectStatus, number>;
  createdInPeriod: number;
  closedInPeriod: number;
  perExecutedCase: number | null;
  meanTimeToResolve: MeanTimeToResolve;
}

export interface TrendPoint {
  bucketStart: string;
  bucketEnd: string;
  /** Results recorded in the bucket (every attempt, not only the latest). */
  results: number;
  /** passed / (passed + failed + blocked) over the bucket's results. */
  passRate: number | null;
  /** Coverage as of the end of the bucket. */
  coverage: number | null;
  defectsCreated: number;
  defectsClosed: number;
  /** Defects created and not closed at the end of the bucket. */
  defectsOpen: number;
}

export interface TrendsView extends AnalyticsEnvelope {
  points: TrendPoint[];
}

export interface ProjectTrendsView extends TrendsView {
  projectId: string;
}

export interface ProjectHealthRow {
  projectId: string;
  key: string;
  name: string;
  execution: ExecutionKpis;
  coverage: CoverageKpis;
  openDefects: number;
  openCritical: number;
}

export interface ProjectRanking {
  projectId: string;
  key: string;
  name: string;
  value: number;
}

export const ACTIVITY_KINDS = ['result', 'defect', 'run'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityItem {
  kind: ActivityKind;
  id: string;
  at: string;
  projectId: string;
  projectKey: string;
  label: string;
  status: string;
}

export const ACTIVITY_LIMIT = 15;
export const RANKING_LIMIT = 5;

export interface OrganizationDashboard extends AnalyticsEnvelope {
  health: {
    projects: number;
    execution: ExecutionKpis;
    coverage: CoverageKpis;
    openDefects: number;
    openCritical: number;
  };
  projects: ProjectHealthRow[];
  /** Projects with failed cases in scope, most failures first. */
  mostFailures: ProjectRanking[];
  /** Projects with requirements, lowest coverage percentage first. */
  leastCoverage: ProjectRanking[];
  trends: TrendPoint[];
  recentActivity: ActivityItem[];
}

/** Severities counted as "critical" for the open-critical KPI. */
export const CRITICAL_DEFECT_SEVERITIES = ['blocker', 'critical'] as const;
