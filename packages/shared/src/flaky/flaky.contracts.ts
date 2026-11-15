import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';

/**
 * Flaky test detection (S7-F6). Every rule below is documented in
 * `docs/stage-7-roadmap.md` (S7-F6) and in course chapter 72.
 *
 * - Signal: only `passed` and `failed` results; `blocked`, `skipped` and
 *   `untested` say nothing about the test itself.
 * - Window: the most recent {@link FLAKY_WINDOW} signal results of a test case,
 *   across runs that are not deleted, manual and automated alike.
 * - Minimum: fewer than {@link FLAKY_MIN_EXECUTIONS} signal results is
 *   `insufficient_data`, never flaky.
 * - Alternation: each result is compared with the previous one of the same
 *   dataset row and the same case version; an outcome change right after an
 *   edit of the case is explained by the edit and is not a flip.
 * - Recalculation: derived on every read from the results, never stored.
 */
export const FLAKY_WINDOW = 20;
export const FLAKY_MIN_EXECUTIONS = 5;
export const FLAKY_MIN_FLIPS = 2;
export const FLAKY_MIN_FLIP_RATE = 0.25;
export const FLAKY_FAILING_TAIL = 3;

export const FLAKY_STATUSES = [
  'flaky',
  'suspect',
  'failing',
  'stable',
  'insufficient_data',
] as const;
export type FlakyStatus = (typeof FLAKY_STATUSES)[number];

export const FLAKY_MARK_STATES = ['flaky', 'not_flaky', 'cleared'] as const;
export type FlakyMarkState = (typeof FLAKY_MARK_STATES)[number];

export const FLAKY_SOURCES = ['all', 'manual', 'automation'] as const;
export type FlakySource = (typeof FLAKY_SOURCES)[number];

export const FLAKY_SORTS = [
  'status',
  'flipRate',
  'failRate',
  'executions',
  'lastExecutedAt',
  'key',
] as const;
export type FlakySort = (typeof FLAKY_SORTS)[number];

export interface FlakySample {
  status: 'passed' | 'failed';
  executedAt: Date | string;
  caseVersion: number | null;
  iterationKey: string;
}

export interface FlakyAnalysis {
  executions: number;
  passed: number;
  failed: number;
  passRate: number | null;
  failRate: number | null;
  comparisons: number;
  flips: number;
  flipRate: number | null;
  lastStatus: 'passed' | 'failed' | null;
  lastExecutedAt: string | null;
  lastFlipAt: string | null;
  status: FlakyStatus;
}

const time = (value: Date | string): number => new Date(value).getTime();
const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

/**
 * Classifies the window of a test case. Samples may come in any order; only
 * the newest {@link FLAKY_WINDOW} are used.
 *
 * - `flaky`: at least {@link FLAKY_MIN_FLIPS} flips and a flip rate (flips /
 *   comparisons) of at least {@link FLAKY_MIN_FLIP_RATE};
 * - `failing`: not flaky and the last {@link FLAKY_FAILING_TAIL} results of
 *   the case (or of one dataset row) failed: a stable failure, e.g. a
 *   regression;
 * - `stable`: no failure, or at most one flip that ended passing (fixed);
 * - `suspect`: anything else with both outcomes in the window.
 */
