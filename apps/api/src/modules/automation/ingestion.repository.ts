import { Injectable } from '@nestjs/common';
import { IngestionReport, Prisma, TestRunCase } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

@Injectable()
export class IngestionRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findReport(
    projectId: string,
    idempotencyKey: string,
    tx?: PrismaTransaction,
  ): Promise<(IngestionReport & { apiKey: { prefix: string } | null }) | null> {
    return (tx ?? this.prisma).ingestionReport.findFirst({
      where: this.scope({ projectId, idempotencyKey }),
      include: { apiKey: { select: { prefix: true } } },
    });
  }

  createReport(
    data: Omit<Prisma.IngestionReportUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<IngestionReport & { apiKey: { prefix: string } | null }> {
    return tx.ingestionReport.create({
      data: { ...data, organizationId: this.organizationId },
      include: { apiKey: { select: { prefix: true } } },
    });
  }

  listReports(
    projectId: string,
  ): Promise<Array<IngestionReport & { apiKey: { prefix: string } | null }>> {
    return this.prisma.ingestionReport.findMany({
      where: this.scope({ projectId }),
      include: { apiKey: { select: { prefix: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  runCases(testRunId: string, tx: PrismaTransaction): Promise<TestRunCase[]> {
    return tx.testRunCase.findMany({ where: this.scope({ testRunId }) });
  }

  async lockProject(projectId: string, tx: PrismaTransaction): Promise<void> {
    const key = `ingest:${projectId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}
