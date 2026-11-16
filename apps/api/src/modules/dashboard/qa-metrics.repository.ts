import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ExecutionCounts,
  FLAKY_WINDOW,
  ResolvedPeriod,
  TEST_RESULT_STATUSES,
  TestResultStatus,
  emptyExecutionCounts,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';
import { truncate } from './analytics.repository';

/** Filters already resolved to ids of the authorized project. */
export interface QaScope {
  projectId: string;
  period: ResolvedPeriod;
  testPlanId: string | null;
  testCycleId: string | null;
  releaseId: string | null;
  environment: { id: string; name: string } | null;
}

export interface ProgressRef {
  id: string;
  name: string;
  status: string;
  testPlanId: string | null;
}

export interface ResultBucket {
  bucket: Date;
  passed: number;
  failed: number;
  blocked: number;
}

export interface EvolutionSample {
  testCaseId: string;
  status: 'passed' | 'failed';
  executedAt: Date;
  caseVersion: number | null;
  iterationKey: string;
}

/**
 * Aggregate SQL of the QA metrics dashboard (S7-F7). Like the analytics
 * repository, every statement filters by `organizationId` and the authorized
 * project and runs inside `read()`, a tenant transaction, so RLS applies under
 * the runtime role.
 */
@Injectable()
export class QaMetricsRepository extends TenantAwareRepository {
  constructor(
    private readonly database: PrismaService,
    tenant: TenantContextService,
  ) {
    super(database, tenant);
  }

  read<T>(work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.database.runInTransaction(work, { timeoutMs: 20_000 });
  }

  findPlan(projectId: string, id: string) {
    return this.prisma.testPlan.findFirst({
      where: this.scope({ id, projectId }),
      select: { id: true },
    });
  }

  findCycle(projectId: string, id: string) {
    return this.prisma.testCycle.findFirst({
      where: this.scope({ id, projectId }),
      select: { id: true, testPlanId: true },
    });
  }

  findRelease(projectId: string, id: string) {
    return this.prisma.release.findFirst({
      where: this.scope({ id, projectId }),
      select: { id: true },
    });
  }

  findEnvironment(projectId: string, id: string) {
    return this.prisma.environment.findFirst({
      where: this.scope({ id, projectId, deletedAt: null }),
      select: { id: true, name: true },
    });
  }

  /** The analytics "runs in scope" of the window, narrowed by the filters. */
  private runs(scope: QaScope): Prisma.Sql {
    const { period } = scope;
    const plan =
      scope.testPlanId === null
        ? Prisma.empty
        : Prisma.sql`AND (
            EXISTS (SELECT 1 FROM test_plan_runs pr WHERE pr."testRunId" = r.id AND pr."planId" = ${scope.testPlanId})
            OR EXISTS (
              SELECT 1 FROM test_cycle_runs cr JOIN test_cycles cy ON cy.id = cr."cycleId"
              WHERE cr."testRunId" = r.id AND cy."testPlanId" = ${scope.testPlanId}))`;
    const cycle =
      scope.testCycleId === null
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (SELECT 1 FROM test_cycle_runs cr WHERE cr."testRunId" = r.id AND cr."cycleId" = ${scope.testCycleId})`;
    const release =
      scope.releaseId === null ? Prisma.empty : Prisma.sql`AND r."releaseId" = ${scope.releaseId}`;
    const environment =
      scope.environment === null
        ? Prisma.empty
        : Prisma.sql`AND (
            lower(r.environment) = lower(${scope.environment.name})
            OR EXISTS (
              SELECT 1 FROM test_cycle_runs cr JOIN test_cycles cy ON cy.id = cr."cycleId"
              WHERE cr."testRunId" = r.id AND cy."environmentId" = ${scope.environment.id}))`;
    return Prisma.sql`
      r."organizationId" = ${this.organizationId}
      AND r."projectId" = ${scope.projectId}
      AND r."deletedAt" IS NULL
      AND r.status <> 'aborted'
      AND r."createdAt" < ${period.to}
      AND (r."completedAt" IS NULL OR r."completedAt" >= ${period.from})
      ${plan} ${cycle} ${release} ${environment}`;
  }

  async runCount(tx: PrismaTransaction, scope: QaScope): Promise<number> {
    const [row] = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM test_runs r WHERE ${this.runs(scope)}`;
    return row?.count ?? 0;
  }

