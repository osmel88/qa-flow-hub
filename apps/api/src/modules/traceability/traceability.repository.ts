import { Injectable } from '@nestjs/common';
import { Prisma, Requirement, RequirementStatus, TestCase, TestResultStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface CaseExecutionStatus {
  testCaseId: string;
  latestStatus: TestResultStatus;
}

/**
 * Read-only queries that cross module boundaries. The matrix needs
 * requirements, cases and execution status together; loading them through each
 * owning service would be N+1 dressed up as good manners.
 */
@Injectable()
export class TraceabilityRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  listRequirements(projectId: string): Promise<Requirement[]> {
    return this.prisma.requirement.findMany({
      where: this.active({ projectId, status: { not: RequirementStatus.obsolete } }),
      orderBy: { key: 'asc' },
    });
  }

  listCasesByIds(ids: string[]): Promise<TestCase[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.testCase.findMany({ where: this.active({ id: { in: ids } }) });
  }

  countCases(projectId: string): Promise<number> {
    return this.prisma.testCase.count({ where: this.active({ projectId }) });
  }

  /**
   * The most recent execution of each case, whichever run it happened in.
   * Ordered ascending so that the last write into the map wins.
   */
  async latestStatusByCase(testCaseIds: string[]): Promise<Map<string, TestResultStatus>> {
    if (testCaseIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.testRunCase.findMany({
      where: this.scope({
        testCaseId: { in: testCaseIds },
        latestStatus: { not: TestResultStatus.untested },
      }),
      select: { testCaseId: true, latestStatus: true, updatedAt: true },
      orderBy: { updatedAt: 'asc' },
    });

    return new Map(rows.map((row) => [row.testCaseId, row.latestStatus]));
  }

  /**
   * Locates one end of a link: does the entity exist in this organization, and
   * which project does it belong to?
   *
   * Existence and project come from the same query because both answers are
   * needed for every end of every link — existence to reject a dangling link,
   * the project to check the role the caller holds *there*. `null` means "no
   * such entity here", and a `projectId` of `null` means the type has no
   * project (an automated test lives in the customer's CI and is identified by
   * an ExternalReference).
   *
   * "Exists" means **not deleted**: soft-deleted rows are invisible everywhere
   * else, so accepting one here would be the only way in the product to create a
   * link that is dangling the moment it is written. Archived is different and
   * deliberately allowed — an archived case can be restored, and its link is
   * what makes the coverage come back with it.
   */
  async locateEntity(
    type: Prisma.TraceabilityLinkWhereInput['sourceType'],
    id: string,
  ): Promise<{ projectId: string | null } | null> {
    const where = this.active({ id });
    const select = { projectId: true };

    switch (type) {
      case 'requirement':
        return this.prisma.requirement.findFirst({ where, select });
      case 'test_case':
        return this.prisma.testCase.findFirst({ where, select });
      case 'test_run':
        return this.prisma.testRun.findFirst({ where, select });
      case 'test_result': {
        // A result carries no project of its own; the run it belongs to does,
        // and a result whose run is gone is unreachable, so the run has to be
        // alive as well.
        const result = await this.prisma.testResult.findFirst({
          where: this.scope({ id }),
          select: { testRun: { select: { projectId: true, deletedAt: true } } },
        });
        return result === null || result.testRun.deletedAt !== null
          ? null
          : { projectId: result.testRun.projectId };
      }
      case 'defect':
        return this.prisma.defect.findFirst({ where, select });
      case 'project': {
        const project = await this.prisma.project.findFirst({ where, select: { id: true } });
        return project === null ? null : { projectId: project.id };
      }
      default:
        return { projectId: null };
    }
  }
}
