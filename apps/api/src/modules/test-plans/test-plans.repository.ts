import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export const PLAN_INCLUDE = {
  owner: { select: { id: true, fullName: true } },
  release: { select: { id: true, name: true, version: true } },
  environments: { include: { environment: { select: { id: true, name: true } } } },
  suites: { include: { suite: { select: { id: true, name: true } } } },
  cases: { include: { testCase: { select: { id: true, key: true, title: true } } } },
  runs: {
    include: {
      testRun: { select: { id: true, name: true, status: true, environment: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.TestPlanInclude;

export type PlanRow = Prisma.TestPlanGetPayload<{ include: typeof PLAN_INCLUDE }>;

export interface PlanFilters {
  projectId: string;
  status?: string | undefined;
  releaseId?: string | undefined;
  environmentId?: string | undefined;
  ownerId?: string | undefined;
  search?: string | undefined;
}

export interface ScopeCase {
  testCaseId: string;
  key: string;
  title: string;
  caseVersion: number;
  suiteId: string | null;
  suiteName: string | null;
  source: 'direct' | 'suite';
}

/** Test plans (S7-F1): plans, their links and the frozen scope. */
@Injectable()
export class TestPlansRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async list(query: PaginationQuery, filters: PlanFilters): Promise<Paginated<PlanRow>> {
    const where: Prisma.TestPlanWhereInput = this.scope({
      projectId: filters.projectId,
      ...(filters.status === undefined
        ? { status: { not: 'archived' } }
        : { status: filters.status }),
      ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      ...(filters.ownerId === undefined ? {} : { ownerId: filters.ownerId }),
      ...(filters.environmentId === undefined
        ? {}
        : { environments: { some: { environmentId: filters.environmentId } } }),
      ...(filters.search === undefined
        ? {}
        : { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.testPlan.findMany({
        where,
        include: PLAN_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...this.page(query),
      }),
      this.prisma.testPlan.count({ where }),
    ]);
    return { data: rows, meta: buildPaginationMeta(query, total) };
  }

  findById(id: string, tx?: PrismaTransaction): Promise<PlanRow | null> {
    return (tx ?? this.prisma).testPlan.findFirst({
      where: this.scope({ id }),
      include: PLAN_INCLUDE,
    });
  }

  async lock(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "test_plans"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return tx.testPlan.findFirst({ where: this.scope({ id }) });
  }

  create(data: Omit<Prisma.TestPlanUncheckedCreateInput, 'organizationId'>, tx: PrismaTransaction) {
    return tx.testPlan.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(id: string, data: Prisma.TestPlanUncheckedUpdateInput, tx: PrismaTransaction) {
    await tx.testPlan.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  // --- references, always inside the plan's project ----------------------

  liveEnvironments(projectId: string, ids: readonly string[], tx: PrismaTransaction) {
    return tx.environment.findMany({
      where: this.active({ projectId, id: { in: [...ids] }, status: { not: 'archived' } }),
      select: { id: true },
    });
  }

  liveSuites(projectId: string, ids: readonly string[], tx: PrismaTransaction) {
    return tx.testSuite.findMany({
      where: this.active({ projectId, id: { in: [...ids] } }),
      select: { id: true },
    });
  }

  liveCases(projectId: string, ids: readonly string[], tx: PrismaTransaction) {
    return tx.testCase.findMany({
      where: this.active({ projectId, id: { in: [...ids] }, archivedAt: null }),
      select: { id: true },
    });
  }

  findRelease(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.release.findFirst({
      where: this.scope({ projectId, id }),
      select: { id: true, status: true },
    });
  }

  findMember(userId: string, tx: PrismaTransaction) {
    return tx.organizationMember.findFirst({
      where: this.active({ userId, status: 'active' as const }),
      select: { userId: true, role: true },
    });
  }

  findRun(projectId: string, id: string, tx: PrismaTransaction) {
    return tx.testRun.findFirst({
      where: this.active({ projectId, id }),
      select: { id: true, name: true },
    });
  }

  async replaceLinks(
    plan: { id: string; projectId: string },
    links: { environmentIds?: string[]; suiteIds?: string[]; testCaseIds?: string[] },
    tx: PrismaTransaction,
  ): Promise<void> {
    const base = {
      planId: plan.id,
      projectId: plan.projectId,
      organizationId: this.organizationId,
    };
    if (links.environmentIds !== undefined) {
      await tx.testPlanEnvironment.deleteMany({ where: { planId: plan.id } });
      await tx.testPlanEnvironment.createMany({
        data: links.environmentIds.map((environmentId) => ({ ...base, environmentId })),
      });
    }
    if (links.suiteIds !== undefined) {
      await tx.testPlanSuite.deleteMany({ where: { planId: plan.id } });
      await tx.testPlanSuite.createMany({
        data: links.suiteIds.map((suiteId) => ({ ...base, suiteId })),
      });
    }
    if (links.testCaseIds !== undefined) {
      await tx.testPlanCase.deleteMany({ where: { planId: plan.id } });
      await tx.testPlanCase.createMany({
        data: links.testCaseIds.map((testCaseId) => ({ ...base, testCaseId })),
      });
    }
  }

  // --- scope ---------------------------------------------------------------

  /** Live scope: direct cases plus the live cases of the plan's suites; direct wins. */
  async liveScope(planId: string, projectId: string, tx: PrismaTransaction): Promise<ScopeCase[]> {
    const [direct, suites] = await Promise.all([
      tx.testPlanCase.findMany({
        where: { planId, organizationId: this.organizationId },
        select: { testCaseId: true },
      }),
      tx.testPlanSuite.findMany({
        where: { planId, organizationId: this.organizationId },
        select: { suiteId: true },
      }),
    ]);
    const cases = await tx.testCase.findMany({
      where: this.active({
        projectId,
        archivedAt: null,
        OR: [
          { id: { in: direct.map((row) => row.testCaseId) } },
          { suiteId: { in: suites.map((row) => row.suiteId) }, suite: { deletedAt: null } },
        ],
      }),
      select: {
        id: true,
        key: true,
        title: true,
        version: true,
        suiteId: true,
        suite: { select: { name: true } },
      },
      orderBy: [{ key: 'asc' }],
    });
    const directIds = new Set(direct.map((row) => row.testCaseId));
    return cases.map((row) => ({
      testCaseId: row.id,
      key: row.key,
      title: row.title,
      caseVersion: row.version,
      suiteId: row.suiteId,
      suiteName: row.suite.name,
      source: directIds.has(row.id) ? 'direct' : 'suite',
    }));
  }

  async frozenScope(
    planId: string,
    scopeVersion: number,
    tx: PrismaTransaction,
  ): Promise<ScopeCase[]> {
    const rows = await tx.testPlanScopeItem.findMany({
      where: { planId, scopeVersion, organizationId: this.organizationId },
      orderBy: [{ caseKey: 'asc' }],
    });
    return rows.map((row) => ({
      testCaseId: row.testCaseId,
      key: row.caseKey,
      title: row.caseTitle,
      caseVersion: row.caseVersion,
      suiteId: row.suiteId,
      suiteName: row.suiteName,
      source: row.source as 'direct' | 'suite',
    }));
  }

  countScope(planId: string, scopeVersion: number, tx?: PrismaTransaction) {
    return (tx ?? this.prisma).testPlanScopeItem.count({
      where: { planId, scopeVersion, organizationId: this.organizationId },
    });
  }

  async writeScope(
    plan: { id: string; projectId: string },
    scopeVersion: number,
    cases: readonly ScopeCase[],
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.testPlanScopeItem.createMany({
      data: cases.map((row) => ({
        organizationId: this.organizationId,
        projectId: plan.projectId,
        planId: plan.id,
        scopeVersion,
        testCaseId: row.testCaseId,
        caseKey: row.key,
        caseTitle: row.title,
        caseVersion: row.caseVersion,
        suiteId: row.suiteId,
        suiteName: row.suiteName,
        source: row.source,
      })),
    });
  }

  // --- runs and results ------------------------------------------------------

  attachRun(plan: { id: string; projectId: string }, testRunId: string, tx: PrismaTransaction) {
    return tx.testPlanRun.createMany({
      data: [
        {
          planId: plan.id,
          projectId: plan.projectId,
          organizationId: this.organizationId,
          testRunId,
        },
      ],
    });
  }

  detachRun(planId: string, testRunId: string, tx: PrismaTransaction) {
    return tx.testPlanRun.deleteMany({
      where: { planId, testRunId, organizationId: this.organizationId },
    });
  }

  /** Cases of the plan's live (not aborted, not deleted) runs with their latest result. */
  async runCases(planId: string, tx: PrismaTransaction) {
    const runs = await tx.testPlanRun.findMany({
      where: { planId, organizationId: this.organizationId },
      select: { testRunId: true },
    });
    const runIds = runs.map((row) => row.testRunId);
    const rows = await tx.testRunCase.findMany({
      where: {
        organizationId: this.organizationId,
        testRunId: { in: runIds },
        testRun: { deletedAt: null, status: { not: 'aborted' } },
      },
      select: {
        testCaseId: true,
        latestStatus: true,
        testRun: { select: { id: true, name: true } },
        results: { orderBy: { executedAt: 'desc' }, take: 1, select: { executedAt: true } },
      },
    });
    return {
      runIds,
      rows: rows.map((row) => ({
        testCaseId: row.testCaseId,
        status: row.latestStatus,
        run: row.testRun,
        executedAt: row.results[0]?.executedAt ?? null,
      })),
    };
  }

  defects(
    projectId: string,
    runIds: readonly string[],
    caseIds: readonly string[],
    tx: PrismaTransaction,
  ) {
    return tx.defect.findMany({
      where: this.active({
        projectId,
        OR: [{ testRunId: { in: [...runIds] } }, { testCaseId: { in: [...caseIds] } }],
      }),
      select: { id: true, key: true, title: true, severity: true, status: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
}
