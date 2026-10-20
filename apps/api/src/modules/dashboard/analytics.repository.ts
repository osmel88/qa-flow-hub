import { Injectable } from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import {
  ACTIVITY_KINDS,
  ActivityKind,
  AnalyticsBucket,
  ExecutionCounts,
  ResolvedPeriod,
  TEST_RESULT_STATUSES,
  TestResultStatus,
  emptyExecutionCounts,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface ProjectRef {
  id: string;
  key: string;
  name: string;
}

export interface CoverageCounts {
  requirements: number;
  covered: number;
}

export interface DefectGroup {
  projectId: string;
  status: string;
  severity: string;
  priority: string;
  count: number;
}

export interface DefectFlow {
  created: number;
  closed: number;
  resolvedSample: number;
  meanHoursToResolve: number | null;
  fromRunsInScope: number;
}

export interface RunExecution {
  id: string;
  name: string;
  milestone: string | null;
  releaseId: string | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  counts: ExecutionCounts;
  defects: number;
}

export interface ReleaseExecution {
  releaseId: string | null;
  version: string | null;
  name: string | null;
  runs: number;
  counts: ExecutionCounts;
}

export interface MilestoneExecution {
  milestone: string | null;
  runs: number;
  counts: ExecutionCounts;
}

export interface UncoveredRequirement {
  id: string;
  key: string;
  title: string;
  priority: string;
  status: string;
}

export interface BucketedResults {
  bucket: Date;
  results: number;
  passed: number;
  failed: number;
  blocked: number;
}

export interface BucketedCount {
  bucket: Date;
  count: number;
}

export interface TrendSeries {
  results: BucketedResults[];
  defectsCreated: BucketedCount[];
  defectsClosed: BucketedCount[];
  requirementsAdded: BucketedCount[];
  requirementsCovered: BucketedCount[];
  baseline: { defectsOpen: number; requirements: number; covered: number };
}

export interface ActivityRow {
  kind: ActivityKind;
  id: string;
  at: Date;
  projectId: string;
  label: string;
  status: string;
}

/**
 * Aggregate SQL for the analytics dashboards (S2-F9).
 *
 * Each method returns grouped numbers, never business rows: the only rows that
 * leave the database are the bounded detail lists the contract declares (runs,
 * uncovered requirements, recent activity), each with a hard `LIMIT`.
 *
 * Isolation is layered as everywhere else, but spelled out because these are
 * raw statements the RLS extension does not wrap:
 *
 *   1. every table in every statement is filtered by `organizationId`;
 *   2. every statement runs inside `read()`, a transaction that sets
 *      `app.current_organization`, so the policies apply under the runtime
 *      role exactly as they do for model queries;
 *   3. the project filter is an explicit `projectId = ANY(...)` list the
 *      service has already authorized.
 *
 * "Runs in scope" for a window `[from, to)` are the non-deleted, non-aborted
 * runs created before `to` and not completed before `from` — the runs that were
 * alive at some point during the window.
 */
@Injectable()
export class AnalyticsRepository extends TenantAwareRepository {
  constructor(
    private readonly database: PrismaService,
    tenant: TenantContextService,
  ) {
    super(database, tenant);
  }

  /** Runs `work` in one tenant-announcing transaction. */
  read<T>(work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.database.runInTransaction(work, { timeoutMs: 20_000 });
  }

  /** Active projects of the organization, optionally narrowed to some ids. */
  activeProjects(ids?: readonly string[]): Promise<ProjectRef[]> {
    return this.prisma.project.findMany({
      where: this.active({
        status: ProjectStatus.active,
        ...(ids === undefined ? {} : { id: { in: [...ids] } }),
      }),
      select: { id: true, key: true, name: true },
      orderBy: { key: 'asc' },
    });
  }

  private runsInScope(projectIds: readonly string[], period: ResolvedPeriod): Prisma.Sql {
    return Prisma.sql`
      r."organizationId" = ${this.organizationId}
      AND r."projectId" = ANY(${[...projectIds]}::text[])
      AND r."deletedAt" IS NULL
      AND r.status <> 'aborted'
      AND r."createdAt" < ${period.to}
      AND (r."completedAt" IS NULL OR r."completedAt" >= ${period.from})`;
  }

  /** Latest status of every run case in scope, per project. */
  async executionByProject(
    tx: PrismaTransaction,
    projectIds: readonly string[],
    period: ResolvedPeriod,
  ): Promise<Map<string, ExecutionCounts>> {
    const rows = await tx.$queryRaw<Array<{ projectId: string; status: string; count: number }>>`
      SELECT r."projectId" AS "projectId", c."latestStatus"::text AS status, COUNT(*)::int AS count
      FROM test_run_cases c
      JOIN test_runs r ON r.id = c."testRunId"
      WHERE c."organizationId" = ${this.organizationId} AND ${this.runsInScope(projectIds, period)}
      GROUP BY 1, 2`;

    const byProject = new Map<string, ExecutionCounts>();
    for (const row of rows) {
      const counts = byProject.get(row.projectId) ?? emptyExecutionCounts();
      if (isResultStatus(row.status)) {
        counts[row.status] += row.count;
      }
      byProject.set(row.projectId, counts);
    }
    return byProject;
  }

  /** Runs in scope with their status breakdown and defects, newest first. */
  async executionByRun(
    tx: PrismaTransaction,
    projectId: string,
    period: ResolvedPeriod,
    limit: number,
  ): Promise<RunExecution[]> {
    const rows = await tx.$queryRaw<
      Array<
        {
          id: string;
          name: string;
          milestone: string | null;
          releaseId: string | null;
          status: string;
          createdAt: Date;
          completedAt: Date | null;
          defects: number;
        } & ExecutionCounts
      >
    >`
      SELECT r.id, r.name, r.milestone, r."releaseId", r.status::text AS status,
        r."createdAt" AS "createdAt", r."completedAt" AS "completedAt",
        ${statusColumns()},
        COALESCE(MAX(d.count), 0)::int AS defects
      FROM test_runs r
      LEFT JOIN test_run_cases c
        ON c."testRunId" = r.id AND c."organizationId" = ${this.organizationId}
      LEFT JOIN (
        SELECT "testRunId", COUNT(*)::int AS count FROM defects
        WHERE "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
          AND "testRunId" IS NOT NULL
        GROUP BY 1
      ) d ON d."testRunId" = r.id
      WHERE ${this.runsInScope([projectId], period)}
      GROUP BY r.id
      ORDER BY r."createdAt" DESC, r.id
      LIMIT ${limit}`;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      milestone: row.milestone,
      releaseId: row.releaseId,
      status: row.status,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      counts: pickCounts(row),
      defects: row.defects,
    }));
  }

  /** Runs in scope grouped by release entity, runs without one last. */
  async executionByRelease(
    tx: PrismaTransaction,
    projectId: string,
    period: ResolvedPeriod,
  ): Promise<ReleaseExecution[]> {
    const rows = await tx.$queryRaw<
      Array<
        {
          releaseId: string | null;
          version: string | null;
          name: string | null;
          runs: number;
        } & ExecutionCounts
      >
    >`
      SELECT r."releaseId", rel.version, rel.name, COUNT(DISTINCT r.id)::int AS runs, ${statusColumns()}
      FROM test_runs r
      LEFT JOIN releases rel
        ON rel.id = r."releaseId" AND rel."organizationId" = ${this.organizationId}
      LEFT JOIN test_run_cases c
        ON c."testRunId" = r.id AND c."organizationId" = ${this.organizationId}
      WHERE ${this.runsInScope([projectId], period)}
      GROUP BY r."releaseId", rel.version, rel.name, rel."createdAt"
      ORDER BY rel."createdAt" DESC NULLS LAST`;

    return rows.map((row) => ({
      releaseId: row.releaseId,
      version: row.version,
      name: row.name,
      runs: row.runs,
      counts: pickCounts(row),
    }));
  }

  /** Runs in scope grouped by free-text milestone, runs without one last. */
  async executionByMilestone(
    tx: PrismaTransaction,
    projectId: string,
    period: ResolvedPeriod,
  ): Promise<MilestoneExecution[]> {
    const rows = await tx.$queryRaw<
      Array<{ milestone: string | null; runs: number } & ExecutionCounts>
    >`
      SELECT r.milestone, COUNT(DISTINCT r.id)::int AS runs, ${statusColumns()}
      FROM test_runs r
      LEFT JOIN test_run_cases c
        ON c."testRunId" = r.id AND c."organizationId" = ${this.organizationId}
      WHERE ${this.runsInScope([projectId], period)}
      GROUP BY r.milestone
      ORDER BY r.milestone ASC NULLS LAST`;

    return rows.map((row) => ({
      milestone: row.milestone,
      runs: row.runs,
      counts: pickCounts(row),
    }));
  }

  private coveredExpression(at: Date): Prisma.Sql {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM traceability_links l
      WHERE l."organizationId" = ${this.organizationId}
        AND l."sourceType" = 'requirement' AND l."targetType" = 'test_case'
        AND l."sourceId" = q.id AND l."createdAt" < ${at}
        AND EXISTS (
          SELECT 1 FROM test_cases t
          WHERE t.id = l."targetId" AND t."organizationId" = ${this.organizationId}
            AND t."projectId" = q."projectId"
            AND t."deletedAt" IS NULL AND t."archivedAt" IS NULL))`;
  }

  private requirementsInScope(projectIds: readonly string[], at: Date): Prisma.Sql {
    return Prisma.sql`
      q."organizationId" = ${this.organizationId}
      AND q."projectId" = ANY(${[...projectIds]}::text[])
      AND q."deletedAt" IS NULL
      AND q.status <> 'obsolete'
      AND q."createdAt" < ${at}`;
  }

  /** Requirements and covered requirements as of `at`, per project. */
  async coverageByProject(
    tx: PrismaTransaction,
    projectIds: readonly string[],
    at: Date,
  ): Promise<Map<string, CoverageCounts>> {
    const rows = await tx.$queryRaw<
      Array<{ projectId: string; requirements: number; covered: number }>
    >`
      SELECT q."projectId" AS "projectId", COUNT(*)::int AS requirements,
        (COUNT(*) FILTER (WHERE ${this.coveredExpression(at)}))::int AS covered
      FROM requirements q
      WHERE ${this.requirementsInScope(projectIds, at)}
      GROUP BY 1`;
    return new Map(
      rows.map((row) => [row.projectId, { requirements: row.requirements, covered: row.covered }]),
    );
  }

  async coverageByPriority(
    tx: PrismaTransaction,
    projectId: string,
    at: Date,
  ): Promise<Map<string, CoverageCounts>> {
    const rows = await tx.$queryRaw<
      Array<{ priority: string; requirements: number; covered: number }>
    >`
      SELECT q.priority::text AS priority, COUNT(*)::int AS requirements,
        (COUNT(*) FILTER (WHERE ${this.coveredExpression(at)}))::int AS covered
      FROM requirements q
      WHERE ${this.requirementsInScope([projectId], at)}
      GROUP BY 1`;
    return new Map(
      rows.map((row) => [row.priority, { requirements: row.requirements, covered: row.covered }]),
    );
  }

  /** Uncovered requirements as of `at`, highest priority first. */
  uncoveredRequirements(
    tx: PrismaTransaction,
    projectId: string,
    at: Date,
    limit: number,
  ): Promise<UncoveredRequirement[]> {
    // `Priority` is declared critical → low, so enum order is priority order.
    return tx.$queryRaw<UncoveredRequirement[]>`
      SELECT q.id, q.key, q.title, q.priority::text AS priority, q.status::text AS status
      FROM requirements q
      WHERE ${this.requirementsInScope([projectId], at)} AND NOT ${this.coveredExpression(at)}
      ORDER BY q.priority ASC, q."createdAt" ASC, q.id
      LIMIT ${limit}`;
  }

  /** Current defects grouped by every dimension the dashboard slices on. */
  defectGroups(tx: PrismaTransaction, projectIds: readonly string[]): Promise<DefectGroup[]> {
    return tx.$queryRaw<DefectGroup[]>`
      SELECT d."projectId" AS "projectId", d.status::text AS status,
        d.severity::text AS severity, d.priority::text AS priority, COUNT(*)::int AS count
      FROM defects d
      WHERE d."organizationId" = ${this.organizationId}
        AND d."projectId" = ANY(${[...projectIds]}::text[])
        AND d."deletedAt" IS NULL
      GROUP BY 1, 2, 3, 4`;
  }

  /** Defects created, closed and resolved during the window, and time to resolve. */
  async defectFlow(
    tx: PrismaTransaction,
    projectIds: readonly string[],
    period: ResolvedPeriod,
  ): Promise<DefectFlow> {
    const resolvedInWindow = Prisma.sql`d.status <> 'rejected'
      AND COALESCE(d."resolvedAt", d."closedAt") >= ${period.from}
      AND COALESCE(d."resolvedAt", d."closedAt") < ${period.to}`;
    const rows = await tx.$queryRaw<
      Array<{
        created: number;
        closed: number;
        resolvedSample: number;
        meanHoursToResolve: number | null;
        fromRunsInScope: number;
      }>
    >`
      SELECT
        (COUNT(*) FILTER (WHERE d."createdAt" >= ${period.from} AND d."createdAt" < ${period.to}))::int AS created,
        (COUNT(*) FILTER (WHERE d."closedAt" >= ${period.from} AND d."closedAt" < ${period.to}))::int AS closed,
        (COUNT(*) FILTER (WHERE ${resolvedInWindow}))::int AS "resolvedSample",
        (AVG(EXTRACT(EPOCH FROM (COALESCE(d."resolvedAt", d."closedAt") - d."createdAt")) / 3600)
          FILTER (WHERE ${resolvedInWindow}))::float8 AS "meanHoursToResolve",
        (COUNT(*) FILTER (WHERE d."testRunId" IN (
          SELECT r.id FROM test_runs r WHERE ${this.runsInScope(projectIds, period)}
        )))::int AS "fromRunsInScope"
      FROM defects d
      WHERE d."organizationId" = ${this.organizationId}
        AND d."projectId" = ANY(${[...projectIds]}::text[])
        AND d."deletedAt" IS NULL`;
    const row = rows[0];
    return {
      created: row?.created ?? 0,
      closed: row?.closed ?? 0,
      resolvedSample: row?.resolvedSample ?? 0,
      meanHoursToResolve: row?.meanHoursToResolve ?? null,
      fromRunsInScope: row?.fromRunsInScope ?? 0,
    };
  }

  /**
   * Per-bucket increments plus the state before the window; the service turns
   * them into running totals. Six grouped statements regardless of the number
   * of buckets or projects.
   */
  async trends(
    tx: PrismaTransaction,
    projectIds: readonly string[],
    period: ResolvedPeriod,
  ): Promise<TrendSeries> {
    const ids = [...projectIds];
    const org = this.organizationId;
    const bucket = period.bucket;
    const inWindow = (column: Prisma.Sql): Prisma.Sql =>
      Prisma.sql`${column} >= ${period.from} AND ${column} < ${period.to}`;

    const results = await tx.$queryRaw<BucketedResults[]>`
      SELECT ${truncate(bucket, Prisma.sql`t."executedAt"`)} AS bucket,
        COUNT(*)::int AS results,
        (COUNT(*) FILTER (WHERE t.status = 'passed'))::int AS passed,
        (COUNT(*) FILTER (WHERE t.status = 'failed'))::int AS failed,
        (COUNT(*) FILTER (WHERE t.status = 'blocked'))::int AS blocked
      FROM test_results t
      JOIN test_runs r ON r.id = t."testRunId"
      WHERE t."organizationId" = ${org} AND r."organizationId" = ${org}
        AND r."projectId" = ANY(${ids}::text[]) AND r."deletedAt" IS NULL
        AND ${inWindow(Prisma.sql`t."executedAt"`)}
      GROUP BY 1`;

    const defectsIn = Prisma.sql`d."organizationId" = ${org}
      AND d."projectId" = ANY(${ids}::text[]) AND d."deletedAt" IS NULL`;
    const defectsCreated = await tx.$queryRaw<BucketedCount[]>`
      SELECT ${truncate(bucket, Prisma.sql`d."createdAt"`)} AS bucket, COUNT(*)::int AS count
      FROM defects d WHERE ${defectsIn} AND ${inWindow(Prisma.sql`d."createdAt"`)}
      GROUP BY 1`;
    const defectsClosed = await tx.$queryRaw<BucketedCount[]>`
      SELECT ${truncate(bucket, Prisma.sql`d."closedAt"`)} AS bucket, COUNT(*)::int AS count
      FROM defects d WHERE ${defectsIn} AND ${inWindow(Prisma.sql`d."closedAt"`)}
      GROUP BY 1`;

    // A requirement counts as covered from its first link onwards, and never
    // before it exists. Requirements without a link have no start at all.
    const firstLink = Prisma.sql`(
      SELECT MIN(l."createdAt") FROM traceability_links l
      WHERE l."organizationId" = ${org}
        AND l."sourceType" = 'requirement' AND l."targetType" = 'test_case'
        AND l."sourceId" = q.id
        AND EXISTS (
          SELECT 1 FROM test_cases t
          WHERE t.id = l."targetId" AND t."organizationId" = ${org}
            AND t."projectId" = q."projectId"
            AND t."deletedAt" IS NULL AND t."archivedAt" IS NULL))`;
    const requirementsIn = this.requirementsInScope(ids, period.to);
    const requirementsAdded = await tx.$queryRaw<BucketedCount[]>`
      SELECT ${truncate(bucket, Prisma.sql`q."createdAt"`)} AS bucket, COUNT(*)::int AS count
      FROM requirements q WHERE ${requirementsIn} AND q."createdAt" >= ${period.from}
      GROUP BY 1`;
    const requirementsCovered = await tx.$queryRaw<BucketedCount[]>`
      SELECT ${truncate(bucket, Prisma.sql`s.start`)} AS bucket, COUNT(*)::int AS count
      FROM (
        SELECT GREATEST(q."createdAt", ${firstLink}) AS start, ${firstLink} AS "firstLink"
        FROM requirements q WHERE ${requirementsIn}
      ) s
      WHERE s."firstLink" IS NOT NULL AND ${inWindow(Prisma.sql`s.start`)}
      GROUP BY 1`;

    const baselineRows = await tx.$queryRaw<
      Array<{ defectsOpen: number; requirements: number; covered: number }>
    >`
      SELECT
        ((SELECT COUNT(*) FROM defects d WHERE ${defectsIn} AND d."createdAt" < ${period.from})
          - (SELECT COUNT(*) FROM defects d WHERE ${defectsIn} AND d."closedAt" < ${period.from}))::int
          AS "defectsOpen",
        (SELECT COUNT(*) FROM requirements q
          WHERE ${this.requirementsInScope(ids, period.from)})::int AS requirements,
        (SELECT COUNT(*) FROM requirements q
          WHERE ${this.requirementsInScope(ids, period.from)}
            AND ${this.coveredExpression(period.from)})::int AS covered`;

    return {
      results,
      defectsCreated,
      defectsClosed,
      requirementsAdded,
      requirementsCovered,
      baseline: baselineRows[0] ?? { defectsOpen: 0, requirements: 0, covered: 0 },
    };
  }

  /** The latest results, defects and run transitions in the window. */
  async recentActivity(
    tx: PrismaTransaction,
    projectIds: readonly string[],
    period: ResolvedPeriod,
    limit: number,
  ): Promise<ActivityRow[]> {
    const ids = [...projectIds];
    const org = this.organizationId;
    const rows = await tx.$queryRaw<
      Array<{
        kind: string;
        id: string;
        at: Date;
        projectId: string;
        label: string;
        status: string;
      }>
    >`
      SELECT * FROM (
        (SELECT 'result' AS kind, t.id, t."executedAt" AS at, r."projectId" AS "projectId",
            COALESCE(c."caseSnapshot"->>'key', '') || ' ' || COALESCE(c."caseSnapshot"->>'title', '') AS label,
            t.status::text AS status
          FROM test_results t
          JOIN test_runs r ON r.id = t."testRunId"
          JOIN test_run_cases c ON c.id = t."testRunCaseId"
          WHERE t."organizationId" = ${org} AND r."organizationId" = ${org}
            AND c."organizationId" = ${org}
            AND r."projectId" = ANY(${ids}::text[]) AND r."deletedAt" IS NULL
            AND t."executedAt" >= ${period.from} AND t."executedAt" < ${period.to}
          ORDER BY t."executedAt" DESC LIMIT ${limit})
        UNION ALL
        (SELECT 'defect' AS kind, d.id, d."createdAt" AS at, d."projectId" AS "projectId",
            d.key || ' ' || d.title AS label, d.severity::text AS status
          FROM defects d
          WHERE d."organizationId" = ${org} AND d."projectId" = ANY(${ids}::text[])
            AND d."deletedAt" IS NULL
            AND d."createdAt" >= ${period.from} AND d."createdAt" < ${period.to}
          ORDER BY d."createdAt" DESC LIMIT ${limit})
        UNION ALL
        (SELECT 'run' AS kind, r.id, COALESCE(r."completedAt", r."startedAt", r."createdAt") AS at,
            r."projectId" AS "projectId", r.name AS label, r.status::text AS status
          FROM test_runs r
          WHERE r."organizationId" = ${org} AND r."projectId" = ANY(${ids}::text[])
            AND r."deletedAt" IS NULL
            AND COALESCE(r."completedAt", r."startedAt", r."createdAt") >= ${period.from}
            AND COALESCE(r."completedAt", r."startedAt", r."createdAt") < ${period.to}
          ORDER BY 3 DESC LIMIT ${limit})
      ) activity
      ORDER BY at DESC, id
      LIMIT ${limit}`;

    return rows.flatMap((row) =>
      isActivityKind(row.kind) ? [{ ...row, kind: row.kind, label: row.label.trim() }] : [],
    );
  }
}

/** `date_trunc` with the bucket inlined: it comes from a closed enum, never from input. */
function truncate(bucket: AnalyticsBucket, column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`date_trunc(${Prisma.raw(`'${BUCKET_SQL[bucket]}'`)}, ${column})`;
}

const BUCKET_SQL: Record<AnalyticsBucket, string> = { day: 'day', week: 'week', month: 'month' };

function statusColumns(): Prisma.Sql {
  return Prisma.join(
    TEST_RESULT_STATUSES.map(
      (status) =>
        Prisma.sql`(COUNT(c.id) FILTER (WHERE c."latestStatus" = ${Prisma.raw(`'${status}'`)}))::int AS ${Prisma.raw(`"${status}"`)}`,
    ),
    ', ',
  );
}

function pickCounts(row: ExecutionCounts): ExecutionCounts {
  return {
    untested: row.untested,
    passed: row.passed,
    failed: row.failed,
    blocked: row.blocked,
    skipped: row.skipped,
  };
}

function isResultStatus(value: string): value is TestResultStatus {
  return (TEST_RESULT_STATUSES as readonly string[]).includes(value);
}

function isActivityKind(value: string): value is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}