export function analyzeFlakiness(samples: readonly FlakySample[]): FlakyAnalysis {
  const window = [...samples]
    .sort((a, b) => time(b.executedAt) - time(a.executedAt))
    .slice(0, FLAKY_WINDOW)
    .reverse();
  const passed = window.filter((sample) => sample.status === 'passed').length;
  const failed = window.length - passed;
  const previous = new Map<string, FlakySample>();
  let comparisons = 0;
  let flips = 0;
  let lastFlipAt: string | null = null;
  for (const sample of window) {
    const before = previous.get(sample.iterationKey);
    if (before !== undefined && before.caseVersion === sample.caseVersion) {
      comparisons += 1;
      if (before.status !== sample.status) {
        flips += 1;
        lastFlipAt = new Date(sample.executedAt).toISOString();
      }
    }
    previous.set(sample.iterationKey, sample);
  }
  const last = window.at(-1) ?? null;
  const byRow = new Map<string, FlakySample[]>();
  for (const sample of window) {
    byRow.set(sample.iterationKey, [...(byRow.get(sample.iterationKey) ?? []), sample]);
  }
  const failingTail = [...byRow.values()].some(
    (row) =>
      row.length >= FLAKY_FAILING_TAIL &&
      row.slice(-FLAKY_FAILING_TAIL).every((sample) => sample.status === 'failed'),
  );
  const flipRate = ratio(flips, comparisons);
  let status: FlakyStatus;
  if (window.length < FLAKY_MIN_EXECUTIONS) {
    status = 'insufficient_data';
  } else if (failed === 0) {
    status = 'stable';
  } else if (flips >= FLAKY_MIN_FLIPS && (flipRate ?? 0) >= FLAKY_MIN_FLIP_RATE) {
    status = 'flaky';
  } else if (failingTail) {
    status = 'failing';
  } else if (flips <= 1 && last?.status === 'passed') {
    status = 'stable';
  } else {
    status = 'suspect';
  }
  return {
    executions: window.length,
    passed,
    failed,
    passRate: ratio(passed, window.length),
    failRate: ratio(failed, window.length),
    comparisons,
    flips,
    flipRate,
    lastStatus: last?.status ?? null,
    lastExecutedAt: last === null ? null : new Date(last.executedAt).toISOString(),
    lastFlipAt,
    status,
  };
}

export interface FlakyMarkRef {
  state: FlakyMarkState;
  reason: string;
  markedBy: { id: string; fullName: string } | null;
  markedAt: string;
}

/**
 * A confirmed mark always reads `flaky`. A dismissal turns `flaky` or
 * `suspect` into `stable` until a flip happens after the dismissal.
 */
export function effectiveFlakyStatus(
  analysis: Pick<FlakyAnalysis, 'status' | 'lastFlipAt'>,
  mark: Pick<FlakyMarkRef, 'state' | 'markedAt'> | null,
): { status: FlakyStatus; confirmed: boolean; dismissed: boolean } {
  if (mark?.state === 'flaky') {
    return { status: 'flaky', confirmed: true, dismissed: false };
  }
  if (
    mark?.state === 'not_flaky' &&
    (analysis.status === 'flaky' || analysis.status === 'suspect') &&
    (analysis.lastFlipAt === null || time(analysis.lastFlipAt) <= time(mark.markedAt))
  ) {
    return { status: 'stable', confirmed: false, dismissed: true };
  }
  return { status: analysis.status, confirmed: false, dismissed: false };
}

export const listFlakyTestsQuerySchema = paginationQuerySchema.extend({
  projectId: z.string().min(1),
  status: z.enum(FLAKY_STATUSES).optional(),
  source: z.enum(FLAKY_SOURCES).default('all'),
  suiteId: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
  marked: z.enum(['true', 'false']).optional(),
  sort: z.enum(FLAKY_SORTS).default('status'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListFlakyTestsQuery = z.infer<typeof listFlakyTestsQuerySchema>;

export const flakyDetailQuerySchema = z.object({
  source: z.enum(FLAKY_SOURCES).default('all'),
});
export type FlakyDetailQuery = z.infer<typeof flakyDetailQuerySchema>;

export const markFlakySchema = z.object({
  state: z.enum(FLAKY_MARK_STATES),
  reason: z.string().trim().min(3).max(2000),
});
export type MarkFlakyInput = z.infer<typeof markFlakySchema>;

export interface FlakyTestView extends FlakyAnalysis {
  testCase: { id: string; key: string; title: string; suiteId: string; suiteName: string };
  detectedStatus: FlakyStatus;
  confirmed: boolean;
  dismissed: boolean;
  mark: FlakyMarkRef | null;
  automatedExecutions: number;
  manualExecutions: number;
}

export interface FlakyHistoryEntry {
  resultId: string;
  status: 'passed' | 'failed';
  executedAt: string;
  caseVersion: number | null;
  iterationKey: string;
  iterationLabel: string | null;
  source: 'manual' | 'automation';
  run: { id: string; name: string };
  runCaseId: string;
  flip: boolean;
}

export interface FlakyTestDetailView extends FlakyTestView {
  rules: {
    window: number;
    minExecutions: number;
    minFlips: number;
    minFlipRate: number;
    failingTail: number;
  };
  history: FlakyHistoryEntry[];
  marks: FlakyMarkRef[];
}
