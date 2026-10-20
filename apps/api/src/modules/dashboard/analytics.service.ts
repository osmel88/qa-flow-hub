import { Injectable } from '@nestjs/common';
import {
  ACTIVITY_LIMIT,
  AnalyticsQuery,
  CLOSED_DEFECT_STATUSES,
  CRITICAL_DEFECT_SEVERITIES,
  DEFECT_SEVERITIES,
  DEFECT_STATUSES,
  DefectSeverity,
  DefectStatus,
  ExecutionCounts,
  MeanTimeToResolve,
  OrganizationDashboard,
  PRIORITIES,
  PriorityValue,
  ProjectCoverageView,
  ProjectDashboardSummary,
  ProjectDefectsView,
  ProjectHealthRow,
  ProjectRanking,
  ProjectTestResultsView,
  ProjectTrendsView,
  RANKING_LIMIT,
  RUN_ROWS_LIMIT,
  ResolvedPeriod,
  TrendPoint,
  UNCOVERED_ROWS_LIMIT,
  bucketStarts,
  compare,
  coverageKpis,
  emptyExecutionCounts,
  executionKpis,
  nextBucket,
  percentage,
  previousPeriod,
  resolveAnalyticsPeriod,
  toAnalyticsPeriod,
} from '@qa-flow-hub/shared';
import { NotFoundError } from '../../errors';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { AnalyticsRepository, DefectFlow, DefectGroup, TrendSeries } from './analytics.repository';

interface DefectSummary {
  open: number;
  closed: number;
  openCritical: number;
  bySeverity: Record<DefectSeverity, number>;
  byPriority: Record<PriorityValue, number>;
  byStatus: Record<DefectStatus, number>;
}

