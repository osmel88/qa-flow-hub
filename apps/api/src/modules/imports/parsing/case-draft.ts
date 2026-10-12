import {
  AUTOMATION_STATUSES,
  AutomationStatus,
  ImportIssue,
  ImportIssueCode,
  MAX_IMPORT_SECTION_DEPTH,
  PRIORITIES,
  PriorityValue as Priority,
  SECTION_PATH_SEPARATOR,
  TEST_CASE_STATUSES,
  TEST_CASE_TYPES,
  TestCaseStatus,
  TestCaseType,
  restoreCsvFormula,
} from '@qa-flow-hub/shared';

/** The case fields a parser can fill, by internal name. */
export const CASE_FIELDS = [
  'suite',
  'section',
  'title',
  'type',
  'priority',
  'status',
  'automation',
  'estimate',
  'tags',
  'references',
  'preconditions',
  'description',
  'expected_result',
] as const;
export type CaseField = (typeof CASE_FIELDS)[number];

export interface RawCell {
  value: string;
  /** Header of the column in the file, for the report. */
  column: string;
}

export interface RawStep {
  line: number;
  action: RawCell | null;
  expected: RawCell | null;
  data: RawCell | null;
}

/** One case as read from the file, before any validation. */
export interface RawCase {
  line: number;
  ref: string | null;
  fields: Partial<Record<CaseField, RawCell>>;
  steps: RawStep[];
}

export interface ParsedCases {
  cases: RawCase[];
  issues: ImportIssue[];
}

/** A case that passed validation; this is what a plan stores and a commit writes. */
export interface DraftCase {
  line: number;
  ref: string | null;
  suiteName: string | null;
  sectionPath: string[];
  title: string;
  normalizedTitle: string;
  type: TestCaseType;
  priority: Priority;
  status: TestCaseStatus;
  automationStatus: AutomationStatus;
  estimateMinutes: number | null;
  tags: string[];
  references: string[];
  preconditions: string | null;
  description: string | null;
  expectedResult: string | null;
  steps: Array<{ action: string; expectedResult: string | null; data: string | null }>;
}

/** Per-format translation of enum values and the defaults when a cell is empty. */
export interface FieldDialect {
  type: (value: string) => TestCaseType | null;
  priority: (value: string) => Priority | null;
  automation: (value: string) => AutomationStatus | null;
  status: (value: string) => TestCaseStatus | null;
  estimateMinutes: (value: string) => number | null;
  defaultStatus: TestCaseStatus;
}

export const MAX_STEPS_PER_CASE = 100;
const MAX_TITLE = 200;
const MIN_TITLE = 3;
const MAX_LONG_TEXT = 20_000;
const MAX_STEP_TEXT = 2000;
const MAX_NAME = 120;
const MAX_TAGS = 20;
const MAX_TAG = 32;

export function issue(
  line: number,
  column: string | null,
  code: ImportIssueCode,
  message: string,
  severity: ImportIssue['severity'] = 'error',
): ImportIssue {
  return { row: line, column, code, severity, message };
}

/** Same rule the duplicate detection uses everywhere: trimmed, collapsed, case-insensitive. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function splitList(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clean(cell: RawCell | undefined | null): string | null {
  if (cell === undefined || cell === null) {
    return null;
  }
  const value = restoreCsvFormula(cell.value).trim();
  return value.length === 0 ? null : value;
}

function exactEnum<T extends string>(values: readonly T[]): (value: string) => T | null {
  const byLower = new Map(values.map((value) => [value.toLowerCase(), value]));
  return (value) => byLower.get(value.trim().toLowerCase()) ?? null;
}

/** The qa-flow-hub template uses the API's own enum names. */
export const QAFLOW_DIALECT: FieldDialect = {
  type: exactEnum(TEST_CASE_TYPES),
  priority: exactEnum(PRIORITIES),
  automation: exactEnum(AUTOMATION_STATUSES),
  status: exactEnum(TEST_CASE_STATUSES),
  estimateMinutes: (value) => (/^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : null),
  defaultStatus: 'draft',
};

/**
 * Validates and normalizes every raw case with the same bounds the editor
 * applies (the shared Zod schemas), so an import cannot create anything the UI
 * could not. Enum values the dialect does not know fall back to the default
 * with a warning; text that does not fit is an error.
 */
