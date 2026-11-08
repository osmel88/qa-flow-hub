import { z } from 'zod';

/**
 * Quality gates (S6-F3): named sets of rules of a project, optionally for one
 * environment. A gate is evaluated against the current data of a release on
 * every read; results are never stored. Required gates of a protected
 * environment must pass (or be overridden) before a deployment of the
 * release starts there.
 */
export const QUALITY_GATE_RULE_TYPES = [
  'min_pass_rate',
  'max_failed_tests',
  'max_blocked_tests',
  'min_requirement_coverage',
  'max_open_critical_defects',
  'max_open_high_defects',
  'build_must_pass',
  'completed_test_run_required',
  'code_review_approval_required',
] as const;
export type QualityGateRuleType = (typeof QUALITY_GATE_RULE_TYPES)[number];

/** Rules measured as a percentage (0–100); the rest of the thresholds are counts. */
export const PERCENT_RULES: readonly QualityGateRuleType[] = [
  'min_pass_rate',
  'min_requirement_coverage',
];
/** Rules that take no threshold. */
export const FLAG_RULES: readonly QualityGateRuleType[] = [
  'build_must_pass',
  'completed_test_run_required',
  'code_review_approval_required',
];

export const QUALITY_GATE_RULE_LABELS: Record<QualityGateRuleType, string> = {
  min_pass_rate: 'Minimum test pass rate (%)',
  max_failed_tests: 'Maximum failed tests',
  max_blocked_tests: 'Maximum blocked tests',
  min_requirement_coverage: 'Minimum requirement coverage (%)',
  max_open_critical_defects: 'Maximum open critical defects',
  max_open_high_defects: 'Maximum open high defects',
  build_must_pass: 'A build is required and must pass',
  completed_test_run_required: 'At least one completed test run',
  code_review_approval_required: 'Code reviews must be approved',
};

export const GATE_RESULTS = ['passed', 'failed', 'pending', 'not_applicable'] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

/** Critical = blocker + critical severity; high = major (the model has no "high"). */
export const GATE_CRITICAL_SEVERITIES = ['blocker', 'critical'] as const;
export const GATE_HIGH_SEVERITIES = ['major'] as const;

const idSchema = z.string().min(1).max(64);

export const qualityGateRuleSchema = z
  .object({
    type: z.enum(QUALITY_GATE_RULE_TYPES),
    threshold: z.number().finite().min(0).nullable().optional(),
  })
  .superRefine((rule, context) => {
    const threshold = rule.threshold ?? null;
    if (FLAG_RULES.includes(rule.type)) {
      if (threshold !== null) {
        context.addIssue({ code: 'custom', path: ['threshold'], message: 'Takes no threshold' });
      }
      return;
    }
    if (threshold === null) {
      context.addIssue({ code: 'custom', path: ['threshold'], message: 'Threshold required' });
    } else if (PERCENT_RULES.includes(rule.type) ? threshold > 100 : !Number.isInteger(threshold)) {
      context.addIssue({
        code: 'custom',
        path: ['threshold'],
        message: PERCENT_RULES.includes(rule.type) ? 'At most 100' : 'A whole number',
      });
    }
  });
export type QualityGateRuleInput = z.infer<typeof qualityGateRuleSchema>;

const rulesSchema = z
  .array(qualityGateRuleSchema)
  .min(1)
  .max(QUALITY_GATE_RULE_TYPES.length)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.type)).size === rules.length,
    'Each rule type at most once per gate',
  );

const nameSchema = z.string().trim().min(1).max(100);

export const createQualityGateSchema = z.object({
  projectId: idSchema,
  name: nameSchema,
  description: z.string().trim().min(1).max(2000).optional(),
  /** Without it the gate applies to every environment of the project. */
  environmentId: idSchema.optional(),
  required: z.boolean().default(true),
  enabled: z.boolean().default(true),
  rules: rulesSchema,
});
export type CreateQualityGateInput = z.infer<typeof createQualityGateSchema>;

export const updateQualityGateSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().min(1).max(2000).nullable().optional(),
    environmentId: idSchema.nullable().optional(),
    required: z.boolean().optional(),
    enabled: z.boolean().optional(),
    /** Replaces every rule of the gate. */
    rules: rulesSchema.optional(),
    version: z.number().int().min(1).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), 'Nothing to update');
export type UpdateQualityGateInput = z.infer<typeof updateQualityGateSchema>;

