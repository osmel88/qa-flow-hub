import { Injectable } from '@nestjs/common';
import {
  DEFECT_SEVERITIES,
  DefectSeverity,
  GATE_CRITICAL_SEVERITIES,
  GATE_HIGH_SEVERITIES,
  INCOMPLETE_SESSION_STATUSES,
  READINESS_MAX_FAILED_RATE,
  READINESS_MIN_VERDICTS,
  ReadinessFacts,
  ReadinessLink,
  ReadinessProgressRow,
  ReleaseReadinessView,
  TEST_RESULT_STATUSES,
  decideReadiness,
  executionKpis,
  sampledRates,
} from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../errors';
import { FlakyService } from '../flaky/flaky.service';
import { TestCyclesService } from '../test-plans/test-cycles.service';
import { TestPlansService } from '../test-plans/test-plans.service';
import { QualityGatesService } from './quality-gates.service';
import { ReleaseReadinessRepository } from './release-readiness.repository';
import { ReleasesRepository } from './releases.repository';
import { ReleasesService } from './releases.service';

const RISKY_FLAKY = ['flaky', 'suspect', 'failing'] as const;
const includes = (list: readonly string[], value: string) => list.includes(value);

/**
 * Release readiness report (S7-F8). It only composes the existing sources —
 * release summary and traceability, quality gates, plan/cycle progress, flaky
 * detection — and derives the decision with `decideReadiness()` on every read.
 */
@Injectable()
export class ReleaseReadinessService {
  constructor(
    private readonly releases: ReleasesService,
    private readonly releaseRows: ReleasesRepository,
    private readonly gates: QualityGatesService,
    private readonly plans: TestPlansService,
    private readonly cycles: TestCyclesService,
    private readonly flaky: FlakyService,
    private readonly readiness: ReleaseReadinessRepository,
    private readonly prisma: PrismaService,
  ) {}

