import { Injectable } from '@nestjs/common';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

/** Release-scoped reads of the readiness report (S7-F8) that no other module exposes. */
@Injectable()
export class ReleaseReadinessRepository extends TenantAwareRepository {
  constructor(db: PrismaService, tenant: TenantContextService) {
    super(db, tenant);
  }

  project(id: string, tx: PrismaTransaction) {
    return tx.project.findFirst({
      where: this.scope({ id }),
      select: { id: true, key: true, name: true },
    });
  }

  plans(projectId: string, releaseId: string, tx: PrismaTransaction) {
    return tx.testPlan.findMany({
      where: this.scope({ projectId, releaseId, archivedAt: null }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  }

  cycles(projectId: string, releaseId: string, tx: PrismaTransaction) {
    return tx.testCycle.findMany({
      where: this.scope({ projectId, releaseId, archivedAt: null }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  }

  sessions(projectId: string, releaseId: string, tx: PrismaTransaction) {
    return tx.exploratorySession.findMany({
      where: this.scope({ projectId, releaseId, archivedAt: null, status: { not: 'cancelled' } }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        status: true,
        findings: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, title: true, kind: true, defectId: true },
        },
      },
    });
  }
}