export const listQualityGatesQuerySchema = z.object({
  projectId: idSchema,
  environmentId: idSchema.optional(),
});
export type ListQualityGatesQuery = z.infer<typeof listQualityGatesQuerySchema>;

export const evaluateQualityGatesQuerySchema = z.object({
  /** Without it only the project-wide gates are evaluated. */
  environmentId: idSchema.optional(),
});
export type EvaluateQualityGatesQuery = z.infer<typeof evaluateQualityGatesQuerySchema>;

export const overrideQualityGatesSchema = z.object({
  environmentId: idSchema,
  reason: z.string().trim().min(10, 'Explain the override in at least 10 characters').max(2000),
});
export type OverrideQualityGatesInput = z.infer<typeof overrideQualityGatesSchema>;

export interface QualityGateView {
  id: string;
  projectId: string;
  environment: { id: string; name: string } | null;
  name: string;
  description: string | null;
  required: boolean;
  enabled: boolean;
  version: number;
  rules: Array<{ type: QualityGateRuleType; threshold: number | null }>;
  createdAt: string;
  updatedAt: string;
}

export type GateLinkKind = 'test_run' | 'defect' | 'build' | 'code_review' | 'requirement';
export interface GateLink {
  kind: GateLinkKind;
  id: string;
  label: string;
}

/** Everything the rules look at, gathered from one snapshot of the release. */
export interface QualityGateFacts {
  cases: { total: number; executed: number; passed: number; failed: number; blocked: number };
  runs: Array<{ id: string; name: string; status: string; failed: number; blocked: number }>;
  requirements: { total: number; covered: number; uncovered: Array<{ id: string; key: string }> };
  defects: {
    critical: Array<{ id: string; key: string; title: string }>;
    high: Array<{ id: string; key: string; title: string }>;
  };
  /** Newest live build of the release, whatever its status. */
  build: { id: string; identifier: string | null; status: string | null } | null;
  /** Live, non-dismissed code reviews of the release's work items. */
  reviews: Array<{ id: string; title: string; status: string }>;
}

export interface QualityGateRuleResult {
  type: QualityGateRuleType;
  threshold: number | null;
  result: GateResult;
  /** What was measured, when the rule measures something. */
  actual: number | null;
  message: string;
  /** The tests, defects, build or reviews behind a failure or a pending result. */
  links: GateLink[];
}

export interface QualityGateEvaluation {
  gate: QualityGateView;
  result: GateResult;
  rules: QualityGateRuleResult[];
}

export interface ReleaseQualityGatesView {
  release: { id: string; name: string; version: string };
  environment: { id: string; name: string; protected: boolean } | null;
  gates: QualityGateEvaluation[];
  /** Combined result of the enabled required gates. */
  required: { result: GateResult; gateCount: number };
  /** Latest manual override of this release in this environment. */
  override: {
    id: string;
    reason: string;
    gateStatus: string;
    createdAt: string;
    createdBy: { id: string; fullName: string } | null;
  } | null;
  /** A deployment of the release may start there as far as gates go. */
  deployable: boolean;
  evaluatedAt: string;
}

const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;
const runLink = (run: { id: string; name: string }): GateLink => ({
  kind: 'test_run',
  id: run.id,
  label: run.name,
});
const defectLink = (defect: { id: string; key: string; title: string }): GateLink => ({
  kind: 'defect',
  id: defect.id,
  label: `${defect.key} · ${defect.title}`,
});

