import { Injectable } from '@nestjs/common';
import { Prisma, TestCase, TestRunCase, TestSection, TestStep, TestSuite } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export const EXPORT_PAGE_SIZE = 1000;

export type CaseWithSteps = TestCase & { steps: TestStep[] };

@Injectable()
export class ExportsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  caseWhere(
    projectId: string,
    filters: {
      suiteId?: string | undefined;
      sectionId?: string | undefined;
      status?: TestCase['status'] | undefined;
      includeArchived: boolean;
    },
  ): Prisma.TestCaseWhereInput {
    return this.active({
      projectId,
      ...(filters.suiteId === undefined ? {} : { suiteId: filters.suiteId }),
      ...(filters.sectionId === undefined ? {} : { sectionId: filters.sectionId }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
      suite: { deletedAt: null },
    });
  }

  countCases(where: Prisma.TestCaseWhereInput): Promise<number> {
    return this.prisma.testCase.count({ where });
  }

  /** Keyset pagination on the primary key: stable and cheap however deep the page. */
  casesPage(where: Prisma.TestCaseWhereInput, after: string | null): Promise<CaseWithSteps[]> {
    return this.prisma.testCase.findMany({
      where: after === null ? where : { AND: [where, { id: { gt: after } }] },
      include: { steps: { orderBy: { position: 'asc' } } },
      orderBy: { id: 'asc' },
      take: EXPORT_PAGE_SIZE,
    });
  }

  suitesOf(projectId: string): Promise<TestSuite[]> {
    return this.prisma.testSuite.findMany({ where: this.active({ projectId }) });
  }

  sectionsOf(suiteIds: string[]): Promise<TestSection[]> {
    return this.prisma.testSection.findMany({ where: this.active({ suiteId: { in: suiteIds } }) });
  }

  /** Requirement keys linked to each case, for the `references` column. */
  async requirementKeysByCase(caseIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (caseIds.length === 0) {
      return result;
    }
    const links = await this.prisma.traceabilityLink.findMany({
      where: this.scope({
        sourceType: 'requirement' as const,
        targetType: 'test_case' as const,
        targetId: { in: caseIds },
      }),
      select: { sourceId: true, targetId: true },
    });
    const requirements = await this.prisma.requirement.findMany({
      where: this.active({ id: { in: [...new Set(links.map((link) => link.sourceId))] } }),
      select: { id: true, key: true },
    });
    const keyById = new Map(requirements.map((requirement) => [requirement.id, requirement.key]));
    for (const link of links) {
      const key = keyById.get(link.sourceId);
      if (key !== undefined) {
        result.set(link.targetId, [...(result.get(link.targetId) ?? []), key].sort());
      }
    }
    return result;
  }

  findRun(id: string) {
    return this.prisma.testRun.findFirst({ where: this.active({ id }) });
  }

  countRunCases(testRunId: string): Promise<number> {
    return this.prisma.testRunCase.count({ where: this.scope({ testRunId }) });
  }

  runCases(testRunId: string): Promise<TestRunCase[]> {
    return this.prisma.testRunCase.findMany({
      where: this.scope({ testRunId }),
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  }

  /** The latest result of each run case: what a report shows next to the status. */
  async latestResults(runCaseIds: string[]): Promise<
    Map<
      string,
      {
        executedAt: Date;
        comment: string | null;
        executedById: string | null;
        elapsedSeconds: number | null;
      }
    >
  > {
    const result = new Map<
      string,
      {
        executedAt: Date;
        comment: string | null;
        executedById: string | null;
        elapsedSeconds: number | null;
      }
    >();
    if (runCaseIds.length === 0) {
      return result;
    }
    const rows = await this.prisma.testResult.findMany({
      where: this.scope({ testRunCaseId: { in: runCaseIds } }),
      orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
      select: {
        testRunCaseId: true,
        executedAt: true,
        comment: true,
        executedById: true,
        elapsedSeconds: true,
      },
    });
    for (const row of rows) {
      if (!result.has(row.testRunCaseId)) {
        result.set(row.testRunCaseId, row);
      }
    }
    return result;
  }

  /** Display names of members only; users of other organizations never resolve. */
  async memberNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const members = await this.prisma.organizationMember.findMany({
      where: this.scope({ userId: { in: userIds } }),
      select: { user: { select: { id: true, fullName: true } } },
    });
    return new Map(members.map((member) => [member.user.id, member.user.fullName]));
  }
}
