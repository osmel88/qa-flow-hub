import { Injectable } from '@nestjs/common';
import {
  ImportJob,
  ImportJobStatus,
  Prisma,
  Requirement,
  TestCase,
  TestSection,
  TestSuite,
} from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type ExistingCaseTitle = Pick<TestCase, 'id' | 'suiteId' | 'sectionId' | 'title'>;

/**
 * Persistence of import jobs and the bulk writes of a commit. Every read is
 * scoped to the current organization and, under RLS, to its rows only; every
 * write sets `organizationId` from the tenant context, never from the file.
 */
@Injectable()
export class ImportsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  createJob(
    data: Omit<Prisma.ImportJobUncheckedCreateInput, 'organizationId'>,
  ): Promise<ImportJob> {
    return this.prisma.importJob.create({ data: { ...data, organizationId: this.organizationId } });
  }

  findJob(projectId: string, id: string, tx?: PrismaTransaction): Promise<ImportJob | null> {
    return (tx ?? this.prisma).importJob.findFirst({ where: this.scope({ id, projectId }) });
  }

  listJobs(projectId: string, take: number): Promise<ImportJob[]> {
    return this.prisma.importJob.findMany({
      where: this.scope({ projectId }),
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Lazy expiry: jobs past their TTL lose their plan, the history row stays. */
  async expireStale(projectId: string, now: Date): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: this.scope({ projectId, status: ImportJobStatus.ready, expiresAt: { lt: now } }),
      data: { status: ImportJobStatus.expired, plan: Prisma.DbNull },
    });
  }

  /** Keeps at most `keep` ready jobs per project, expiring the oldest ones. */
  async expireOldestReady(projectId: string, keep: number): Promise<void> {
    const surplus = await this.prisma.importJob.findMany({
      where: this.scope({ projectId, status: ImportJobStatus.ready }),
      orderBy: { createdAt: 'desc' },
      skip: keep,
      select: { id: true },
    });
    if (surplus.length === 0) {
      return;
    }
    await this.prisma.importJob.updateMany({
      where: this.scope({
        id: { in: surplus.map((job) => job.id) },
        status: ImportJobStatus.ready,
      }),
      data: { status: ImportJobStatus.expired, plan: Prisma.DbNull },
    });
  }

  async markExpired(id: string): Promise<void> {
    await this.prisma.importJob.updateMany({
      where: this.scope({ id, status: ImportJobStatus.ready }),
      data: { status: ImportJobStatus.expired, plan: Prisma.DbNull },
    });
  }

  /** Conditional on `ready`, so of two concurrent commits only one can flip it. */
  async markCommitted(
    id: string,
    summary: Prisma.InputJsonValue,
    tx: PrismaTransaction,
  ): Promise<boolean> {
    const { count } = await tx.importJob.updateMany({
      where: this.scope({ id, status: ImportJobStatus.ready }),
      data: {
        status: ImportJobStatus.committed,
        committedAt: new Date(),
        plan: Prisma.DbNull,
        summary,
      },
    });
    return count === 1;
  }

  /**
   * Serializes imports into one project: two commits planning the same new
   * section, or reserving keys at once, run one after the other.
   */
  async lockProject(projectId: string, tx: PrismaTransaction): Promise<void> {
    const key = `import:${this.organizationId}:${projectId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  findSuiteById(projectId: string, id: string, tx?: PrismaTransaction): Promise<TestSuite | null> {
    return (tx ?? this.prisma).testSuite.findFirst({ where: this.active({ id, projectId }) });
  }

  /** Deleted suites included: their name stays taken by the unique index. */
  findSuitesByName(
    projectId: string,
    names: string[],
    tx?: PrismaTransaction,
  ): Promise<TestSuite[]> {
    if (names.length === 0) {
      return Promise.resolve([]);
    }
    return (tx ?? this.prisma).testSuite.findMany({
      where: this.scope({ projectId, name: { in: names } }),
    });
  }

  listSections(suiteIds: string[], tx?: PrismaTransaction): Promise<TestSection[]> {
    if (suiteIds.length === 0) {
      return Promise.resolve([]);
    }
    return (tx ?? this.prisma).testSection.findMany({
      where: this.active({ suiteId: { in: suiteIds } }),
    });
  }

  /** Archived cases count: importing a copy of an archived case is a duplicate too. */
  listCaseTitles(
    projectId: string,
    suiteIds: string[],
    tx?: PrismaTransaction,
  ): Promise<ExistingCaseTitle[]> {
    if (suiteIds.length === 0) {
      return Promise.resolve([]);
    }
    return (tx ?? this.prisma).testCase.findMany({
      where: this.active({ projectId, suiteId: { in: suiteIds } }),
      select: { id: true, suiteId: true, sectionId: true, title: true },
    });
  }

  findRequirementsByKey(
    projectId: string,
    keys: string[],
    tx?: PrismaTransaction,
  ): Promise<Pick<Requirement, 'id' | 'key'>[]> {
    if (keys.length === 0) {
      return Promise.resolve([]);
    }
    return (tx ?? this.prisma).requirement.findMany({
      where: this.active({ projectId, key: { in: keys } }),
      select: { id: true, key: true },
    });
  }

  createSuite(projectId: string, name: string, tx: PrismaTransaction): Promise<TestSuite> {
    return tx.testSuite.create({ data: { organizationId: this.organizationId, projectId, name } });
  }

  createSection(
    suiteId: string,
    parentId: string | null,
    name: string,
    tx: PrismaTransaction,
  ): Promise<TestSection> {
    return tx.testSection.create({
      data: { organizationId: this.organizationId, suiteId, parentId, name },
    });
  }

  /**
   * Reserves `count` consecutive case numbers in one statement. Inside the
   * commit transaction, so a rollback gives them back.
   */
  async reserveCaseKeys(
    projectId: string,
    count: number,
    tx: PrismaTransaction,
  ): Promise<{ projectKey: string; first: number }> {
    const project = await tx.project.update({
      where: { id: projectId, organizationId: this.organizationId },
      data: { testCaseCounter: { increment: count } },
      select: { key: true, testCaseCounter: true },
    });
    return { projectKey: project.key, first: project.testCaseCounter - count + 1 };
  }

  createCases(
    data: Array<Omit<Prisma.TestCaseCreateManyInput, 'organizationId'>>,
    tx: PrismaTransaction,
  ): Promise<Array<Pick<TestCase, 'id' | 'key'>>> {
    return tx.testCase.createManyAndReturn({
      data: data.map((row) => ({ ...row, organizationId: this.organizationId })),
      select: { id: true, key: true },
    });
  }

  async createSteps(
    data: Array<Omit<Prisma.TestStepCreateManyInput, 'organizationId'>>,
    tx: PrismaTransaction,
  ): Promise<void> {
    if (data.length > 0) {
      await tx.testStep.createMany({
        data: data.map((row) => ({ ...row, organizationId: this.organizationId })),
      });
    }
  }

  async createVerifiesLinks(
    pairs: Array<{ requirementId: string; testCaseId: string }>,
    createdById: string,
    tx: PrismaTransaction,
  ): Promise<void> {
    if (pairs.length === 0) {
      return;
    }
    await tx.traceabilityLink.createMany({
      data: pairs.map((pair) => ({
        organizationId: this.organizationId,
        sourceType: 'requirement' as const,
        sourceId: pair.requirementId,
        targetType: 'test_case' as const,
        targetId: pair.testCaseId,
        linkType: 'verifies' as const,
        createdById,
      })),
      skipDuplicates: true,
    });
  }
}