/** One rule against the facts: what it measured, its result and why. */
export function evaluateQualityGateRule(
  rule: { type: QualityGateRuleType; threshold: number | null },
  facts: QualityGateFacts,
): QualityGateRuleResult {
  const threshold = rule.threshold;
  const done = (
    result: GateResult,
    message: string,
    actual: number | null = null,
    links: GateLink[] = [],
  ): QualityGateRuleResult => ({ type: rule.type, threshold, result, actual, message, links });
  const limit = threshold ?? 0;
  switch (rule.type) {
    case 'min_pass_rate': {
      if (facts.cases.executed === 0) {
        return done('pending', 'No test of the release has been executed yet');
      }
      const rate = percent(facts.cases.passed, facts.cases.executed);
      return rate >= limit
        ? done('passed', `Pass rate ${rate}% meets ${limit}%`, rate)
        : done(
            'failed',
            `Pass rate ${rate}% is below ${limit}%`,
            rate,
            facts.runs.filter((run) => run.failed > 0).map(runLink),
          );
    }
    case 'max_failed_tests':
    case 'max_blocked_tests': {
      const key = rule.type === 'max_failed_tests' ? 'failed' : 'blocked';
      if (facts.cases.total === 0) {
        return done('pending', 'The release has no test yet');
      }
      const count = facts.cases[key];
      return count <= limit
        ? done('passed', `${count} ${key} test(s), at most ${limit} allowed`, count)
        : done(
            'failed',
            `${count} ${key} test(s), more than the ${limit} allowed`,
            count,
            facts.runs.filter((run) => run[key] > 0).map(runLink),
          );
    }
    case 'min_requirement_coverage': {
      if (facts.requirements.total === 0) {
        return done('not_applicable', 'The project has no requirement to cover');
      }
      const coverage = percent(facts.requirements.covered, facts.requirements.total);
      return coverage >= limit
        ? done('passed', `Requirement coverage ${coverage}% meets ${limit}%`, coverage)
        : done(
            'failed',
            `Requirement coverage ${coverage}% is below ${limit}%: ${facts.requirements.uncovered.length} requirement(s) without a verifying test case`,
            coverage,
            facts.requirements.uncovered.slice(0, 20).map((requirement) => ({
              kind: 'requirement' as const,
              id: requirement.id,
              label: requirement.key,
            })),
          );
    }
    case 'max_open_critical_defects':
    case 'max_open_high_defects': {
      const list =
        rule.type === 'max_open_critical_defects' ? facts.defects.critical : facts.defects.high;
      const kind = rule.type === 'max_open_critical_defects' ? 'critical' : 'high';
      return list.length <= limit
        ? done(
            'passed',
            `${list.length} open ${kind} defect(s), at most ${limit} allowed`,
            list.length,
          )
        : done(
            'failed',
            `${list.length} open ${kind} defect(s), more than the ${limit} allowed`,
            list.length,
            list.map(defectLink),
          );
    }
    case 'build_must_pass': {
      if (facts.build === null) {
        return done('pending', 'The release has no build yet');
      }
      const link: GateLink = {
        kind: 'build',
        id: facts.build.id,
        label: facts.build.identifier ?? facts.build.id,
      };
      if (facts.build.status === 'passed') {
        return done('passed', `Build ${link.label} passed`, null, [link]);
      }
      if (facts.build.status === 'failed' || facts.build.status === 'cancelled') {
        return done('failed', `Latest build ${link.label} ${facts.build.status}`, null, [link]);
      }
      return done(
        'pending',
        `Latest build ${link.label} is still ${facts.build.status ?? 'queued'}`,
        null,
        [link],
      );
    }
    case 'completed_test_run_required': {
      const completed = facts.runs.filter((run) => run.status === 'completed');
      return completed.length > 0
        ? done(
            'passed',
            `${completed.length} completed test run(s)`,
            completed.length,
            completed.slice(0, 1).map(runLink),
          )
        : done(
            'pending',
            'No test run of the release is completed yet',
            0,
            facts.runs.filter((run) => run.status !== 'aborted').map(runLink),
          );
    }
    case 'code_review_approval_required': {
      const links = (status?: string) =>
        facts.reviews
          .filter((review) =>
            status === undefined ? review.status !== 'approved' : review.status === status,
          )
          .map((review) => ({ kind: 'code_review' as const, id: review.id, label: review.title }));
      if (facts.reviews.length === 0) {
        return done('pending', 'No code review covers the work items of the release');
      }
      if (facts.reviews.some((review) => review.status === 'changes_requested')) {
        return done(
          'failed',
          'Changes were requested in a code review',
          null,
          links('changes_requested'),
        );
      }
      const pending = facts.reviews.filter((review) => review.status !== 'approved');
      return pending.length === 0
        ? done('passed', `${facts.reviews.length} code review(s) approved`, facts.reviews.length)
        : done(
            'pending',
            `${pending.length} code review(s) not approved yet`,
            pending.length,
            links(),
          );
    }
  }
}

/** Failed beats pending beats passed; only not-applicable results (or none) are not applicable. */
export function combineGateResults(results: readonly GateResult[]): GateResult {
  if (results.includes('failed')) {
    return 'failed';
  }
  if (results.includes('pending')) {
    return 'pending';
  }
  return results.includes('passed') ? 'passed' : 'not_applicable';
}

export function gateAllowsDeployment(result: GateResult): boolean {
  return result === 'passed' || result === 'not_applicable';
}
