import { z } from 'zod';

/**
 * Case import (S3-F1).
 *
 * An import is two requests on purpose. The first one (the dry run) parses,
 * validates and plans, and stores the plan as an `ImportJob`; the second one
 * commits *that* plan in one transaction, after checking that the database has
 * not moved underneath it. Nothing in the domain is written by the first.
 */
export const IMPORT_FORMATS = ['qaflow_csv', 'testrail_csv'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
  qaflow_csv: 'qa-flow-hub CSV',
  testrail_csv: 'TestRail CSV export',
};

export const IMPORT_JOB_STATUSES = ['ready', 'invalid', 'committed', 'expired'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const IMPORT_ISSUE_CODES = [
  'MISSING_COLUMN',
  'UNKNOWN_COLUMN',
  'REQUIRED',
  'TOO_LONG',
  'TOO_SHORT',
  'INVALID_ENUM',
  'INVALID_NUMBER',
  'TOO_MANY_STEPS',
  'TOO_MANY_CASES',
  'DUPLICATE_IN_FILE',
  'DUPLICATE_EXISTING',
  'UNKNOWN_REFERENCE',
  'REFERENCE_NOT_ALLOWED',
  'ORPHAN_STEP_ROW',
  'SECTION_DEPTH',
  'MALFORMED_CSV',
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export const IMPORT_ISSUE_SEVERITIES = ['error', 'warning'] as const;
export type ImportIssueSeverity = (typeof IMPORT_ISSUE_SEVERITIES)[number];

export interface ImportIssue {
  /** 1-based line of the record in the file, header included; 0 = whole file. */
  row: number;
  column: string | null;
  code: ImportIssueCode;
  severity: ImportIssueSeverity;
  message: string;
}

/** At most this many issues are stored and returned; `issueCount` keeps the total. */
export const MAX_STORED_IMPORT_ISSUES = 1000;

/** Nesting depth an import may create, the same bound the editor applies. */
export const MAX_IMPORT_SECTION_DEPTH = 5;

export interface ImportSummary {
  rows: number;
  cases: number;
  steps: number;
  newSuites: number;
  newSections: number;
  links: number;
  duplicates: number;
  errors: number;
  warnings: number;
}

export const createImportQuerySchema = z
  .object({
    format: z.enum(IMPORT_FORMATS),
    /** An existing suite of the project, or… */
    suiteId: z.string().min(1).optional(),
    /** …the name of a suite the import creates (or reuses when it exists). */
    suiteName: z.string().trim().min(2).max(120).optional(),
  })
  .refine((value) => (value.suiteId === undefined) !== (value.suiteName === undefined), {
    message: 'Pass exactly one of suiteId or suiteName',
    path: ['suiteId'],
  });
export type CreateImportQuery = z.infer<typeof createImportQuerySchema>;

export interface ImportJobView {
  id: string;
  projectId: string;
  createdById: string | null;
  format: ImportFormat;
  status: ImportJobStatus;
  fileName: string;
  fileSizeBytes: number;
  checksum: string;
  targetSuiteId: string | null;
  targetSuiteName: string | null;
  summary: ImportSummary;
  /** Present on the detail view and on the dry-run response. */
  issues?: ImportIssue[];
  issueCount: number;
  expiresAt: string;
  committedAt: string | null;
  createdAt: string;
}

export interface ImportCommitResult {
  job: ImportJobView;
  created: { cases: number; steps: number; sections: number; suites: number; links: number };
}

export interface ImportLimitsView {
  maxBytes: number;
  maxRows: number;
  maxCases: number;
  maxColumns: number;
  maxStepsPerCase: number;
  maxSectionDepth: number;
  jobTtlHours: number;
}

/** Column order of the qa-flow-hub template, which is also the case export. */
export const QAFLOW_CSV_COLUMNS = [
  'ref',
  'suite',
  'section',
  'title',
  'type',
  'priority',
  'status',
  'automation',
  'estimate_minutes',
  'tags',
  'references',
  'preconditions',
  'description',
  'expected_result',
  'step_action',
  'step_expected',
  'step_data',
] as const;
export type QaflowCsvColumn = (typeof QAFLOW_CSV_COLUMNS)[number];

/** Separator of a section path in a CSV cell: `Login > OAuth > Google`. */
export const SECTION_PATH_SEPARATOR = ' > ';

/**
 * Escape character of a section path. Inside a name, `\>` is a literal `>`
 * and `\\` a literal backslash; an unescaped `>` always separates levels.
 * A backslash before any other character is kept as written, so hand-made
 * paths such as `C:\temp` still read as typed.
 */
export const SECTION_PATH_ESCAPE = '\\';

/** Escapes one section name so a path cell can hold it unambiguously. */
export function encodeSectionName(name: string): string {
  return name.replace(/[\\>]/g, (char) => `${SECTION_PATH_ESCAPE}${char}`);
}

/** The cell the qa-flow-hub CSV export writes for a section path, root first. */
export function encodeSectionPath(names: readonly string[]): string {
  return names.map(encodeSectionName).join(SECTION_PATH_SEPARATOR);
}

/**
 * Splits a section path cell into its levels, root first, honouring the
 * escapes of {@link encodeSectionName}. Levels are returned untrimmed; empty
 * levels are kept so the caller can report them.
 */
export function decodeSectionPath(cell: string): string[] {
  const levels: string[] = [];
  let current = '';
  for (let index = 0; index < cell.length; index += 1) {
    const char = cell.charAt(index);
    const next = cell.charAt(index + 1);
    if (char === SECTION_PATH_ESCAPE && (next === SECTION_PATH_ESCAPE || next === '>')) {
      current += next;
      index += 1;
    } else if (char === '>') {
      levels.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  levels.push(current);
  return levels;
}
