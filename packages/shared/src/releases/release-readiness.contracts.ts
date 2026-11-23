import type { ExecutionKpis } from '../analytics/analytics.contracts.js';
import type { DefectSeverity } from '../defects/defect.contracts.js';
import type { FlakyStatus } from '../flaky/flaky.contracts.js';
import { QA_METRICS_MIN_VERDICTS, SampledRates } from '../qa-metrics/qa-metrics.contracts.js';
import type { GateResult } from './quality-gate.contracts.js';
import type { ReleaseStatus } from './release.contracts.js';

/**
 * Release readiness report (S7-F8). The decision is derived on every read from
 * the quality gates, the release's runs, plans, cycles, defects, requirement
 * coverage, flaky detection and exploratory sessions; nothing is stored. The
 * rules are documented in docs/stage-7-roadmap.md § S7-F8.
 */
export const READINESS_DECISIONS = ['go', 'go_with_risks', 'no_go', 'insufficient_data'] as const;
export type ReadinessDecision = (typeof READINESS_DECISIONS)[number];

/** Fewer verdicts than this and the report does not issue GO or GO WITH RISKS. */
export const READINESS_MIN_VERDICTS = QA_METRICS_MIN_VERDICTS;
/** A failed rate (failed / verdicts, percent) above this is a NO-GO. */
export const READINESS_MAX_FAILED_RATE = 10;

export const READINESS_SOURCES = [
  'quality_gates',
  'execution',
  'defects',
  'test_cycles',
  'test_plans',
  'requirements',
  'flaky',
  'exploratory',
] as const;
export type ReadinessSource = (typeof READINESS_SOURCES)[number];

export const READINESS_REASON_CODES = [
  'required_gate_failed',
  'critical_defects_open',
  'failed_rate_above_threshold',
  'cycle_incomplete',
  'high_defects_open',
  'defects_reopened',
  'flaky_tests',
  'requirements_uncovered',
  'requirements_not_executed',
  'requirements_failing',
  'executions_pending',
  'tests_failed',
  'tests_blocked',
  'optional_gate_failed',
  'required_gate_pending',
  'plan_incomplete',
  'exploratory_incomplete',
  'findings_open',
  'not_enough_verdicts',
  'all_checks_passed',
] as const;
export type ReadinessReasonCode = (typeof READINESS_REASON_CODES)[number];

export type ReadinessLinkKind =
  | 'quality_gate'
  | 'defect'
  | 'test_cycle'
  | 'test_plan'
  | 'requirement'
  | 'test_case'
  | 'exploratory_session'
  | 'exploratory_finding';

export interface ReadinessLink {
  kind: ReadinessLinkKind;
  id: string;
  label: string;
}

export interface ReadinessReason {
  code: ReadinessReasonCode;
  /** The data set the reason comes from. */
  source: ReadinessSource;
  severity: 'blocker' | 'warning' | 'info';
  /** How many items the reason is about (defects, cases, requirements…). */
  count: number;
  /** English sentence for API consumers; the Web translates from `code`. */
  message: string;
  items: ReadinessLink[];
}

/** What the decision looks at; built by the API from the existing sources. */
export interface ReadinessFacts {
  gates: Array<{ id: string; name: string; required: boolean; result: GateResult }>;
  execution: Pick<ExecutionKpis, 'verdicts' | 'pending'> & {
    failed: number;
    blocked: number;
    /** Sampled failed rate: null below {@link READINESS_MIN_VERDICTS}. */
    failedRate: number | null;
  };
  defects: { critical: ReadinessLink[]; high: ReadinessLink[]; reopened: ReadinessLink[] };
  cycles: Array<{ id: string; name: string; status: string }>;
  plans: Array<{ id: string; name: string; status: string }>;
  requirements: {
    uncovered: ReadinessLink[];
    notExecuted: ReadinessLink[];
    failing: ReadinessLink[];
  };
  /** Cases of the release whose effective flaky status is flaky, suspect or failing. */
  flaky: Array<ReadinessLink & { status: FlakyStatus }>;
  exploratory: { incomplete: ReadinessLink[]; openFindings: ReadinessLink[] };
}

export interface ReadinessOutcome {
  decision: ReadinessDecision;
  /** Why the decision is what it is: the blockers, the sample gap, the warnings or "all passed". */
  reasons: ReadinessReason[];
  blockers: ReadinessReason[];
  warnings: ReadinessReason[];
}

