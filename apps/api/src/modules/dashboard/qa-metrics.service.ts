import { Injectable } from '@nestjs/common';
import {
  DEFECT_SEVERITIES,
  DefectSeverity,
  FLAKY_STATUSES,
  FlakyStatus,
  QA_METRICS_LIST_LIMIT,
  QaMetricsFlakyPoint,
  QaMetricsProgressRow,
  QaMetricsQuery,
  QaMetricsTrendPoint,
  QaMetricsView,
  ResolvedPeriod,
  analyzeFlakiness,
  bucketStarts,
  defectDensity,
  executionKpis,
  nextBucket,
  percentage,
  resolveAnalyticsPeriod,
  sampledRates,
  toAnalyticsPeriod,
} from '@qa-flow-hub/shared';
import { NotFoundError } from '../../errors';
import { FlakyService } from '../flaky/flaky.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TestCyclesService } from '../test-plans/test-cycles.service';
import { TestPlansService } from '../test-plans/test-plans.service';
import {
  EvolutionSample,
  ProgressRef,
  QaMetricsRepository,
  QaScope,
  ResultBucket,
} from './qa-metrics.repository';

/**
 * QA metrics dashboard (S7-F7). Nothing is stored: execution comes from the
 * analytics formulas, plan and cycle progress from their own services, flaky
 * counts from the S7-F6 service, and the rest from aggregate SQL. Each KPI is
 * documented in docs/stage-7-roadmap.md § S7-F7.
 */
@Injectable()
export class QaMetricsService {
  constructor(
    private readonly metrics: QaMetricsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly plans: TestPlansService,
    private readonly cycles: TestCyclesService,
    private readonly flaky: FlakyService,
  ) {}

  async get(projectId: string, query: QaMetricsQuery): Promise<QaMetricsView> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    const period = resolveAnalyticsPeriod(query, new Date());
    const scope = await this.resolveScope(project.id, period, query);
    const filtered =
      scope.testPlanId !== null ||
      scope.testCycleId !== null ||
      scope.releaseId !== null ||
      scope.environment !== null;

    const data = await this.metrics.read(async (tx) => ({
      runs: await this.metrics.runCount(tx, scope),
      execution: await this.metrics.execution(tx, scope),
      buckets: await this.metrics.resultBuckets(tx, scope),
      openDefects: await this.metrics.openDefects(tx, scope, filtered),
      raised: await this.metrics.defectsRaised(tx, scope),
      sessions: await this.metrics.sessionGroups(tx, scope),
      findings: await this.metrics.findingGroups(tx, scope),
      evolution: await this.metrics.evolutionSamples(tx, scope),
    }));
    const [planRefs, cycleRefs, flakyCounts] = await Promise.all([
      this.metrics.plans(scope, QA_METRICS_LIST_LIMIT),
      this.metrics.cycles(scope, QA_METRICS_LIST_LIMIT),
      this.flaky.statusCounts(project.id),
    ]);
    const plans = await Promise.all(
      planRefs.map(async (ref) => progressRow(ref, await this.plans.progress(ref.id))),
    );
    const cycles = await Promise.all(
      cycleRefs.map(async (ref) => progressRow(ref, await this.cycles.progress(ref.id))),
    );

    const execution = executionKpis(data.execution);
    const openBySeverity = zero(DEFECT_SEVERITIES);
    for (const row of data.openDefects) {
      if ((DEFECT_SEVERITIES as readonly string[]).includes(row.severity)) {
        openBySeverity[row.severity as DefectSeverity] += row.count;
      }
    }
    const density = defectDensity(data.raised, execution.executed);

    const byStatus: Record<string, number> = {};
    let sessions = 0;
    let activeSeconds = 0;
    for (const row of data.sessions) {
      byStatus[row.status] = row.count;
      sessions += row.count;
      activeSeconds += row.seconds;
    }
    const findingsByKind: Record<string, number> = {};
    const findingsBySeverity = zero(DEFECT_SEVERITIES);
    let findings = 0;
    let defectsCreated = 0;
    for (const row of data.findings) {
      findingsByKind[row.kind] = (findingsByKind[row.kind] ?? 0) + row.count;
      if ((DEFECT_SEVERITIES as readonly string[]).includes(row.severity)) {
        findingsBySeverity[row.severity as DefectSeverity] += row.count;
      }
      findings += row.count;
      defectsCreated += row.created;
    }