  async execution(tx: PrismaTransaction, scope: QaScope): Promise<ExecutionCounts> {
    const rows = await tx.$queryRaw<Array<{ status: string; count: number }>>`
      SELECT c."latestStatus"::text AS status, COUNT(*)::int AS count
      FROM test_run_cases c JOIN test_runs r ON r.id = c."testRunId"
      WHERE c."organizationId" = ${this.organizationId} AND ${this.runs(scope)}
      GROUP BY 1`;
    const counts = emptyExecutionCounts();
    for (const row of rows) {
      if ((TEST_RESULT_STATUSES as readonly string[]).includes(row.status)) {
        counts[row.status as TestResultStatus] += row.count;
      }
    }
    return counts;
  }

  resultBuckets(tx: PrismaTransaction, scope: QaScope): Promise<ResultBucket[]> {
    return tx.$queryRaw<ResultBucket[]>`
      SELECT ${truncate(scope.period.bucket, Prisma.sql`t."executedAt"`)} AS bucket,
             COUNT(*) FILTER (WHERE t.status = 'passed')::int AS passed,
             COUNT(*) FILTER (WHERE t.status = 'failed')::int AS failed,
             COUNT(*) FILTER (WHERE t.status = 'blocked')::int AS blocked
      FROM test_results t JOIN test_runs r ON r.id = t."testRunId"
      WHERE t."organizationId" = ${this.organizationId}
        AND t."executedAt" >= ${scope.period.from} AND t."executedAt" < ${scope.period.to}
        AND ${this.runs(scope)}
      GROUP BY 1`;
  }

