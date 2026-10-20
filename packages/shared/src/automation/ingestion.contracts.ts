import { z } from 'zod';

/**
 * Automated result ingestion: CI uploads a JUnit XML or a Playwright JSON
 * report with an API key, and the results land in a test run. Tests are
 * matched to cases by the case key (`WEB-C-12`) found in their name, class,
 * file, tags or annotations.
 */
export const INGESTION_FORMATS = ['junit_xml', 'playwright_json'] as const;
export type IngestionFormat = (typeof INGESTION_FORMATS)[number];

export const INGESTION_IDEMPOTENCY_HEADER = 'idempotency-key';

export const ingestReportQuerySchema = z
  .object({
    /** Record into this open run of the key's project. */
    runId: z.string().min(1).max(64).optional(),
    /** Create a new run with this name (default: derived from the report). */
    runName: z.string().trim().min(1).max(200).optional(),
    environment: z.string().trim().min(1).max(100).optional(),
    milestone: z.string().trim().min(1).max(100).optional(),
  })
  .refine((query) => query.runId === undefined || query.runName === undefined, {
    message: 'Send either runId or runName, not both',
    path: ['runName'],
  });
export type IngestReportQuery = z.infer<typeof ingestReportQuerySchema>;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'Printable ASCII only');

export type IngestedTestOutcome = 'passed' | 'failed' | 'skipped';

export type UnmatchedReason = 'no_case_key' | 'case_not_found' | 'case_not_in_run';

export interface IngestionUnmatchedView {
  name: string;
  outcome: IngestedTestOutcome;
  reason: UnmatchedReason;
}

export interface IngestionRecordedView {
  caseKey: string;
  status: IngestedTestOutcome;
  tests: number;
  elapsedSeconds: number | null;
}

export interface IngestionSummary {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  recorded: number;
  unmatched: number;
}

export interface IngestionReportView {
  id: string;
  projectId: string;
  format: IngestionFormat;
  fileName: string;
  fileSizeBytes: number;
  checksum: string;
  testRunId: string | null;
  summary: IngestionSummary;
  recorded: IngestionRecordedView[];
  unmatched: IngestionUnmatchedView[];
  apiKeyPrefix: string | null;
  createdAt: string;
}

export interface IngestionResultView {
  /** True when the same report (or Idempotency-Key) was already ingested. */
  duplicate: boolean;
  report: IngestionReportView;
}

export const INGESTION_ISSUE_CODES = [
  'REPORT_EMPTY',
  'REPORT_NOT_UTF8',
  'REPORT_DTD_FORBIDDEN',
  'REPORT_MALFORMED',
  'REPORT_UNSUPPORTED',
] as const;
export type IngestionIssueCode = (typeof INGESTION_ISSUE_CODES)[number];