export const INCOMPLETE_CYCLE_STATUSES = ['planned', 'active'] as const;
export const INCOMPLETE_PLAN_STATUSES = ['draft', 'active'] as const;
export const INCOMPLETE_SESSION_STATUSES = ['planned', 'active', 'paused'] as const;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function reason(
  severity: ReadinessReason['severity'],
  code: ReadinessReasonCode,
  source: ReadinessSource,
  items: ReadinessLink[],
  message: string,
  count = items.length,
): ReadinessReason {
  return { code, source, severity, count, message, items };
}

/**
 * The decision, deterministic over the facts:
 * 1. any blocker → NO-GO;
 * 2. otherwise fewer than {@link READINESS_MIN_VERDICTS} verdicts → INSUFFICIENT DATA;
 * 3. otherwise any warning → GO WITH RISKS;
 * 4. otherwise GO.
 */
export function decideReadiness(facts: ReadinessFacts): ReadinessOutcome {
  const gateLink = (gate: { id: string; name: string }): ReadinessLink => ({
    kind: 'quality_gate',
    id: gate.id,
    label: gate.name,
  });
  const blockers: ReadinessReason[] = [];
  const warnings: ReadinessReason[] = [];
  const { execution } = facts;

  const requiredFailed = facts.gates.filter((g) => g.required && g.result === 'failed');
  if (requiredFailed.length > 0) {
    blockers.push(
      reason(
        'blocker',
        'required_gate_failed',
        'quality_gates',
        requiredFailed.map(gateLink),
        `${plural(requiredFailed.length, 'required quality gate', 'required quality gates')} failed.`,
      ),
    );
  }
  if (facts.defects.critical.length > 0) {
    blockers.push(
      reason(
        'blocker',
        'critical_defects_open',
        'defects',
        facts.defects.critical,
        `${plural(facts.defects.critical.length, 'blocker/critical defect remains', 'blocker/critical defects remain')} open.`,
      ),
    );
  }
  if (execution.failedRate !== null && execution.failedRate > READINESS_MAX_FAILED_RATE) {
    blockers.push(
      reason(
        'blocker',
        'failed_rate_above_threshold',
        'execution',
        [],
        `Failed rate ${execution.failedRate}% is above the ${READINESS_MAX_FAILED_RATE}% threshold.`,
        execution.failed,
      ),
    );
  }
  const openCycles = facts.cycles.filter((c) =>
    (INCOMPLETE_CYCLE_STATUSES as readonly string[]).includes(c.status),
  );
  if (openCycles.length > 0) {
    blockers.push(
      reason(
        'blocker',
        'cycle_incomplete',
        'test_cycles',
        openCycles.map((c) => ({ kind: 'test_cycle', id: c.id, label: c.name })),
        `${plural(openCycles.length, 'test cycle of the release is', 'test cycles of the release are')} not completed.`,
      ),
    );
  }

  const warn = (
    code: ReadinessReasonCode,
    source: ReadinessSource,
    items: ReadinessLink[],
    message: string,
    count = items.length,
  ) => {
    if (count > 0) warnings.push(reason('warning', code, source, items, message, count));
  };
  const n = (count: number, one: string, many: string) => plural(count, one, many);

  const requiredPending = facts.gates.filter((g) => g.required && g.result === 'pending');
  warn(
    'required_gate_pending',
    'quality_gates',
    requiredPending.map(gateLink),
    `${n(requiredPending.length, 'required quality gate is', 'required quality gates are')} pending.`,
  );
  const optionalFailed = facts.gates.filter((g) => !g.required && g.result === 'failed');
  warn(
    'optional_gate_failed',
    'quality_gates',
    optionalFailed.map(gateLink),
    `${n(optionalFailed.length, 'optional quality gate', 'optional quality gates')} failed.`,
  );
  warn(
    'high_defects_open',
    'defects',
    facts.defects.high,
    `${n(facts.defects.high.length, 'major defect remains', 'major defects remain')} open.`,
  );
  warn(
    'defects_reopened',
    'defects',
    facts.defects.reopened,
    `${n(facts.defects.reopened.length, 'defect was', 'defects were')} reopened.`,
  );
  if (!blockers.some((b) => b.code === 'failed_rate_above_threshold')) {
    warn(
      'tests_failed',
      'execution',
      [],
      `${n(execution.failed, 'test case failed', 'test cases failed')}.`,
      execution.failed,
    );
  }
  warn(
    'tests_blocked',
    'execution',
    [],
    `${n(execution.blocked, 'test case is', 'test cases are')} blocked.`,
    execution.blocked,
  );
  warn(
    'executions_pending',
    'execution',
    [],
    `${n(execution.pending, 'test case is', 'test cases are')} not executed yet.`,
    execution.pending,
  );
  warn(
    'requirements_uncovered',
    'requirements',
    facts.requirements.uncovered,
    `${n(facts.requirements.uncovered.length, 'requirement has', 'requirements have')} no test case.`,
  );
  warn(
    'requirements_not_executed',
    'requirements',
    facts.requirements.notExecuted,
    `${n(facts.requirements.notExecuted.length, 'covered requirement was', 'covered requirements were')} not executed in the release.`,
  );
  warn(
    'requirements_failing',
    'requirements',
    facts.requirements.failing,
    `${n(facts.requirements.failing.length, 'requirement has', 'requirements have')} a failing test.`,
  );
  warn(
    'flaky_tests',
    'flaky',
    facts.flaky.map(({ kind, id, label }) => ({ kind, id, label })),
    `${n(facts.flaky.length, 'test case is', 'test cases are')} flaky, suspect or failing repeatedly.`,
  );
  const openPlans = facts.plans.filter((p) =>
    (INCOMPLETE_PLAN_STATUSES as readonly string[]).includes(p.status),
  );
  warn(
    'plan_incomplete',
    'test_plans',
    openPlans.map((p) => ({ kind: 'test_plan', id: p.id, label: p.name })),
    `${n(openPlans.length, 'test plan is', 'test plans are')} not completed.`,
  );
  warn(
    'exploratory_incomplete',
    'exploratory',
    facts.exploratory.incomplete,
    `${n(facts.exploratory.incomplete.length, 'exploratory session is', 'exploratory sessions are')} not finished.`,
  );
  warn(
    'findings_open',
    'exploratory',
    facts.exploratory.openFindings,
    `${n(facts.exploratory.openFindings.length, 'exploratory finding has', 'exploratory findings have')} no defect yet.`,
  );

  if (blockers.length > 0) {
    return { decision: 'no_go', reasons: blockers, blockers, warnings };
  }
  if (execution.verdicts < READINESS_MIN_VERDICTS) {
    const gap = reason(
      'info',
      'not_enough_verdicts',
      'execution',
      [],
      `Only ${n(execution.verdicts, 'verdict', 'verdicts')} recorded; at least ${READINESS_MIN_VERDICTS} are needed.`,
      execution.verdicts,
    );
    return { decision: 'insufficient_data', reasons: [gap], blockers, warnings };
  }
  if (warnings.length > 0) {
    return { decision: 'go_with_risks', reasons: warnings, blockers, warnings };
  }
  const passed = reason(
    'info',
    'all_checks_passed',
    'execution',
    [],
    'No blockers or risks: required gates pass and every check is clean.',
    0,
  );
  return { decision: 'go', reasons: [passed], blockers, warnings };
}