  /** Open defects by severity: the whole project, or only those raised from runs in scope. */
  openDefects(
    tx: PrismaTransaction,
    scope: QaScope,
    onlyRunsInScope: boolean,
  ): Promise<Array<{ severity: string; count: number }>> {
    const runs = onlyRunsInScope
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM test_runs r WHERE r.id = d."testRunId" AND ${this.runs(scope)})`
      : Prisma.empty;
    return tx.$queryRaw`
      SELECT d.severity::text AS severity, COUNT(*)::int AS count
      FROM defects d
      WHERE d."organizationId" = ${this.organizationId} AND d."projectId" = ${scope.projectId}
        AND d."deletedAt" IS NULL
        AND d.status::text IN ('open', 'triaged', 'in_progress', 'reopened')
        ${runs}
      GROUP BY 1`;
  }

  async defectsRaised(tx: PrismaTransaction, scope: QaScope): Promise<number> {
    const [row] = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM defects d
      WHERE d."organizationId" = ${this.organizationId} AND d."projectId" = ${scope.projectId}
        AND d."deletedAt" IS NULL
        AND d."createdAt" >= ${scope.period.from} AND d."createdAt" < ${scope.period.to}
        AND EXISTS (SELECT 1 FROM test_runs r WHERE r.id = d."testRunId" AND ${this.runs(scope)})`;
    return row?.count ?? 0;
  }

  /** Plans alive in the window, newest first. */
  plans(scope: QaScope, limit: number): Promise<ProgressRef[]> {
    const { period } = scope;
    return this.prisma.testPlan
      .findMany({
        where: this.scope({
          projectId: scope.projectId,
          archivedAt: null,
          createdAt: { lt: period.to },
          OR: [{ completedAt: null }, { completedAt: { gte: period.from } }],
          ...(scope.testPlanId === null ? {} : { id: scope.testPlanId }),
          ...(scope.testCycleId === null ? {} : { cycles: { some: { id: scope.testCycleId } } }),
          ...(scope.releaseId === null ? {} : { releaseId: scope.releaseId }),
          ...(scope.environment === null
            ? {}
            : { environments: { some: { environmentId: scope.environment.id } } }),
        }),
        select: { id: true, name: true, status: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      })
      .then((rows) => rows.map((row) => ({ ...row, testPlanId: null })));
  }

  /** Cycles alive in the window, newest first. */
  cycles(scope: QaScope, limit: number): Promise<ProgressRef[]> {
    const { period } = scope;
    return this.prisma.testCycle.findMany({
      where: this.scope({
        projectId: scope.projectId,
        archivedAt: null,
        createdAt: { lt: period.to },
        OR: [{ completedAt: null }, { completedAt: { gte: period.from } }],
        ...(scope.testPlanId === null ? {} : { testPlanId: scope.testPlanId }),
        ...(scope.testCycleId === null ? {} : { id: scope.testCycleId }),
        ...(scope.releaseId === null ? {} : { releaseId: scope.releaseId }),
        ...(scope.environment === null ? {} : { environmentId: scope.environment.id }),
      }),
      select: { id: true, name: true, status: true, testPlanId: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  private sessions(scope: QaScope): Prisma.Sql {
    const { period } = scope;
    return Prisma.sql`
      s."organizationId" = ${this.organizationId} AND s."projectId" = ${scope.projectId}
      AND s."createdAt" < ${period.to}
      AND (s."endedAt" IS NULL OR s."endedAt" >= ${period.from})
      ${scope.testPlanId === null ? Prisma.empty : Prisma.sql`AND s."testPlanId" = ${scope.testPlanId}`}
      ${scope.testCycleId === null ? Prisma.empty : Prisma.sql`AND s."testCycleId" = ${scope.testCycleId}`}
      ${scope.releaseId === null ? Prisma.empty : Prisma.sql`AND s."releaseId" = ${scope.releaseId}`}
      ${scope.environment === null ? Prisma.empty : Prisma.sql`AND s."environmentId" = ${scope.environment.id}`}`;
  }

  sessionGroups(
    tx: PrismaTransaction,
    scope: QaScope,
  ): Promise<Array<{ status: string; count: number; seconds: number }>> {
    return tx.$queryRaw`
      SELECT s.status, COUNT(*)::int AS count, COALESCE(SUM(s."durationSeconds"), 0)::int AS seconds
      FROM exploratory_sessions s WHERE ${this.sessions(scope)}
      GROUP BY 1`;
  }

  findingGroups(
    tx: PrismaTransaction,
    scope: QaScope,
  ): Promise<Array<{ kind: string; severity: string; count: number; created: number }>> {
    return tx.$queryRaw`
      SELECT f.kind, f.severity::text AS severity, COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE f."defectCreated")::int AS created
      FROM exploratory_findings f JOIN exploratory_sessions s ON s.id = f."sessionId"
      WHERE f."organizationId" = ${this.organizationId} AND ${this.sessions(scope)}
      GROUP BY 1, 2`;
  }

  /**
   * `passed`/`failed` results of the project before `to`: every one inside the
   * window plus the newest {@link FLAKY_WINDOW} of each case before it, enough
   * to classify each case at the end of any bucket.
   */
  evolutionSamples(tx: PrismaTransaction, scope: QaScope): Promise<EvolutionSample[]> {
    const { period } = scope;
    return tx.$queryRaw<EvolutionSample[]>`
      SELECT w."testCaseId", w.status, w."executedAt", w."caseVersion", w."iterationKey"
      FROM (
        SELECT rc."testCaseId", t.status::text AS status, t."executedAt",
               COALESCE(t."caseVersion", rc."caseVersion") AS "caseVersion", rc."iterationKey",
               ROW_NUMBER() OVER (
                 PARTITION BY rc."testCaseId", (t."executedAt" >= ${period.from})
                 ORDER BY t."executedAt" DESC, t.id DESC
               ) AS rank
        FROM test_results t
        JOIN test_run_cases rc ON rc.id = t."testRunCaseId"
        JOIN test_runs r ON r.id = t."testRunId"
        JOIN test_cases tc ON tc.id = rc."testCaseId"
        WHERE t."organizationId" = ${this.organizationId}
          AND r."projectId" = ${scope.projectId}
          AND r."deletedAt" IS NULL AND tc."deletedAt" IS NULL
          AND t.status IN ('passed', 'failed')
          AND t."executedAt" < ${period.to}
      ) w
      WHERE w."executedAt" >= ${period.from} OR w.rank <= ${FLAKY_WINDOW}
      ORDER BY w."executedAt" ASC`;
  }
}