/**
 * Project and organization analytics (S2-F9). The service owns the formulas
 * (through the shared pure functions) and the authorization; the repository
 * owns the SQL. Every response is stamped with the window it covers and the
 * instant it was computed.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly analytics: AnalyticsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
  ) {}

  async summary(projectId: string, query: AnalyticsQuery): Promise<ProjectDashboardSummary> {
    const id = await this.authorizedProject(projectId);
    const period = resolveAnalyticsPeriod(query, new Date());
    const previous = previousPeriod(period);

    const data = await this.analytics.read(async (tx) => ({
      execution: await this.analytics.executionByProject(tx, [id], period),
      previousExecution: await this.analytics.executionByProject(tx, [id], previous),
      coverage: await this.analytics.coverageByProject(tx, [id], period.to),
      defects: await this.analytics.defectGroups(tx, [id]),
      flow: await this.analytics.defectFlow(tx, [id], period),
      previousFlow: await this.analytics.defectFlow(tx, [id], previous),
    }));

    const execution = executionKpis(data.execution.get(id) ?? emptyExecutionCounts());
    const previousExecution = executionKpis(
      data.previousExecution.get(id) ?? emptyExecutionCounts(),
    );
    const defects = summarizeDefects(data.defects);
    const coverage = data.coverage.get(id);

    return {
      ...this.envelope(period),
      projectId: id,
      execution,
      coverage: coverageKpis(coverage?.requirements ?? 0, coverage?.covered ?? 0),
      defects: {
        open: defects.open,
        openCritical: defects.openCritical,
        createdInPeriod: data.flow.created,
        closedInPeriod: data.flow.closed,
        perExecutedCase: ratio(data.flow.fromRunsInScope, execution.executed),
      },
      meanTimeToResolve: meanTimeToResolve(data.flow),
      comparison: {
        previousPeriod: { from: previous.from.toISOString(), to: previous.to.toISOString() },
        passRate: compare(execution.passRate, previousExecution.passRate),
        defectsCreated: compare(data.flow.created, data.previousFlow.created),
      },
    };
  }

  async testResults(projectId: string, query: AnalyticsQuery): Promise<ProjectTestResultsView> {
    const id = await this.authorizedProject(projectId);
    const period = resolveAnalyticsPeriod(query, new Date());

    const data = await this.analytics.read(async (tx) => ({
      execution: await this.analytics.executionByProject(tx, [id], period),
      runs: await this.analytics.executionByRun(tx, id, period, RUN_ROWS_LIMIT),
      milestones: await this.analytics.executionByMilestone(tx, id, period),
      releases: await this.analytics.executionByRelease(tx, id, period),
    }));

    return {
      ...this.envelope(period),
      projectId: id,
      execution: executionKpis(data.execution.get(id) ?? emptyExecutionCounts()),
      runs: data.runs.map((run) => {
        const execution = executionKpis(run.counts);
        return {
          id: run.id,
          name: run.name,
          milestone: run.milestone,
          releaseId: run.releaseId,
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          execution,
          defects: run.defects,
          defectsPerExecutedCase: ratio(run.defects, execution.executed),
        };
      }),
      milestones: data.milestones.map((row) => ({
        milestone: row.milestone,
        runs: row.runs,
        execution: executionKpis(row.counts),
      })),
      releases: data.releases.map((row) => ({
        releaseId: row.releaseId,
        version: row.version,
        name: row.name,
        runs: row.runs,
        execution: executionKpis(row.counts),
      })),
    };
  }

  async coverage(projectId: string, query: AnalyticsQuery): Promise<ProjectCoverageView> {
    const id = await this.authorizedProject(projectId);
    const period = resolveAnalyticsPeriod(query, new Date());

    const data = await this.analytics.read(async (tx) => ({
      total: await this.analytics.coverageByProject(tx, [id], period.to),
      byPriority: await this.analytics.coverageByPriority(tx, id, period.to),
      uncovered: await this.analytics.uncoveredRequirements(
        tx,
        id,
        period.to,
        UNCOVERED_ROWS_LIMIT,
      ),
    }));
    const total = data.total.get(id);

    return {
      ...this.envelope(period),
      projectId: id,
      coverage: coverageKpis(total?.requirements ?? 0, total?.covered ?? 0),
      byPriority: PRIORITIES.map((priority) => {
        const row = data.byPriority.get(priority);
        return { priority, ...coverageKpis(row?.requirements ?? 0, row?.covered ?? 0) };
      }),
      uncoveredRequirements: data.uncovered.flatMap((row) =>
        isPriority(row.priority) ? [{ ...row, priority: row.priority }] : [],
      ),
    };
  }

  async defects(projectId: string, query: AnalyticsQuery): Promise<ProjectDefectsView> {
    const id = await this.authorizedProject(projectId);
    const period = resolveAnalyticsPeriod(query, new Date());

    const data = await this.analytics.read(async (tx) => ({
      groups: await this.analytics.defectGroups(tx, [id]),
      flow: await this.analytics.defectFlow(tx, [id], period),
      execution: await this.analytics.executionByProject(tx, [id], period),
    }));
    const summary = summarizeDefects(data.groups);
    const executed = executionKpis(data.execution.get(id) ?? emptyExecutionCounts()).executed;

    return {
      ...this.envelope(period),
      projectId: id,
      ...summary,
      createdInPeriod: data.flow.created,
      closedInPeriod: data.flow.closed,
      perExecutedCase: ratio(data.flow.fromRunsInScope, executed),
      meanTimeToResolve: meanTimeToResolve(data.flow),
    };
  }

  async trends(projectId: string, query: AnalyticsQuery): Promise<ProjectTrendsView> {
    const id = await this.authorizedProject(projectId);
    const period = resolveAnalyticsPeriod(query, new Date());
    const series = await this.analytics.read((tx) => this.analytics.trends(tx, [id], period));

    return { ...this.envelope(period), projectId: id, points: trendPoints(period, series) };
  }

  /**
   * Every active project the caller may read analytics for — a project where
   * `analytics.read` was revoked contributes nothing, not even to the totals.
   */
  async organization(query: AnalyticsQuery): Promise<OrganizationDashboard> {
    const period = resolveAnalyticsPeriod(query, new Date());
    const all = await this.analytics.activeProjects();
    const allowed = new Set(
      await this.access.projectsAllowing(
        'analytics.read',
        all.map((project) => project.id),
      ),
    );
    const projects = all.filter((project) => allowed.has(project.id));
    const ids = projects.map((project) => project.id);

    const data = await this.analytics.read(async (tx) => ({
      execution: await this.analytics.executionByProject(tx, ids, period),
      coverage: await this.analytics.coverageByProject(tx, ids, period.to),
      defects: await this.analytics.defectGroups(tx, ids),
      trends: await this.analytics.trends(tx, ids, period),
      activity: await this.analytics.recentActivity(tx, ids, period, ACTIVITY_LIMIT),
    }));

    const rows: ProjectHealthRow[] = projects.map((project) => {
      const defects = summarizeDefects(
        data.defects.filter((group) => group.projectId === project.id),
      );
      const coverage = data.coverage.get(project.id);
      return {
        projectId: project.id,
        key: project.key,
        name: project.name,
        execution: executionKpis(data.execution.get(project.id) ?? emptyExecutionCounts()),
        coverage: coverageKpis(coverage?.requirements ?? 0, coverage?.covered ?? 0),
        openDefects: defects.open,
        openCritical: defects.openCritical,
      };
    });

    const totals = emptyExecutionCounts();
    for (const counts of data.execution.values()) {
      addCounts(totals, counts);
    }
    const organizationDefects = summarizeDefects(data.defects);
    const requirements = rows.reduce((sum, row) => sum + row.coverage.requirements, 0);
    const covered = rows.reduce((sum, row) => sum + row.coverage.covered, 0);
    const keys = new Map(projects.map((project) => [project.id, project.key]));

    return {
      ...this.envelope(period),
      health: {
        projects: projects.length,
        execution: executionKpis(totals),
        coverage: coverageKpis(requirements, covered),
        openDefects: organizationDefects.open,
        openCritical: organizationDefects.openCritical,
      },
      projects: rows,
      mostFailures: rank(
        rows.filter((row) => row.execution.counts.failed > 0),
        (row) => row.execution.counts.failed,
        'desc',
      ),
      leastCoverage: rank(
        rows.filter((row) => row.coverage.percentage !== null),
        (row) => row.coverage.percentage ?? 0,
        'asc',
      ),
      trends: trendPoints(period, data.trends),
      recentActivity: data.activity.map((item) => ({
        kind: item.kind,
        id: item.id,
        at: item.at.toISOString(),
        projectId: item.projectId,
        projectKey: keys.get(item.projectId) ?? '',
        label: item.label,
        status: item.status,
      })),
    };
  }

  /** 404 for a project outside the organization, then the route's permission check. */
  private async authorizedProject(projectId: string): Promise<string> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    return project.id;
  }

  private envelope(period: ResolvedPeriod): {
    period: ReturnType<typeof toAnalyticsPeriod>;
    computedAt: string;
  } {
    return { period: toAnalyticsPeriod(period), computedAt: new Date().toISOString() };
  }
}

