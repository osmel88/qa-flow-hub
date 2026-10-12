import { AutomationStatus, PriorityValue, TestCaseType } from '@qa-flow-hub/shared';
import { CaseField, FieldDialect, ParsedCases, RawCase, RawCell, issue } from './case-draft';
import { CsvTable } from './csv-input';
import { cellOf, mapColumns } from './qaflow-csv.parser';

/**
 * Columns of the TestRail "Export to CSV" of test cases, matched by header name
 * because the person exporting chooses which columns to include. Lower case.
 * Custom fields (`Custom …` or anything else) are reported and ignored.
 */
const TESTRAIL_HEADERS: Record<
  string,
  CaseField | 'ref' | 'step_action' | 'step_expected' | 'step_data'
> = {
  id: 'ref',
  'case id': 'ref',
  title: 'title',
  suite: 'suite',
  section: 'section',
  'section hierarchy': 'section',
  type: 'type',
  priority: 'priority',
  'automation type': 'automation',
  estimate: 'estimate',
  references: 'references',
  preconditions: 'preconditions',
  'steps (step)': 'step_action',
  'steps (expected result)': 'step_expected',
  'steps (additional info)': 'step_data',
  steps: 'description',
  'expected result': 'expected_result',
  mission: 'description',
  goals: 'expected_result',
};

const TYPES: Record<string, TestCaseType> = {
  functional: 'functional',
  functionality: 'functional',
  acceptance: 'functional',
  regression: 'regression',
  'smoke & sanity': 'smoke',
  smoke: 'smoke',
  integration: 'integration',
  performance: 'performance',
  security: 'security',
  usability: 'usability',
  accessibility: 'usability',
  exploratory: 'exploratory',
};

function testrailPriority(value: string): PriorityValue | null {
  const text = value.trim().toLowerCase();
  if (text.includes('critical')) return 'critical';
  if (text.includes('high') || text.includes('must test')) return 'high';
  if (text.includes('medium') || text.includes('test if time')) return 'medium';
  if (text.includes('low') || text.includes("don't test") || text.includes('dont test'))
    return 'low';
  return null;
}

function testrailAutomation(value: string): AutomationStatus | null {
  const text = value.trim().toLowerCase();
  if (text === 'none' || text === 'manual') return 'manual';
  if (text.includes('candidate') || text.includes('to be automated')) return 'candidate';
  if (text.includes('automat')) return 'automated';
  return null;
}

const UNIT_SECONDS: Record<string, number> = { w: 7 * 86_400, d: 86_400, h: 3600, m: 60, s: 1 };

/** TestRail timespans: `30s`, `1m 30s`, `2h`, `1h 15m`, `1d`. Rounded up to minutes. */
export function testrailEstimateMinutes(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (/^\d{1,6}$/.test(text)) {
    return Math.ceil(Number(text) / 60);
  }
  if (!/^(\d{1,6}\s*[wdhms]\s*)+$/.test(text)) {
    return null;
  }
  let seconds = 0;
  for (const match of text.matchAll(/(\d{1,6})\s*([wdhms])/g)) {
    seconds += Number(match[1]) * (UNIT_SECONDS[match[2] ?? 's'] ?? 0);
  }
  return Math.ceil(seconds / 60);
}

export const TESTRAIL_DIALECT: FieldDialect = {
  type: (value) => TYPES[value.trim().toLowerCase()] ?? null,
  priority: testrailPriority,
  automation: testrailAutomation,
  status: () => null,
  estimateMinutes: testrailEstimateMinutes,
  defaultStatus: 'active',
};

const FIELD_TARGETS: CaseField[] = [
  'suite',
  'section',
  'title',
  'type',
  'priority',
  'automation',
  'estimate',
  'references',
  'preconditions',
  'description',
  'expected_result',
];

/**
 * Both layouts of the TestRail case export:
 *
 * - one row per case: separated steps, if any, fit in that row;
 * - "Include separated steps on separate rows": the case row carries the
 *   fields (and usually the first step), and the following rows with an empty
 *   ID carry one step each.
 *
 * The text template's `Steps` cell is free text and lands in `description`;
 * its `Expected Result` lands in the case's expected result.
 */
export function parseTestrailCsv(table: CsvTable): ParsedCases {
  const { byTarget, issues } = mapColumns(table.header, TESTRAIL_HEADERS);
  if (!byTarget.has('title')) {
    issues.push(
      issue(
        1,
        'Title',
        'MISSING_COLUMN',
        'The header needs a "Title" column (TestRail case export)',
      ),
    );
    return { cases: [], issues };
  }

  const cases: RawCase[] = [];
  const seenRefs = new Set<string>();
  let current: RawCase | null = null;

  for (const record of table.records) {
    const cell = (target: string): RawCell | null =>
      cellOf(record.cells, table.header, byTarget.get(target as CaseField));
    const ref = cell('ref')?.value.trim().toUpperCase() ?? null;
    const title = cell('title');
    const step = {
      line: record.line,
      action: cell('step_action'),
      expected: cell('step_expected'),
      data: cell('step_data'),
    };

    if (ref === null && title === null) {
      if (current === null) {
        if (step.action !== null || step.expected !== null) {
          issues.push(
            issue(record.line, null, 'ORPHAN_STEP_ROW', 'A step row appears before any case'),
          );
        }
        continue;
      }
      current.steps.push(step);
      continue;
    }
    if (ref !== null && seenRefs.has(ref)) {
      issues.push(
        issue(
          record.line,
          table.header[byTarget.get('ref') ?? 0] ?? 'ID',
          'DUPLICATE_IN_FILE',
          `Case ${ref} already appeared earlier in the file`,
        ),
      );
      current = null;
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