  async get(releaseId: string): Promise<ReleaseReadinessView> {
    // 404 for another tenant or project, 403 when the project revokes the route permission.
    const release = await this.releases.get(releaseId);
    const summary = await this.releases.summary(releaseId);
    const trace = await this.releases.traceability(releaseId);
    const gates = await this.gates.evaluate(releaseId, {});
    const data = await this.prisma.runInTransaction(async (tx) => ({
      project: await this.readiness.project(release.projectId, tx),
      defects: await this.releaseRows.blockingDefects(releaseId, DEFECT_SEVERITIES, tx),
      cases: await this.releaseRows.caseStatuses(releaseId, tx),
      plans: await this.readiness.plans(release.projectId, releaseId, tx),
      cycles: await this.readiness.cycles(release.projectId, releaseId, tx),
      sessions: await this.readiness.sessions(release.projectId, releaseId, tx),
    }));
    if (data.project === null) {
      throw new NotFoundError('Release');
    }

    const plans: ReadinessProgressRow[] = [];
    for (const { id } of data.plans) {
      const progress = await this.plans.progress(id);
      plans.push({
        ...progress.plan,
        completion: progress.completion,
        passRate: progress.passRate,
      });
    }
    const cycles: ReadinessProgressRow[] = [];
    for (const { id } of data.cycles) {
      const progress = await this.cycles.progress(id);
      cycles.push({
        ...progress.cycle,
        completion: progress.completion,
        passRate: progress.passRate,
      });
    }

    const counts = Object.fromEntries(
      TEST_RESULT_STATUSES.map((status) => [status, summary.cases[status]]),
    ) as Record<(typeof TEST_RESULT_STATUSES)[number], number>;
    const kpis = executionKpis(counts);
    const rates = sampledRates(kpis);

    const defectLink = (d: { id: string; key: string; title: string }): ReadinessLink => ({
      kind: 'defect',
      id: d.id,
      label: `${d.key}: ${d.title}`,
    });
    const bySeverity = Object.fromEntries(DEFECT_SEVERITIES.map((s) => [s, 0])) as Record<
      DefectSeverity,
      number
    >;
    for (const defect of data.defects) bySeverity[defect.severity] += 1;
    const critical = data.defects
      .filter((d) => includes(GATE_CRITICAL_SEVERITIES, d.severity))
      .map(defectLink);
    const high = data.defects
      .filter((d) => includes(GATE_HIGH_SEVERITIES, d.severity))
      .map(defectLink);
    const reopened = data.defects.filter((d) => d.status === 'reopened').map(defectLink);

    const requirementLink = (row: { requirementId: string; key: string; title: string }) => ({
      kind: 'requirement' as const,
      id: row.requirementId,
      label: `${row.key}: ${row.title}`,
    });
    const covered = trace.rows.filter((row) => row.cases.length > 0);
    const uncovered = trace.rows.filter((row) => row.cases.length === 0).map(requirementLink);
    const notExecuted = covered
      .filter((row) => row.cases.every((c) => c.status === 'untested'))
      .map(requirementLink);
    const failing = covered
      .filter((row) => row.cases.some((c) => c.status === 'failed'))
      .map(requirementLink);

    const flakyViews = await this.flaky.views(
      release.projectId,
      data.cases.map((c) => c.testCaseId),
    );
    const risky = flakyViews
      .filter((v) => includes(RISKY_FLAKY, v.status))
      .map((v) => ({
        kind: 'test_case' as const,
        id: v.testCase.id,
        label: `${v.testCase.key}: ${v.testCase.title}`,
        status: v.status,
      }));

    const findings = data.sessions.flatMap((s) => s.findings);
    const incompleteSessions = data.sessions
      .filter((s) => includes(INCOMPLETE_SESSION_STATUSES, s.status))
      .map((s) => ({ kind: 'exploratory_session' as const, id: s.id, label: s.title }));
    const openFindings = findings
      .filter((f) => f.kind === 'bug' && f.defectId === null)
      .map((f) => ({ kind: 'exploratory_finding' as const, id: f.id, label: f.title }));

    const gateRows = gates.gates.map((e) => ({
      id: e.gate.id,
      name: e.gate.name,
      required: e.gate.required,
      result: e.result,
    }));

    const facts: ReadinessFacts = {
      gates: gateRows,
      execution: {
        verdicts: kpis.verdicts,
        pending: kpis.pending,
        failed: counts.failed,
        blocked: counts.blocked,
        failedRate: rates.failedRate,
      },
      defects: { critical, high, reopened },
      cycles,
      plans,
      requirements: { uncovered, notExecuted, failing },
      flaky: risky,
      exploratory: { incomplete: incompleteSessions, openFindings },
    };
    const outcome = decideReadiness(facts);
    const total = trace.rows.length;

    return {
      release: {
        id: release.id,
        name: release.name,
        version: release.version,
        status: release.status,
      },
      project: data.project,
      ...outcome,
      metrics: {
        qualityGates: {
          required: gates.required,
          gates: gateRows,
          failed: gateRows.filter((g) => g.result === 'failed').length,
          pending: gateRows.filter((g) => g.result === 'pending').length,
        },
        execution: {
          runs: summary.runs.map((r) => ({ id: r.id, name: r.name, status: r.status })),
          kpis,
          rates,
        },
        plans,
        cycles,
        defects: {
          open: data.defects.length,
          bySeverity,
          reopened: reopened.length,
          critical,
          high,
        },
        requirements: {
          total,
          covered: covered.length,
          uncovered: uncovered.length,
          coveredNotExecuted: notExecuted.length,
          failing: failing.length,
          coverage: total === 0 ? null : Math.round((covered.length / total) * 1000) / 10,
        },
        flaky: {
          flaky: flakyViews.filter((v) => v.status === 'flaky').length,
          suspect: flakyViews.filter((v) => v.status === 'suspect').length,
          failing: flakyViews.filter((v) => v.status === 'failing').length,
          confirmed: flakyViews.filter((v) => v.confirmed).length,
          dismissed: flakyViews.filter((v) => v.dismissed).length,
        },
        exploratory: {
          sessions: data.sessions.length,
          incomplete: incompleteSessions.length,
          findings: findings.length,
          openFindings: openFindings.length,
          convertedFindings: findings.filter((f) => f.defectId !== null).length,
        },
      },
      thresholds: { minVerdicts: READINESS_MIN_VERDICTS, maxFailedRate: READINESS_MAX_FAILED_RATE },
      computedAt: new Date().toISOString(),
    };
  }
}
