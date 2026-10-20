import type { IngestedTestOutcome } from '@qa-flow-hub/shared';
import { InvalidReportError, ReportTooLargeError } from '../../../errors';

/** One executed test, normalized from whichever report format carried it. */
export interface ParsedTest {
  /** Human-readable identity: suite path and test title. */
  name: string;
  outcome: IngestedTestOutcome;
  durationMs: number | null;
  /** First failure or error message, already truncated. */
  error: string | null;
  /** Every string a case key may hide in: class name, file, tags, annotations. */
  hints: string[];
}

export interface ParsedReport {
  /** Name of the top-level suite or run, used to name a new test run. */
  title: string | null;
  tests: ParsedTest[];
}

export interface ParseLimits {
  maxTests: number;
}

/** Long enough for a stack trace's head, short enough for a list view. */
export const MAX_ERROR_LENGTH = 2_000;
export const MAX_NAME_LENGTH = 500;
/** Nesting deeper than this is not a test report. */
export const MAX_DEPTH = 32;

/**
 * Strict UTF-8, BOM removed. A report that is not valid UTF-8 is rejected
 * instead of being decoded with replacement characters: silently mangling test
 * names would make them match no case.
 */
export function decodeReport(buffer: Buffer): string {
  if (buffer.length === 0) {
    throw new InvalidReportError('REPORT_EMPTY', 'The report is empty');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new InvalidReportError('REPORT_NOT_UTF8', 'The report is not valid UTF-8');
  }
  text = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (text.trim().length === 0) {
    throw new InvalidReportError('REPORT_EMPTY', 'The report is empty');
  }
  return text;
}

export function truncate(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/\u0000/g, '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function assertTestCount(count: number, limits: ParseLimits): void {
  if (count > limits.maxTests) {
    throw new ReportTooLargeError('tests', limits.maxTests);
  }
}