    return {
      period: toAnalyticsPeriod(period),
      computedAt: new Date().toISOString(),
      projectId: project.id,
      filters: {
        testPlanId: scope.testPlanId,
        testCycleId: scope.testCycleId,
        releaseId: scope.releaseId,
        environmentId: scope.environment?.id ?? null,
      },
      runs: data.runs,
      execution,
      rates: sampledRates(execution),
      trend: trend(period, data.buckets),
      plans,
      cycles,
      defects: {
        open: Object.values(openBySeverity).reduce((sum, count) => sum + count, 0),
        openBySeverity,
        raisedInPeriod: data.raised,
        density,
        densityInsufficientData: density === null && execution.executed > 0,
      },
      flaky: { counts: flakyCounts, evolution: evolution(period, data.evolution) },
      exploratory: {
        sessions,
        byStatus,
        activeSeconds,
        findings,
        findingsByKind,
        findingsBySeverity,
        defectsCreated,
      },
    };
  }

  /** Every filter must name a resource of this project; anything else is a 404. */
  private async resolveScope(
    projectId: string,
    period: ResolvedPeriod,
    query: QaMetricsQuery,
  ): Promise<QaScope> {
    const [plan, cycle, release, environment] = await Promise.all([
      query.testPlanId === undefined ? null : this.metrics.findPlan(projectId, query.testPlanId),
      query.testCycleId === undefined ? null : this.metrics.findCycle(projectId, query.testCycleId),
      query.releaseId === undefined ? null : this.metrics.findRelease(projectId, query.releaseId),
      query.environmentId === undefined
        ? null
        : this.metrics.findEnvironment(projectId, query.environmentId),
    ]);
    if (query.testPlanId !== undefined && plan === null) throw new NotFoundError('Test plan');
    if (query.testCycleId !== undefined && cycle === null) throw new NotFoundError('Test cycle');
    if (query.releaseId !== undefined && release === null) throw new NotFoundError('Release');
    if (query.environmentId !== undefined && environment === null) {
      throw new NotFoundError('Environment');
    }
    return {
      projectId,
      period,
      testPlanId: plan?.id ?? null,
      testCycleId: cycle?.id ?? null,
      releaseId: release?.id ?? null,
      environment,
    };
  }
}

function progressRow(
  ref: ProgressRef,
  progress: {
    counts: { total: number; executed: number; passed: number; failed: number; blocked: number };
    completion: number;
    passRate: number | null;
  },
): QaMetricsProgressRow {
  const { counts } = progress;
  return {
    id: ref.id,
    name: ref.name,
    status: ref.status,
    testPlanId: ref.testPlanId,
    total: counts.total,
    executed: counts.executed,
    passed: counts.passed,
    failed: counts.failed,
    blocked: counts.blocked,
    completion: counts.total === 0 ? null : progress.completion,
    passRate: progress.passRate,
  };
}

function bucketEnd(start: Date, period: ResolvedPeriod): Date {
  return new Date(Math.min(nextBucket(start, period.bucket).getTime(), period.to.getTime()));
}

function trend(period: ResolvedPeriod, rows: readonly ResultBucket[]): QaMetricsTrendPoint[] {
  const byBucket = new Map(rows.map((row) => [new Date(row.bucket).getTime(), row]));
  return bucketStarts(period).map((start) => {
    const row = byBucket.get(start.getTime());
    const passed = row?.passed ?? 0;
    const failed = row?.failed ?? 0;
    const blocked = row?.blocked ?? 0;
    return {
      bucketStart: start.toISOString(),
      bucketEnd: bucketEnd(start, period).toISOString(),
      passed,
      failed,
      blocked,
      passRate: percentage(passed, passed + failed + blocked),
    };
  });
}

/** Detected status of every case at the end of each bucket (no manual marks). */
function evolution(
  period: ResolvedPeriod,
  samples: readonly EvolutionSample[],
): QaMetricsFlakyPoint[] {
  const byCase = new Map<string, EvolutionSample[]>();
  for (const sample of samples) {
    byCase.set(sample.testCaseId, [...(byCase.get(sample.testCaseId) ?? []), sample]);
  }
  return bucketStarts(period).map((start) => {
    const end = bucketEnd(start, period);
    const counts: Record<FlakyStatus, number> = zero(FLAKY_STATUSES);
    for (const caseSamples of byCase.values()) {
      const before = caseSamples.filter((sample) => sample.executedAt.getTime() < end.getTime());
      if (before.length > 0) {
        counts[analyzeFlakiness(before).status] += 1;
      }
    }
    return {
      bucketStart: start.toISOString(),
      bucketEnd: end.toISOString(),
      flaky: counts.flaky,
      suspect: counts.suspect,
      failing: counts.failing,
    };
  });
}

function zero<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}
