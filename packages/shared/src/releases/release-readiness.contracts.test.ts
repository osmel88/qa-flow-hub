import { describe, expect, it } from 'vitest';
import {
  READINESS_MAX_FAILED_RATE,
  READINESS_MIN_VERDICTS,
  type ReadinessFacts,
  decideReadiness,
} from './release-readiness.contracts.js';

const link = (kind: 'defect' | 'requirement', id: string) => ({ kind, id, label: id });

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    gates: [{ id: 'g1', name: 'Release gate', required: true, result: 'passed' }],
    execution: { verdicts: 10, pending: 0, failed: 0, blocked: 0, failedRate: 0 },
    defects: { critical: [], high: [], reopened: [] },
    cycles: [{ id: 'c1', name: 'Cycle', status: 'completed' }],
    plans: [{ id: 'p1', name: 'Plan', status: 'completed' }],
    requirements: { uncovered: [], notExecuted: [], failing: [] },
    flaky: [],
    exploratory: { incomplete: [], openFindings: [] },
    ...overrides,
  };
}

describe('decideReadiness', () => {
  it('is GO when every check is clean', () => {
    const outcome = decideReadiness(facts());
    expect(outcome.decision).toBe('go');
    expect(outcome.blockers).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.reasons.map((r) => r.code)).toEqual(['all_checks_passed']);
  });

  it('is NO-GO with an open critical defect and says how many', () => {
    const outcome = decideReadiness(
      facts({
        defects: {
          critical: [link('defect', 'D-1'), link('defect', 'D-2')],
          high: [],
          reopened: [],
        },
      }),
    );
    expect(outcome.decision).toBe('no_go');
    expect(outcome.blockers[0]).toMatchObject({
      code: 'critical_defects_open',
      source: 'defects',
      severity: 'blocker',
      count: 2,
      message: '2 blocker/critical defects remain open.',
    });
  });

  it('is NO-GO when a required gate fails, but an optional failure is only a warning', () => {
    expect(
      decideReadiness(facts({ gates: [{ id: 'g', name: 'G', required: true, result: 'failed' }] }))
        .blockers[0]?.code,
    ).toBe('required_gate_failed');
    const optional = decideReadiness(
      facts({ gates: [{ id: 'g', name: 'G', required: false, result: 'failed' }] }),
    );
    expect(optional.decision).toBe('go_with_risks');
    expect(optional.warnings[0]?.code).toBe('optional_gate_failed');
  });

  it('is NO-GO with an incomplete cycle', () => {
    const outcome = decideReadiness(facts({ cycles: [{ id: 'c', name: 'C', status: 'active' }] }));
    expect(outcome.decision).toBe('no_go');
    expect(outcome.blockers[0]).toMatchObject({ code: 'cycle_incomplete', source: 'test_cycles' });
  });

  it('blocks above the failed-rate threshold and warns at it', () => {
    const above = decideReadiness(
      facts({
        execution: {
          verdicts: 10,
          pending: 0,
          failed: 2,
          blocked: 0,
          failedRate: READINESS_MAX_FAILED_RATE + 10,
        },
      }),
    );
    expect(above.decision).toBe('no_go');
    expect(above.blockers.map((b) => b.code)).toEqual(['failed_rate_above_threshold']);
    expect(above.warnings.map((w) => w.code)).not.toContain('tests_failed');
    const at = decideReadiness(
      facts({
        execution: {
          verdicts: 10,
          pending: 0,
          failed: 1,
          blocked: 0,
          failedRate: READINESS_MAX_FAILED_RATE,
        },
      }),
    );
    expect(at.decision).toBe('go_with_risks');
    expect(at.warnings.map((w) => w.code)).toEqual(['tests_failed']);
  });

  it('is GO WITH RISKS with flaky cases, missing coverage, majors, pending and findings', () => {
    const outcome = decideReadiness(
      facts({
        execution: { verdicts: 10, pending: 3, failed: 0, blocked: 1, failedRate: 0 },
        defects: { critical: [], high: [link('defect', 'D-3')], reopened: [link('defect', 'D-3')] },
        requirements: {
          uncovered: [link('requirement', 'R-1')],
          notExecuted: [link('requirement', 'R-2')],
          failing: [link('requirement', 'R-3')],
        },
        flaky: [{ kind: 'test_case', id: 'tc', label: 'TC-1', status: 'suspect' }],
        plans: [{ id: 'p', name: 'P', status: 'active' }],
        exploratory: {
          incomplete: [{ kind: 'exploratory_session', id: 's', label: 'S' }],
          openFindings: [{ kind: 'exploratory_finding', id: 'f', label: 'F' }],
        },
      }),
    );
    expect(outcome.decision).toBe('go_with_risks');
    expect(outcome.blockers).toEqual([]);
    expect(outcome.reasons).toBe(outcome.warnings);
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      'high_defects_open',
      'defects_reopened',
      'tests_blocked',
      'executions_pending',
      'requirements_uncovered',
      'requirements_not_executed',
      'requirements_failing',
      'flaky_tests',
      'plan_incomplete',
      'exploratory_incomplete',
      'findings_open',
    ]);
  });

  it('is INSUFFICIENT DATA below the minimum sample, even with warnings', () => {
    const outcome = decideReadiness(
      facts({
        execution: {
          verdicts: READINESS_MIN_VERDICTS - 1,
          pending: 5,
          failed: 0,
          blocked: 0,
          failedRate: null,
        },
      }),
    );
    expect(outcome.decision).toBe('insufficient_data');
    expect(outcome.reasons[0]).toMatchObject({ code: 'not_enough_verdicts', count: 4 });
    expect(outcome.warnings.map((w) => w.code)).toEqual(['executions_pending']);
  });

  it('treats an empty release as INSUFFICIENT DATA', () => {
    const outcome = decideReadiness(
      facts({
        gates: [],
        cycles: [],
        plans: [],
        execution: { verdicts: 0, pending: 0, failed: 0, blocked: 0, failedRate: null },
      }),
    );
    expect(outcome.decision).toBe('insufficient_data');
  });

  it('lets a blocker win over the sample gap', () => {
    const outcome = decideReadiness(
      facts({
        execution: { verdicts: 0, pending: 0, failed: 0, blocked: 0, failedRate: null },
        defects: { critical: [link('defect', 'D-1')], high: [], reopened: [] },
      }),
    );
    expect(outcome.decision).toBe('no_go');
  });
});