export function validateCases(
  raw: RawCase[],
  dialect: FieldDialect,
): { drafts: DraftCase[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const drafts: DraftCase[] = [];

  for (const item of raw) {
    const errorsBefore = issues.filter((entry) => entry.severity === 'error').length;
    const field = (name: CaseField): string | null => clean(item.fields[name]);
    const column = (name: CaseField, fallback: string): string =>
      item.fields[name]?.column ?? fallback;

    const text = (name: CaseField, max: number, label: string): string | null => {
      const value = field(name);
      if (value !== null && value.length > max) {
        issues.push(
          issue(
            item.line,
            column(name, label),
            'TOO_LONG',
            `${label} is longer than ${max} characters`,
          ),
        );
      }
      return value;
    };

    const title = field('title');
    if (title === null) {
      issues.push(issue(item.line, column('title', 'title'), 'REQUIRED', 'Title is required'));
    } else if (title.length < MIN_TITLE) {
      issues.push(
        issue(
          item.line,
          column('title', 'title'),
          'TOO_SHORT',
          `Title needs at least ${MIN_TITLE} characters`,
        ),
      );
    } else if (title.length > MAX_TITLE) {
      issues.push(
        issue(
          item.line,
          column('title', 'title'),
          'TOO_LONG',
          `Title is longer than ${MAX_TITLE} characters`,
        ),
      );
    }

    const enumField = <T extends string>(
      name: CaseField,
      label: string,
      parse: (value: string) => T | null,
      fallback: T,
    ): T => {
      const value = field(name);
      if (value === null) {
        return fallback;
      }
      const parsed = parse(value);
      if (parsed === null) {
        issues.push(
          issue(
            item.line,
            column(name, label),
            'INVALID_ENUM',
            `Unknown ${label} "${preview(value)}"; using "${fallback}"`,
            'warning',
          ),
        );
        return fallback;
      }
      return parsed;
    };

    const type = enumField('type', 'type', dialect.type, 'functional');
    const priority = enumField('priority', 'priority', dialect.priority, 'medium');
    const automationStatus = enumField('automation', 'automation', dialect.automation, 'manual');
    const status = enumField('status', 'status', dialect.status, dialect.defaultStatus);

    let estimateMinutes: number | null = null;
    const estimate = field('estimate');
    if (estimate !== null) {
      estimateMinutes = dialect.estimateMinutes(estimate);
      if (estimateMinutes === null || estimateMinutes < 1 || estimateMinutes > 10_000) {
        issues.push(
          issue(
            item.line,
            column('estimate', 'estimate'),
            'INVALID_NUMBER',
            `Estimate "${preview(estimate)}" is not between 1 and 10000 minutes`,
          ),
        );
        estimateMinutes = null;
      }
    }

    const tags = Array.from(
      new Set(splitList(field('tags') ?? '').map((tag) => tag.toLowerCase())),
    );
    if (tags.length > MAX_TAGS || tags.some((tag) => tag.length > MAX_TAG)) {
      issues.push(
        issue(
          item.line,
          column('tags', 'tags'),
          'TOO_LONG',
          `At most ${MAX_TAGS} tags of up to ${MAX_TAG} characters`,
        ),
      );
    }

    const references = Array.from(
      new Set(splitList(field('references') ?? '').map((key) => key.toUpperCase())),
    );

    const suiteName = text('suite', MAX_NAME, 'suite');
    if (suiteName !== null && suiteName.length < 2) {
      issues.push(
        issue(
          item.line,
          column('suite', 'suite'),
          'TOO_SHORT',
          'Suite name needs at least 2 characters',
        ),
      );
    }

    const sectionPath = (field('section') ?? '')
      .split(SECTION_PATH_SEPARATOR.trim())
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (sectionPath.length > MAX_IMPORT_SECTION_DEPTH) {
      issues.push(
        issue(
          item.line,
          column('section', 'section'),
          'SECTION_DEPTH',
          `Sections nest at most ${MAX_IMPORT_SECTION_DEPTH} levels`,
        ),
      );
    }
    if (sectionPath.some((part) => part.length > MAX_NAME)) {
      issues.push(
        issue(
          item.line,
          column('section', 'section'),
          'TOO_LONG',
          `Section names are at most ${MAX_NAME} characters`,
        ),
      );
    }

    const preconditions = text('preconditions', MAX_LONG_TEXT, 'preconditions');
    const description = text('description', MAX_LONG_TEXT, 'description');
    const expectedResult = text('expected_result', MAX_LONG_TEXT, 'expected result');

    const steps: DraftCase['steps'] = [];
    for (const step of item.steps) {
      const action = clean(step.action);
      const expected = clean(step.expected);
      const data = clean(step.data);
      if (action === null) {
        if (expected !== null || data !== null) {
          issues.push(
            issue(
              step.line,
              step.action?.column ?? 'step action',
              'REQUIRED',
              'A step needs an action',
            ),
          );
        }
        continue;
      }
      for (const [value, cell] of [
        [action, step.action],
        [expected, step.expected],
        [data, step.data],
      ] as const) {
        if (value !== null && value.length > MAX_STEP_TEXT) {
          issues.push(
            issue(
              step.line,
              cell?.column ?? null,
              'TOO_LONG',
              `Step text is longer than ${MAX_STEP_TEXT} characters`,
            ),
          );
        }
      }
      steps.push({ action, expectedResult: expected, data });
    }
    if (steps.length > MAX_STEPS_PER_CASE) {
      issues.push(
        issue(
          item.line,
          null,
          'TOO_MANY_STEPS',
          `A case has at most ${MAX_STEPS_PER_CASE} steps; this one has ${steps.length}`,
        ),
      );
    }

    const hasErrors = issues.filter((entry) => entry.severity === 'error').length > errorsBefore;
    if (!hasErrors && title !== null) {
      drafts.push({
        line: item.line,
        ref: item.ref,
        suiteName,
        sectionPath,
        title,
        normalizedTitle: normalizeTitle(title),
        type,
        priority,
        status,
        automationStatus,
        estimateMinutes,
        tags,
        references,
        preconditions,
        description,
        expectedResult,
        steps,
      });
    }
  }

  return { drafts, issues };
}

/** Values echoed in a message are cut short; the report is not a copy of the file. */
export function preview(value: string): string {
  const single = value.replace(/\s+/g, ' ');
  return single.length > 60 ? `${single.slice(0, 57)}...` : single;
}
