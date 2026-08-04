import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Requirement,
  RequirementStatus,
  TestCase,
  TestResultStatus,
} from '@prisma/client';
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

  /** Entity existence check for a link, one query per type. */
  async entityExists(type: Prisma.TraceabilityLinkWhereInput['sourceType'], id: string): Promise<boolean> {
    const where = this.scope({ id });

    switch (type) {
      case 'requirement':
        return (await this.prisma.requirement.count({ where })) > 0;
      case 'test_case':
        return (await this.prisma.testCase.count({ where })) > 0;
      case 'test_run':
        return (await this.prisma.testRun.count({ where })) > 0;
      case 'test_result':
        return (await this.prisma.testResult.count({ where })) > 0;
      case 'defect':
        return (await this.prisma.defect.count({ where })) > 0;
      case 'project':
        return (await this.prisma.project.count({ where })) > 0;
      // An automated test is not a row here yet: it lives in the customer's CI
      // and is only identified by an ExternalReference.
      default:
        return true;
    }
  }
}
