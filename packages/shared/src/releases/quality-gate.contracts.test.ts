import { describe, expect, it } from 'vitest';
import {
  combineGateResults,
  createQualityGateSchema,
  evaluateQualityGateRule,
} from './quality-gate.contracts.js';
import type { QualityGateFacts, QualityGateRuleType } from './quality-gate.contracts.js';

const empty: QualityGateFacts = {
  cases: { total: 0, executed: 0, passed: 0, failed: 0, blocked: 0 },
  runs: [],
  requirements: { total: 0, covered: 0, uncovered: [] },
  defects: { critical: [], high: [] },
  build: null,
  reviews: [],
};
const run = { id: 'r1', name: 'Regression', status: 'completed', failed: 2, blocked: 1 };
const facts: QualityGateFacts = {
  cases: { total: 10, executed: 10, passed: 7, failed: 2, blocked: 1 },
  runs: [run],
  requirements: { total: 4, covered: 3, uncovered: [{ id: 'q4', key: 'REQ-4' }] },
  defects: {
    critical: [{ id: 'd1', key: 'D-1', title: 'Crash' }],
    high: [{ id: 'd2', key: 'D-2', title: 'Slow' }],
  },
  build: { id: 'b1', identifier: 'ci-1', status: 'passed' },
  reviews: [{ id: 'cr1', title: 'Review', status: 'approved' }],
};
const result = (type: QualityGateRuleType, threshold: number | null, data = facts) =>
  evaluateQualityGateRule({ type, threshold }, data);

describe('quality gate rules', () => {
  it('passes and fails each measured rule against its threshold', () => {
    expect(result('min_pass_rate', 70).result).toBe('passed');
    expect(result('min_pass_rate', 80)).toEqual(
      expect.objectContaining({
        result: 'failed',
        actual: 70,
        links: [expect.objectContaining({ id: 'r1' })],
      }),
    );
    expect(result('max_failed_tests', 2).result).toBe('passed');
    expect(result('max_failed_tests', 1).result).toBe('failed');
    expect(result('max_blocked_tests', 1).result).toBe('passed');
    expect(result('max_blocked_tests', 0).result).toBe('failed');
    expect(result('min_requirement_coverage', 75).result).toBe('passed');
    expect(result('min_requirement_coverage', 80).links).toEqual([
      { kind: 'requirement', id: 'q4', label: 'REQ-4' },
    ]);
    expect(result('max_open_critical_defects', 1).result).toBe('passed');
    expect(result('max_open_critical_defects', 0).links[0]?.id).toBe('d1');
    expect(result('max_open_high_defects', 0).result).toBe('failed');
  });

  it('is pending without data and not applicable without requirements', () => {
    for (const type of [
      'min_pass_rate',
      'max_failed_tests',
      'max_blocked_tests',
      'build_must_pass',
      'completed_test_run_required',
      'code_review_approval_required',
    ] as const) {
      expect(result(type, type.startsWith('m') ? 1 : null, empty).result).toBe('pending');
    }
    expect(result('min_requirement_coverage', 50, empty).result).toBe('not_applicable');
    expect(result('max_open_critical_defects', 0, empty).result).toBe('passed');
  });

  it('follows builds, runs and reviews', () => {
    expect(result('build_must_pass', null).result).toBe('passed');
    const build = (status: string) => ({ ...facts, build: { id: 'b', identifier: 'ci', status } });
    expect(result('build_must_pass', null, build('failed')).result).toBe('failed');
    expect(result('build_must_pass', null, build('running')).result).toBe('pending');
    expect(result('completed_test_run_required', null).result).toBe('passed');
    expect(
      result('completed_test_run_required', null, {
        ...facts,
        runs: [{ ...run, status: 'in_progress' }],
      }).result,
    ).toBe('pending');
    const reviews = (...statuses: string[]) => ({
      ...facts,
      reviews: statuses.map((status, index) => ({ id: `cr${index}`, title: 't', status })),
    });
    expect(result('code_review_approval_required', null).result).toBe('passed');
    expect(
      result('code_review_approval_required', null, reviews('approved', 'in_review')).result,
    ).toBe('pending');
    expect(
      result('code_review_approval_required', null, reviews('approved', 'changes_requested'))
        .result,
    ).toBe('failed');
  });

  it('combines results and validates rules', () => {
    expect(combineGateResults(['passed', 'pending', 'failed'])).toBe('failed');
    expect(combineGateResults(['passed', 'pending'])).toBe('pending');
    expect(combineGateResults(['passed', 'not_applicable'])).toBe('passed');
    expect(combineGateResults(['not_applicable'])).toBe('not_applicable');
    expect(combineGateResults([])).toBe('not_applicable');
    const base = { projectId: 'p', name: 'g' };
    expect(
      createQualityGateSchema.safeParse({
        ...base,
        rules: [{ type: 'min_pass_rate', threshold: 90 }],
      }).success,
    ).toBe(true);
    for (const rules of [
      [],
      [{ type: 'min_pass_rate' }],
      [{ type: 'min_pass_rate', threshold: 120 }],
      [{ type: 'max_failed_tests', threshold: 1.5 }],
      [{ type: 'build_must_pass', threshold: 1 }],
      [{ type: 'build_must_pass' }, { type: 'build_must_pass' }],
    ]) {
      expect(createQualityGateSchema.safeParse({ ...base, rules }).success).toBe(false);
    }
  });
});
