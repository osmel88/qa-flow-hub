export const releaseReadiness = {
  'releaseReadiness.title': 'Release readiness',
  'releaseReadiness.description':
    'Derived on every visit from quality gates, runs, plans, cycles, defects, requirement coverage, flaky tests and exploratory sessions. Nothing is stored.',
  'releaseReadiness.printable': 'Printable readiness report',
  'releaseReadiness.printTitle': 'Readiness report',
  'releaseReadiness.project': 'Project',
  'releaseReadiness.release': 'Release',
  'releaseReadiness.generated': 'Generated',
  'releaseReadiness.computedAt': 'Computed {date}',
  'releaseReadiness.thresholds':
    'Thresholds: at least {minVerdicts} verdicts; failed rate at most {maxFailedRate}%.',
  'releaseReadiness.decisionLabel': 'Decision',
  'releaseReadiness.decision.go': 'GO',
  'releaseReadiness.decision.go_with_risks': 'GO WITH RISKS',
  'releaseReadiness.decision.no_go': 'NO-GO',
  'releaseReadiness.decision.insufficient_data': 'INSUFFICIENT DATA',
  'releaseReadiness.summary.go': 'Ready to release: no blockers and no risks were found.',
  'releaseReadiness.summary.go_with_risks':
    'Can be released with {warnings, plural, one {# accepted risk} other {# accepted risks}} and no blockers.',
  'releaseReadiness.summary.no_go':
    'Not ready: {blockers, plural, one {# blocker} other {# blockers}} must be resolved first.',
  'releaseReadiness.summary.insufficient_data': 'Not enough evidence yet to decide responsibly.',
  'releaseReadiness.reasons': 'Reasons',
  'releaseReadiness.blockers': 'Blockers',
  'releaseReadiness.warnings': 'Warnings',
  'releaseReadiness.none': 'None.',
  'releaseReadiness.andMore': 'and {count} more',
  'releaseReadiness.source.quality_gates': 'quality gates',
  'releaseReadiness.source.execution': 'QA execution',
  'releaseReadiness.source.defects': 'defects',
  'releaseReadiness.source.test_cycles': 'test cycles',
  'releaseReadiness.source.test_plans': 'test plans',
  'releaseReadiness.source.requirements': 'requirements coverage',
  'releaseReadiness.source.flaky': 'flaky detection',
  'releaseReadiness.source.exploratory': 'exploratory testing',
  'releaseReadiness.reason.required_gate_failed':
    '{count, plural, one {# required quality gate failed} other {# required quality gates failed}}.',
  'releaseReadiness.reason.critical_defects_open':
    '{count, plural, one {# blocker/critical defect remains open} other {# blocker/critical defects remain open}}.',
  'releaseReadiness.reason.failed_rate_above_threshold':
    'The failed rate is above the {max}% threshold ({count, plural, one {# failed case} other {# failed cases}}).',
  'releaseReadiness.reason.cycle_incomplete':
    '{count, plural, one {# test cycle of the release is} other {# test cycles of the release are}} not completed.',
  'releaseReadiness.reason.high_defects_open':
    '{count, plural, one {# major defect remains open} other {# major defects remain open}}.',
  'releaseReadiness.reason.defects_reopened':
    '{count, plural, one {# defect was reopened} other {# defects were reopened}}.',
  'releaseReadiness.reason.flaky_tests':
    '{count, plural, one {# test case is} other {# test cases are}} flaky, suspect or failing repeatedly.',
  'releaseReadiness.reason.requirements_uncovered':
    '{count, plural, one {# requirement has} other {# requirements have}} no test case.',
  'releaseReadiness.reason.requirements_not_executed':
    '{count, plural, one {# covered requirement was} other {# covered requirements were}} not executed in the release.',
  'releaseReadiness.reason.requirements_failing':
    '{count, plural, one {# requirement has} other {# requirements have}} a failing test.',
  'releaseReadiness.reason.executions_pending':
    '{count, plural, one {# test case is} other {# test cases are}} not executed yet.',
  'releaseReadiness.reason.tests_failed':
    '{count, plural, one {# test case failed} other {# test cases failed}}.',
  'releaseReadiness.reason.tests_blocked':
    '{count, plural, one {# test case is} other {# test cases are}} blocked.',
  'releaseReadiness.reason.optional_gate_failed':
    '{count, plural, one {# optional quality gate failed} other {# optional quality gates failed}}.',
  'releaseReadiness.reason.required_gate_pending':
    '{count, plural, one {# required quality gate is} other {# required quality gates are}} pending.',
  'releaseReadiness.reason.plan_incomplete':
    '{count, plural, one {# test plan is} other {# test plans are}} not completed.',
  'releaseReadiness.reason.exploratory_incomplete':
    '{count, plural, one {# exploratory session is} other {# exploratory sessions are}} not finished.',
  'releaseReadiness.reason.findings_open':
    '{count, plural, one {# exploratory bug finding has} other {# exploratory bug findings have}} no defect yet.',
  'releaseReadiness.reason.not_enough_verdicts':
    'Only {count, plural, one {# verdict} other {# verdicts}} recorded; at least {min} are needed.',
  'releaseReadiness.reason.all_checks_passed':
    'No blockers or risks: required gates pass and every check is clean.',
  'releaseReadiness.qualityGates': 'Quality gates',
  'releaseReadiness.requiredResult': 'Required gates: {result} ({count})',
  'releaseReadiness.noGates': 'No quality gate applies to this release.',
  'releaseReadiness.gate': 'Gate',
  'releaseReadiness.required': 'Required',
  'releaseReadiness.result': 'Result',
  'releaseReadiness.yes': 'Yes',
  'releaseReadiness.no': 'No',
  'releaseReadiness.gateResult.passed': 'Passed',
  'releaseReadiness.gateResult.failed': 'Failed',
  'releaseReadiness.gateResult.pending': 'Pending',
  'releaseReadiness.gateResult.not_applicable': 'Not applicable',
  'releaseReadiness.execution': 'QA execution',
  'releaseReadiness.runs': 'Runs',
  'releaseReadiness.planned': 'Planned',
  'releaseReadiness.executed': 'Executed',
  'releaseReadiness.pending': 'Pending',
  'releaseReadiness.passed': 'Passed',
  'releaseReadiness.failed': 'Failed',
  'releaseReadiness.blocked': 'Blocked',
  'releaseReadiness.passRate': 'Pass rate',
  'releaseReadiness.failedRate': 'Failed rate',
  'releaseReadiness.blockedRate': 'Blocked rate',
  'releaseReadiness.progress': 'Progress',
  'releaseReadiness.sampleTooSmall': 'Fewer than {min} verdicts: rates are not shown.',
  'releaseReadiness.plansCycles': 'Test plans and cycles',
  'releaseReadiness.noPlansCycles': 'No test plan or cycle targets this release.',
  'releaseReadiness.kind': 'Type',
  'releaseReadiness.plan': 'Plan',
  'releaseReadiness.cycle': 'Cycle',
  'releaseReadiness.name': 'Name',
  'releaseReadiness.status': 'Status',
  'releaseReadiness.completion': 'Completion',
  'releaseReadiness.defects': 'Defects',
  'releaseReadiness.openDefects': 'Open',
  'releaseReadiness.reopened': 'Reopened',
  'releaseReadiness.requirements': 'Requirements coverage',
  'releaseReadiness.totalRequirements': 'Requirements',
  'releaseReadiness.covered': 'Covered',
  'releaseReadiness.uncovered': 'Without tests',
  'releaseReadiness.coveredNotExecuted': 'Covered, not executed',
  'releaseReadiness.failingRequirements': 'With failing tests',
  'releaseReadiness.coverage': 'Coverage',
  'releaseReadiness.flaky': 'Flaky tests',
  'releaseReadiness.flakyCount': 'Flaky',
  'releaseReadiness.suspect': 'Suspect',
  'releaseReadiness.failing': 'Failing',
  'releaseReadiness.confirmed': 'Confirmed',
  'releaseReadiness.dismissed': 'Dismissed',
  'releaseReadiness.exploratory': 'Exploratory testing',
  'releaseReadiness.sessions': 'Sessions',
  'releaseReadiness.incompleteSessions': 'Not finished',
  'releaseReadiness.findings': 'Findings',
  'releaseReadiness.openFindings': 'Bugs without defect',
  'releaseReadiness.convertedFindings': 'Linked to a defect',
} as const;