export interface ReadinessProgressRow {
  id: string;
  name: string;
  status: string;
  completion: number;
  passRate: number | null;
}

export interface ReleaseReadinessView {
  release: { id: string; name: string; version: string; status: ReleaseStatus };
  project: { id: string; key: string; name: string };
  decision: ReadinessDecision;
  reasons: ReadinessReason[];
  blockers: ReadinessReason[];
  warnings: ReadinessReason[];
  metrics: {
    qualityGates: {
      required: { result: GateResult; gateCount: number };
      gates: Array<{ id: string; name: string; required: boolean; result: GateResult }>;
      failed: number;
      pending: number;
    };
    execution: {
      runs: Array<{ id: string; name: string; status: string }>;
      kpis: ExecutionKpis;
      rates: SampledRates;
    };
    plans: ReadinessProgressRow[];
    cycles: ReadinessProgressRow[];
    defects: {
      open: number;
      bySeverity: Record<DefectSeverity, number>;
      reopened: number;
      critical: ReadinessLink[];
      high: ReadinessLink[];
    };
    requirements: {
      total: number;
      covered: number;
      uncovered: number;
      coveredNotExecuted: number;
      failing: number;
      /** covered / total in percent, one decimal; null without requirements. */
      coverage: number | null;
    };
    flaky: {
      flaky: number;
      suspect: number;
      failing: number;
      confirmed: number;
      dismissed: number;
    };
    exploratory: {
      sessions: number;
      incomplete: number;
      findings: number;
      openFindings: number;
      convertedFindings: number;
    };
  };
  thresholds: { minVerdicts: number; maxFailedRate: number };
  computedAt: string;
}
