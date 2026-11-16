import { z } from 'zod';
import { DefectSeverity } from '../defects/defect.contracts.js';
import { FlakyStatus } from '../flaky/flaky.contracts.js';
import {
  ANALYTICS_BUCKETS,
  AnalyticsEnvelope,
  ExecutionKpis,
  MAX_ANALYTICS_WINDOW_DAYS,
} from '../analytics/analytics.contracts.js';

/**
 * QA metrics dashboard (S7-F7). Every KPI is derived on read from the data
 * the plan, cycle, run, defect, exploratory and flaky screens already use;
 * the formulas are documented in docs/stage-7-roadmap.md § S7-F7.
 */

/** Rates are hidden below this many verdicts (passed + failed + blocked). */
export const QA_METRICS_MIN_VERDICTS = 5;
/** Defect density is hidden below this many executed run cases. */
export const QA_METRICS_MIN_EXECUTED_FOR_DENSITY = 20;
/** Plans and cycles listed with their progress. */
export const QA_METRICS_LIST_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export const qaMetricsQuerySchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    bucket: z.enum(ANALYTICS_BUCKETS).optional(),
    testPlanId: z.string().min(1).optional(),
    testCycleId: z.string().min(1).optional(),
    releaseId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
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
export type QaMetricsQuery = z.infer<typeof qaMetricsQuerySchema>;

export interface SampledRates {
  passRate: number | null;
  failedRate: number | null;
  blockedRate: number | null;
  /** True when there are verdicts but fewer than {@link QA_METRICS_MIN_VERDICTS}. */
  insufficientData: boolean;
}

/** The execution rates, or nulls while the sample is too small to mean anything. */
export function sampledRates(
  kpis: Pick<ExecutionKpis, 'verdicts' | 'passRate' | 'failedRate' | 'blockedRate'>,
): SampledRates {
  if (kpis.verdicts < QA_METRICS_MIN_VERDICTS) {
    return {
      passRate: null,
      failedRate: null,
      blockedRate: null,
      insufficientData: kpis.verdicts > 0,
    };
  }
  return {
    passRate: kpis.passRate,
    failedRate: kpis.failedRate,
    blockedRate: kpis.blockedRate,
    insufficientData: false,
  };
}

/** Defects per executed run case, two decimals, or null below the minimum. */
export function defectDensity(defects: number, executed: number): number | null {
  if (executed < QA_METRICS_MIN_EXECUTED_FOR_DENSITY) {
    return null;
  }
  return Math.round((defects / executed) * 100) / 100;
}

export interface QaMetricsTrendPoint {
  bucketStart: string;
  bucketEnd: string;
  passed: number;
  failed: number;
  blocked: number;
  /** passed / (passed + failed + blocked); null without verdicts. */
  passRate: number | null;
}

export interface QaMetricsFlakyPoint {
  bucketStart: string;
  bucketEnd: string;
  flaky: number;
  suspect: number;
  failing: number;
}

export interface QaMetricsProgressRow {
  id: string;
  name: string;
  status: string;
  /** The plan of a cycle; null for a plan. */
  testPlanId: string | null;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  completion: number | null;
  passRate: number | null;
}

export interface QaMetricsView extends AnalyticsEnvelope {
  projectId: string;
  filters: {
    testPlanId: string | null;
    testCycleId: string | null;
    releaseId: string | null;
    environmentId: string | null;
  };
  runs: number;
  execution: ExecutionKpis;
  rates: SampledRates;
  trend: QaMetricsTrendPoint[];
  plans: QaMetricsProgressRow[];
  cycles: QaMetricsProgressRow[];
  defects: {
    open: number;
    openBySeverity: Record<DefectSeverity, number>;
    /** Defects raised from runs in scope during the window. */
    raisedInPeriod: number;
    density: number | null;
    /** True when density is null because too few cases were executed. */
    densityInsufficientData: boolean;
  };
  flaky: {
    counts: Record<FlakyStatus, number>;
    evolution: QaMetricsFlakyPoint[];
  };
  exploratory: {
    sessions: number;
    byStatus: Record<string, number>;
    activeSeconds: number;
    findings: number;
    findingsByKind: Record<string, number>;
    findingsBySeverity: Record<DefectSeverity, number>;
    defectsCreated: number;
  };
}
