import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';
import { ScopeCase } from './test-plans.repository';

export const CYCLE_INCLUDE = {
  testPlan: { select: { id: true, name: true, status: true } },
  owner: { select: { id: true, fullName: true } },
  environment: { select: { id: true, name: true } },
  release: { select: { id: true, name: true, version: true } },
  runs: {
    include: {
      testRun: { select: { id: true, name: true, status: true, environment: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.TestCycleInclude;

export type CycleRow = Prisma.TestCycleGetPayload<{ include: typeof CYCLE_INCLUDE }>;

/** Test cycles (S7-F2): cycles, their runs and their frozen scope. */
@Injectable()
export class TestCyclesRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async list(
    query: PaginationQuery,
    filters: {
      testPlanId: string;
      status?: string | undefined;
      environmentId?: string | undefined;
      releaseId?: string | undefined;
      ownerId?: string | undefined;
    },
  ): Promise<Paginated<CycleRow>> {
    const where: Prisma.TestCycleWhereInput = this.scope({
      testPlanId: filters.testPlanId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.environmentId === undefined ? {} : { environmentId: filters.environmentId }),
      ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      ...(filters.ownerId === undefined ? {} : { ownerId: filters.ownerId }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.testCycle.findMany({
        where,
        include: CYCLE_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...this.page(query),
      }),
      this.prisma.testCycle.count({ where }),
    ]);
    return { data: rows, meta: buildPaginationMeta(query, total) };
  }

  findById(id: string, tx?: PrismaTransaction): Promise<CycleRow | null> {
    return (tx ?? this.prisma).testCycle.findFirst({
      where: this.scope({ id }),
      include: CYCLE_INCLUDE,
    });
  }

  async lock(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "test_cycles"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return tx.testCycle.findFirst({ where: this.scope({ id }) });
  }

  /** The plan, share-locked so it cannot change status while a cycle is written. */
  async lockPlan(id: string, tx: PrismaTransaction) {
    await tx.$queryRaw`
      SELECT "id" FROM "test_plans"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR SHARE`;
    return tx.testPlan.findFirst({ where: this.scope({ id }) });
  }

  findPlan(id: string) {
    return this.prisma.testPlan.findFirst({
      where: this.scope({ id }),
      select: { id: true, projectId: true, status: true, releaseId: true },
    });
  }

  create(
    data: Omit<Prisma.TestCycleUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ) {
    return tx.testCycle.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(id: string, data: Prisma.TestCycleUncheckedUpdateInput, tx: PrismaTransaction) {
    await tx.testCycle.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  async frozenScope(cycleId: string, tx: PrismaTransaction): Promise<ScopeCase[]> {
    const rows = await tx.testCycleScopeItem.findMany({
      where: { cycleId, organizationId: this.organizationId },
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

  countScope(cycleId: string) {
    return this.prisma.testCycleScopeItem.count({
      where: { cycleId, organizationId: this.organizationId },
    });
  }

  async writeScope(
    cycle: { id: string; projectId: string },
    cases: readonly ScopeCase[],
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.testCycleScopeItem.createMany({
      data: cases.map((row) => ({
        organizationId: this.organizationId,
        projectId: cycle.projectId,
        cycleId: cycle.id,
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

  planRun(planId: string, testRunId: string, tx: PrismaTransaction) {
    return tx.testPlanRun
      .findFirst({
        where: { testRunId, organizationId: this.organizationId },
        select: { planId: true },
      })
      .then((row) => (row === null ? null : row.planId === planId ? 'same' : 'other'));
  }

  attachRun(cycle: { id: string; projectId: string }, testRunId: string, tx: PrismaTransaction) {
    return tx.testCycleRun.createMany({
      data: [
        {
          cycleId: cycle.id,
          projectId: cycle.projectId,
          organizationId: this.organizationId,
          testRunId,
        },
      ],
    });
  }

  detachRun(cycleId: string, testRunId: string, tx: PrismaTransaction) {
    return tx.testCycleRun.deleteMany({
      where: { cycleId, testRunId, organizationId: this.organizationId },
    });
  }

  async runCases(cycleId: string, tx: PrismaTransaction) {
    const runs = await tx.testCycleRun.findMany({
      where: { cycleId, organizationId: this.organizationId },
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
}