function summarizeDefects(groups: readonly DefectGroup[]): DefectSummary {
  const summary: DefectSummary = {
    open: 0,
    closed: 0,
    openCritical: 0,
    bySeverity: zeroRecord(DEFECT_SEVERITIES),
    byPriority: zeroRecord(PRIORITIES),
    byStatus: zeroRecord(DEFECT_STATUSES),
  };
  const closed: readonly string[] = CLOSED_DEFECT_STATUSES;
  const critical: readonly string[] = CRITICAL_DEFECT_SEVERITIES;

  for (const group of groups) {
    if (isDefectStatus(group.status)) {
      summary.byStatus[group.status] += group.count;
    }
    if (closed.includes(group.status)) {
      summary.closed += group.count;
      continue;
    }
    summary.open += group.count;
    if (critical.includes(group.severity)) {
      summary.openCritical += group.count;
    }
    if (isSeverity(group.severity)) {
      summary.bySeverity[group.severity] += group.count;
    }
    if (isPriority(group.priority)) {
      summary.byPriority[group.priority] += group.count;
    }
  }
  return summary;
}

/**
 * Turns per-bucket increments into points. Open defects and coverage are
 * running totals from the state before the window; pass rate is per bucket.
 */
function trendPoints(period: ResolvedPeriod, series: TrendSeries): TrendPoint[] {
  const byBucket = <T extends { bucket: Date }>(rows: readonly T[]): Map<number, T> =>
    new Map(rows.map((row) => [row.bucket.getTime(), row]));
  const results = byBucket(series.results);
  const created = byBucket(series.defectsCreated);
  const closed = byBucket(series.defectsClosed);
  const added = byBucket(series.requirementsAdded);
  const covered = byBucket(series.requirementsCovered);

  let defectsOpen = series.baseline.defectsOpen;
  let requirements = series.baseline.requirements;
  let coveredRequirements = series.baseline.covered;

  return bucketStarts(period).map((start) => {
    const key = start.getTime();
    const end = new Date(Math.min(nextBucket(start, period.bucket).getTime(), period.to.getTime()));
    const bucketResults = results.get(key);
    const defectsCreated = created.get(key)?.count ?? 0;
    const defectsClosed = closed.get(key)?.count ?? 0;
    defectsOpen += defectsCreated - defectsClosed;
    requirements += added.get(key)?.count ?? 0;
    coveredRequirements += covered.get(key)?.count ?? 0;

    return {
      bucketStart: start.toISOString(),
      bucketEnd: end.toISOString(),
      results: bucketResults?.results ?? 0,
      passRate:
        bucketResults === undefined
          ? null
          : percentage(
              bucketResults.passed,
              bucketResults.passed + bucketResults.failed + bucketResults.blocked,
            ),
      coverage: percentage(coveredRequirements, requirements),
      defectsCreated,
      defectsClosed,
      defectsOpen,
    };
  });
}

function rank(
  rows: readonly ProjectHealthRow[],
  value: (row: ProjectHealthRow) => number,
  order: 'asc' | 'desc',
): ProjectRanking[] {
  return [...rows]
    .sort((a, b) => {
      const difference = order === 'asc' ? value(a) - value(b) : value(b) - value(a);
      return difference !== 0 ? difference : a.key.localeCompare(b.key);
    })
    .slice(0, RANKING_LIMIT)
    .map((row) => ({ projectId: row.projectId, key: row.key, name: row.name, value: value(row) }));
}

function meanTimeToResolve(flow: DefectFlow): MeanTimeToResolve {
  return {
    hours: flow.meanHoursToResolve === null ? null : Math.round(flow.meanHoursToResolve * 10) / 10,
    sampleSize: flow.resolvedSample,
  };
}

/** Two-decimal ratio, or null when the denominator is zero. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 100) / 100;
}

function addCounts(target: ExecutionCounts, source: ExecutionCounts): void {
  target.untested += source.untested;
  target.passed += source.passed;
  target.failed += source.failed;
  target.blocked += source.blocked;
  target.skipped += source.skipped;
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function isDefectStatus(value: string): value is DefectStatus {
  return (DEFECT_STATUSES as readonly string[]).includes(value);
}

function isSeverity(value: string): value is DefectSeverity {
  return (DEFECT_SEVERITIES as readonly string[]).includes(value);
}

function isPriority(value: string): value is PriorityValue {
  return (PRIORITIES as readonly string[]).includes(value);
}
