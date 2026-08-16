import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TestCase,
  TestResult,
  TestResultStatus,
  TestRun,
  TestRunCase,
  TestStep,
} from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface TestRunFilters {
  projectId: string;
  status?: Prisma.TestRunWhereInput['status'];
  milestone?: string;
  search?: string;
}

export interface RunCaseFilters {
  latestStatus?: TestResultStatus;
  assignedToId?: string;
}

@Injectable()
export class TestRunsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  // --- Runs ----------------------------------------------------------------

  findById(id: string, tx?: PrismaTransaction): Promise<TestRun | null> {
    return (tx ?? this.prisma).testRun.findFirst({ where: this.active({ id }) });
  }

  async list(query: PaginationQuery, filters: TestRunFilters): Promise<Paginated<TestRun>> {
    const where: Prisma.TestRunWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.milestone === undefined ? {} : { milestone: filters.milestone }),
      ...(filters.search === undefined
        ? {}
        : { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } }),
    });

    const [data, total] = await Promise.all([
      this.prisma.testRun.findMany({ where, orderBy: { createdAt: 'desc' }, ...this.page(query) }),
      this.prisma.testRun.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  create(
    data: Omit<Prisma.TestRunUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<TestRun> {
    return tx.testRun.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(
    id: string,
    data: Prisma.TestRunUpdateInput,
    tx?: PrismaTransaction,
  ): Promise<TestRun | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.testRun.updateMany({ where: this.active({ id }), data });
    if (count === 0) {
      return null;
    }
    return client.testRun.findFirst({ where: this.active({ id }) });
  }

  async softDelete(id: string, tx?: PrismaTransaction): Promise<boolean> {
    const { count } = await (tx ?? this.prisma).testRun.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * One grouped query per run instead of five counts. The caller turns the rows
   * into the progress object; the database does the counting.
   */
  async progressOf(testRunId: string): Promise<Array<{ status: TestResultStatus; count: number }>> {
    const rows = await this.prisma.testRunCase.groupBy({
      by: ['latestStatus'],
      where: this.scope({ testRunId }),
      _count: { _all: true },
    });

    return rows.map((row) => ({ status: row.latestStatus, count: row._count._all }));
  }

  // --- Cases in a run ------------------------------------------------------

  findRunCaseById(id: string, tx?: PrismaTransaction): Promise<TestRunCase | null> {
    return (tx ?? this.prisma).testRunCase.findFirst({ where: this.scope({ id }) });
  }

  async listRunCases(
    testRunId: string,
    query: PaginationQuery,
    filters: RunCaseFilters,
  ): Promise<Paginated<TestRunCase>> {
    const where: Prisma.TestRunCaseWhereInput = this.scope({
      testRunId,
      ...(filters.latestStatus === undefined ? {} : { latestStatus: filters.latestStatus }),
      ...(filters.assignedToId === undefined ? {} : { assignedToId: filters.assignedToId }),
    });

    const [data, total] = await Promise.all([
      this.prisma.testRunCase.findMany({
        where,
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        ...this.page(query),
      }),
      this.prisma.testRunCase.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  listCaseIdsInRun(testRunId: string, tx: PrismaTransaction): Promise<Array<{ testCaseId: string }>> {
    return tx.testRunCase.findMany({
      where: this.scope({ testRunId }),
      select: { testCaseId: true },
    });
  }

  async addRunCases(
    rows: Array<Omit<Prisma.TestRunCaseCreateManyInput, 'organizationId'>>,
    tx: PrismaTransaction,
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const { count } = await tx.testRunCase.createMany({
      data: rows.map((row) => ({ ...row, organizationId: this.organizationId })),
      // A case already in the run is not an error worth failing the batch for.
      skipDuplicates: true,
    });
    return count;
  }

  async removeRunCase(id: string): Promise<boolean> {
    const { count } = await this.prisma.testRunCase.deleteMany({ where: this.scope({ id }) });
    return count > 0;
  }

  async assignRunCases(ids: string[], assignedToId: string | null): Promise<number> {
    const { count } = await this.prisma.testRunCase.updateMany({
      where: this.scope({ id: { in: ids } }),
      data: { assignedToId },
    });
    return count;
  }

  async maxPosition(testRunId: string, tx: PrismaTransaction): Promise<number> {
    const row = await tx.testRunCase.aggregate({
      where: this.scope({ testRunId }),
      _max: { position: true },
    });
    return row._max.position ?? 0;
  }

  /** The cases a run would include, with their steps, ready to snapshot. */
  casesForSelection(
    where: Prisma.TestCaseWhereInput,
    tx: PrismaTransaction,
  ): Promise<Array<TestCase & { steps: TestStep[] }>> {
    return tx.testCase.findMany({
      where: { ...where, organizationId: this.organizationId, deletedAt: null, archivedAt: null },
      include: { steps: { orderBy: { position: 'asc' } } },
      orderBy: { key: 'asc' },
    });
  }

  // --- Results -------------------------------------------------------------

  createResult(
    data: Omit<Prisma.TestResultUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<TestResult> {
    return tx.testResult.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async setLatestStatus(
    runCaseId: string,
    status: TestResultStatus,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.testRunCase.updateMany({
      where: this.scope({ id: runCaseId }),
      data: { latestStatus: status },
    });
  }

  listResults(runCaseId: string): Promise<TestResult[]> {
    return this.prisma.testResult.findMany({
      where: this.scope({ testRunCaseId: runCaseId }),
      orderBy: { executedAt: 'desc' },
    });
  }

  findResultById(id: string): Promise<TestResult | null> {
    return this.prisma.testResult.findFirst({ where: this.scope({ id }) });
  }

  /**
   * Results are never deleted, but they are only reachable through their run,
   * so deleting the run is what makes them unreachable and their links dangling.
   */
  async resultIdsForRun(testRunId: string, tx?: PrismaTransaction): Promise<string[]> {
    const rows = await (tx ?? this.prisma).testResult.findMany({
      where: this.scope({ testRunId }),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}
