import { Injectable } from '@nestjs/common';
import { Prisma, TestCase, TestSection, TestStep, TestSuite } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface TestCaseFilters {
  projectId: string;
  suiteId?: string;
  sectionId?: string;
  status?: Prisma.TestCaseWhereInput['status'];
  type?: Prisma.TestCaseWhereInput['type'];
  priority?: Prisma.TestCaseWhereInput['priority'];
  automationStatus?: Prisma.TestCaseWhereInput['automationStatus'];
  tag?: string;
  search?: string;
  includeArchived: boolean;
}

@Injectable()
export class TestDesignRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  // --- Suites --------------------------------------------------------------

  findSuiteById(id: string, tx?: PrismaTransaction): Promise<TestSuite | null> {
    return (tx ?? this.prisma).testSuite.findFirst({ where: this.active({ id }) });
  }

  findSuiteByName(projectId: string, name: string): Promise<TestSuite | null> {
    return this.prisma.testSuite.findFirst({ where: this.active({ projectId, name }) });
  }

  listSuites(projectId: string): Promise<Array<TestSuite & { _count: { testCases: number } }>> {
    return this.prisma.testSuite.findMany({
      where: this.active({ projectId }),
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      // Archived cases are hidden from the default case list, so counting them
      // here would leave the tree claiming cases the table does not show.
      include: {
        _count: { select: { testCases: { where: { deletedAt: null, archivedAt: null } } } },
      },
    });
  }

  createSuite(
    data: Omit<Prisma.TestSuiteUncheckedCreateInput, 'organizationId'>,
  ): Promise<TestSuite> {
    return this.prisma.testSuite.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async updateSuite(id: string, data: Prisma.TestSuiteUpdateInput): Promise<TestSuite | null> {
    const { count } = await this.prisma.testSuite.updateMany({ where: this.active({ id }), data });
    return count === 0 ? null : this.findSuiteById(id);
  }

  /**
   * Returns the ids of the cases that went down with the suite, or `null` when
   * there was no suite to delete. The caller needs them: whatever else points
   * at those cases has to be cleaned up in this same transaction, and after the
   * update they are no longer reachable by any query.
   */
  async softDeleteSuite(id: string, tx: PrismaTransaction): Promise<string[] | null> {
    const deletedAt = new Date();
    const cases = await tx.testCase.findMany({
      where: this.active({ suiteId: id }),
      select: { id: true },
    });

    const { count } = await tx.testSuite.updateMany({
      where: this.active({ id }),
      data: { deletedAt },
    });
    if (count === 0) {
      return null;
    }
    // Children go with the parent. Leaving them behind would produce cases that
    // no listing reaches but that still count in every aggregate.
    await tx.testSection.updateMany({ where: this.active({ suiteId: id }), data: { deletedAt } });
    await tx.testCase.updateMany({ where: this.active({ suiteId: id }), data: { deletedAt } });
    return cases.map((testCase) => testCase.id);
  }

  countCasesInSuite(suiteId: string): Promise<number> {
    return this.prisma.testCase.count({ where: this.active({ suiteId }) });
  }

  // --- Sections ------------------------------------------------------------

  findSectionById(id: string): Promise<TestSection | null> {
    return this.prisma.testSection.findFirst({ where: this.active({ id }) });
  }

  listSections(suiteId: string): Promise<TestSection[]> {
    return this.prisma.testSection.findMany({
      where: this.active({ suiteId }),
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  createSection(
    data: Omit<Prisma.TestSectionUncheckedCreateInput, 'organizationId'>,
  ): Promise<TestSection> {
    return this.prisma.testSection.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async updateSection(
    id: string,
    data: Prisma.TestSectionUpdateInput,
  ): Promise<TestSection | null> {
    const { count } = await this.prisma.testSection.updateMany({
      where: this.active({ id }),
      data,
    });
    return count === 0 ? null : this.findSectionById(id);
  }

  async softDeleteSections(ids: string[], tx: PrismaTransaction): Promise<void> {
    const deletedAt = new Date();
    await tx.testSection.updateMany({
      where: this.scope({ id: { in: ids } }),
      data: { deletedAt },
    });
    // Cases survive their section: losing the folder should not lose the tests.
    await tx.testCase.updateMany({
      where: this.active({ sectionId: { in: ids } }),
      data: { sectionId: null },
    });
  }

  // --- Cases ---------------------------------------------------------------

  findCaseById(id: string, tx?: PrismaTransaction): Promise<TestCase | null> {
    return (tx ?? this.prisma).testCase.findFirst({ where: this.active({ id }) });
  }

  findCaseWithSteps(id: string): Promise<(TestCase & { steps: TestStep[] }) | null> {
    return this.prisma.testCase.findFirst({
      where: this.active({ id }),
      include: { steps: { orderBy: { position: 'asc' } } },
    });
  }

  async listCases(query: PaginationQuery, filters: TestCaseFilters): Promise<Paginated<TestCase>> {
    const where: Prisma.TestCaseWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.includeArchived ? {} : { archivedAt: null }),
      ...(filters.suiteId === undefined ? {} : { suiteId: filters.suiteId }),
      ...(filters.sectionId === undefined ? {} : { sectionId: filters.sectionId }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.type === undefined ? {} : { type: filters.type }),
      ...(filters.priority === undefined ? {} : { priority: filters.priority }),
      ...(filters.automationStatus === undefined
        ? {}
        : { automationStatus: filters.automationStatus }),
      ...(filters.tag === undefined ? {} : { tags: { has: filters.tag } }),
      ...(filters.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
              { key: { contains: filters.search.toUpperCase() } },
            ],
          }),
    });

    const [data, total] = await Promise.all([
      this.prisma.testCase.findMany({ where, orderBy: { createdAt: 'desc' }, ...this.page(query) }),
      this.prisma.testCase.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  createCase(
    data: Omit<Prisma.TestCaseUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<TestCase> {
    return tx.testCase.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async updateCase(
    id: string,
    data: Prisma.TestCaseUpdateInput,
    tx?: PrismaTransaction,
  ): Promise<TestCase | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.testCase.updateMany({ where: this.active({ id }), data });
    if (count === 0) {
      return null;
    }
    return client.testCase.findFirst({ where: this.active({ id }) });
  }

  async softDeleteCase(id: string, tx?: PrismaTransaction): Promise<boolean> {
    const { count } = await (tx ?? this.prisma).testCase.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  // --- Steps ---------------------------------------------------------------

  listSteps(testCaseId: string): Promise<TestStep[]> {
    return this.prisma.testStep.findMany({
      where: this.scope({ testCaseId }),
      orderBy: { position: 'asc' },
    });
  }

  /**
   * Replaces the whole ordered list. Delete-then-insert inside one transaction
   * is what keeps `(testCaseId, position)` unique without an intermediate state
   * where two steps briefly share a position.
   */
  async replaceSteps(
    testCaseId: string,
    steps: Array<{
      action: string;
      expectedResult?: string | null | undefined;
      data?: string | null | undefined;
    }>,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.testStep.deleteMany({ where: this.scope({ testCaseId }) });
    if (steps.length === 0) {
      return;
    }
    await tx.testStep.createMany({
      data: steps.map((step, index) => ({
        organizationId: this.organizationId,
        testCaseId,
        position: index + 1,
        action: step.action,
        expectedResult: step.expectedResult ?? null,
        data: step.data ?? null,
      })),
    });
  }
}
