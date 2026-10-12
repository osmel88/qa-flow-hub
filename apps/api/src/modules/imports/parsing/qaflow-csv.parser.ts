import { ImportIssue } from '@qa-flow-hub/shared';
import { CaseField, ParsedCases, RawCase, RawCell, issue } from './case-draft';
import { CsvTable } from './csv-input';

/** Header aliases (lower case) → internal field, for the qa-flow-hub template. */
const QAFLOW_HEADERS: Record<
  string,
  CaseField | 'ref' | 'step_action' | 'step_expected' | 'step_data'
> = {
  ref: 'ref',
  key: 'ref',
  id: 'ref',
  suite: 'suite',
  section: 'section',
  title: 'title',
  type: 'type',
  priority: 'priority',
  status: 'status',
  automation: 'automation',
  automation_status: 'automation',
  estimate_minutes: 'estimate',
  estimate: 'estimate',
  tags: 'tags',
  references: 'references',
  requirements: 'references',
  preconditions: 'preconditions',
  description: 'description',
  expected_result: 'expected_result',
  step_action: 'step_action',
  step_expected: 'step_expected',
  step_expected_result: 'step_expected',
  step_data: 'step_data',
};

type Target = (typeof QAFLOW_HEADERS)[string];

export interface ColumnMap {
  byTarget: Map<Target, number>;
  issues: ImportIssue[];
}

export function mapColumns(header: string[], aliases: Record<string, Target>): ColumnMap {
  const byTarget = new Map<Target, number>();
  const issues: ImportIssue[] = [];
  header.forEach((name, index) => {
    const key = name
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const target = aliases[key] ?? aliases[name.trim().toLowerCase()];
    if (target === undefined) {
      issues.push(
        issue(
          1,
          name,
          'UNKNOWN_COLUMN',
          `Column "${name}" is not recognized and is ignored`,
          'warning',
        ),
      );
      return;
    }
    if (byTarget.has(target)) {
      issues.push(
        issue(
          1,
          name,
          'UNKNOWN_COLUMN',
          `Column "${name}" repeats another column and is ignored`,
          'warning',
        ),
      );
      return;
    }
    byTarget.set(target, index);
  });
  return { byTarget, issues };
}

export function cellOf(
  cells: string[],
  header: string[],
  index: number | undefined,
): RawCell | null {
  if (index === undefined) {
    return null;
  }
  const value = cells[index] ?? '';
  return value.trim().length === 0 ? null : { value, column: header[index] ?? '' };
}

const FIELD_TARGETS: CaseField[] = [
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
];

/**
 * The template is one row per case, or several rows sharing a `ref` when the
 * case has several steps: the first row carries the case fields and each row
 * carries one step. A `ref` that comes back after another case started is a
 * duplicate, not a continuation.
 */
export function parseQaflowCsv(table: CsvTable): ParsedCases {
  const { byTarget, issues } = mapColumns(table.header, QAFLOW_HEADERS);
  if (!byTarget.has('title')) {
    issues.push(issue(1, 'title', 'MISSING_COLUMN', 'The header needs a "title" column'));
    return { cases: [], issues };
  }

  const cases: RawCase[] = [];
  const seenRefs = new Set<string>();
  let current: RawCase | null = null;

  for (const record of table.records) {
    const cell = (target: Target): RawCell | null =>
      cellOf(record.cells, table.header, byTarget.get(target));
    const ref = cell('ref')?.value.trim() ?? null;
    const step = {
      line: record.line,
      action: cell('step_action'),
      expected: cell('step_expected'),
      data: cell('step_data'),
    };

    if (ref !== null && current !== null && current.ref === ref) {
      current.steps.push(step);
      continue;
    }
    if (ref !== null && seenRefs.has(ref)) {
      issues.push(
        issue(
          record.line,
          table.header[byTarget.get('ref') ?? 0] ?? 'ref',
          'DUPLICATE_IN_FILE',
          `Ref "${ref}" already appeared earlier in the file`,
        ),
      );
      current = null;
      continue;
    }
    if (ref === null && cell('title') === null) {
      if (step.action !== null || step.expected !== null) {
        issues.push(
          issue(record.line, null, 'ORPHAN_STEP_ROW', 'A step row needs the "ref" of its case'),
        );
      }
      continue;
    }

    const fields: RawCase['fields'] = {};
    for (const target of FIELD_TARGETS) {
      const value = cell(target);
      if (value !== null) {
        fields[target] = value;
      }
    }
    current = { line: record.line, ref, fields, steps: [step] };
    if (ref !== null) {
      seenRefs.add(ref);
    }
    cases.push(current);
  }

  return { cases, issues };
}
