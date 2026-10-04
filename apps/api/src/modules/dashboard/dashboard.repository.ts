import { Injectable } from '@nestjs/common';
import {
  AuditLog,
  DefectStatus,
  Prisma,
  ProjectStatus,
  RequirementStatus,
  TestRun,
} from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface AuditFilters {
  action?: Prisma.AuditLogWhereInput['action'];
  entityType?: string;
  entityId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

interface GroupedCount {
  key: string;
  count: number;
}

/**
 * Aggregate reads. Every method is a `count` or a `groupBy`: the dashboard must
 * never load rows it only intends to count.
 */
@Injectable()
export class DashboardRepository extends TenantAwareRepository {
  constructor(
    private readonly database: PrismaService,
    tenant: TenantContextService,
  ) {
    super(database, tenant);
  }

  countProjects(archived: boolean): Promise<number> {
    return this.prisma.project.count({
      where: this.active({
        status: archived ? ProjectStatus.archived : ProjectStatus.active,
      }),
    });
  }

  async requirementsByStatus(projectId?: string): Promise<GroupedCount[]> {
    const rows = await this.prisma.requirement.groupBy({
      by: ['status'],
      where: this.active(projectId === undefined ? {} : { projectId }),
      _count: { _all: true },
    });
    return rows.map((row) => ({ key: row.status, count: row._count._all }));
  }

  async testCasesByStatus(projectId?: string): Promise<GroupedCount[]> {
    const rows = await this.prisma.testCase.groupBy({
      by: ['status'],
      where: this.active({
        ...(projectId === undefined ? {} : { projectId }),
        archivedAt: null,
      }),
      _count: { _all: true },
    });
    return rows.map((row) => ({ key: row.status, count: row._count._all }));
  }

  async runsByStatus(projectId?: string): Promise<GroupedCount[]> {
    const rows = await this.prisma.testRun.groupBy({
      by: ['status'],
      where: this.active(projectId === undefined ? {} : { projectId }),
      _count: { _all: true },
    });
    return rows.map((row) => ({ key: row.status, count: row._count._all }));
  }

  recentRuns(projectId?: string): Promise<TestRun[]> {
    return this.prisma.testRun.findMany({
      where: this.active(projectId === undefined ? {} : { projectId }),
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    });
  }

  /**
   * Current status of every case in every run: the projection on TestRunCase,
   * not a scan of the result history.
   */
  async resultsByStatus(projectId?: string): Promise<GroupedCount[]> {
    const rows = await this.prisma.testRunCase.groupBy({
      by: ['latestStatus'],
      where: this.scope(
        projectId === undefined ? {} : { testRun: { projectId, deletedAt: null } },
      ),
      _count: { _all: true },
    });
    return rows.map((row) => ({ key: row.latestStatus, count: row._count._all }));
  }

  /** Completion of several runs at once, grouped in a single query. */
  async completionOfRuns(testRunIds: string[]): Promise<Map<string, number>> {
    if (testRunIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.testRunCase.groupBy({
      by: ['testRunId', 'latestStatus'],
      where: this.scope({ testRunId: { in: testRunIds } }),
      _count: { _all: true },
    });

    const totals = new Map<string, { total: number; executed: number }>();
    for (const row of rows) {
      const current = totals.get(row.testRunId) ?? { total: 0, executed: 0 };
      current.total += row._count._all;
      if (row.latestStatus !== 'untested') {
        current.executed += row._count._all;
      }
      totals.set(row.testRunId, current);
    }

    return new Map(
      [...totals].map(([id, { total, executed }]) => [
        id,
        total === 0 ? 0 : Math.round((executed / total) * 1000) / 10,
      ]),
    );
  }

  async openDefectsBySeverity(projectId?: string): Promise<GroupedCount[]> {
    const rows = await this.prisma.defect.groupBy({
      by: ['severity'],
      where: this.active({
        ...(projectId === undefined ? {} : { projectId }),
        status: {
          in: [
            DefectStatus.open,
            DefectStatus.triaged,
            DefectStatus.in_progress,
            DefectStatus.resolved,
            DefectStatus.reopened,
          ],
        },
      }),
      _count: { _all: true },
    });
    return rows.map((row) => ({ key: row.severity, count: row._count._all }));
  }

  countRequirements(projectId?: string): Promise<number> {
    return this.prisma.requirement.count({
      where: this.active({
        ...(projectId === undefined ? {} : { projectId }),
        status: { not: RequirementStatus.obsolete },
      }),
    });
  }

  /** Active, non-obsolete requirements with at least one requirement → test case link, in one statement. */
  async countCoveredRequirements(projectId?: string): Promise<number> {
    const organizationId = this.organizationId;
    const projectFilter =
      projectId === undefined ? Prisma.empty : Prisma.sql`AND q."projectId" = ${projectId}`;
    const rows = await this.database.runInTransaction(
      (tx) => tx.$queryRaw<Array<{ covered: number }>>`
        SELECT COUNT(*)::int AS covered
        FROM requirements q
        WHERE q."organizationId" = ${organizationId}
          AND q."deletedAt" IS NULL
          AND q.status <> 'obsolete'
          ${projectFilter}
          AND EXISTS (
            SELECT 1 FROM traceability_links l
            WHERE l."organizationId" = ${organizationId}
              AND l."sourceType" = 'requirement' AND l."targetType" = 'test_case'
              AND l."sourceId" = q.id)`,
    );
    return rows[0]?.covered ?? 0;
  }

  async listAudit(query: PaginationQuery, filters: AuditFilters): Promise<Paginated<AuditLog>> {
    const where: Prisma.AuditLogWhereInput = this.scope({
      ...(filters.action === undefined ? {} : { action: filters.action }),
      ...(filters.entityType === undefined ? {} : { entityType: filters.entityType }),
      ...(filters.entityId === undefined ? {} : { entityId: filters.entityId }),
      ...(filters.userId === undefined ? {} : { userId: filters.userId }),
      ...(filters.from === undefined && filters.to === undefined
        ? {}
        : {
            createdAt: {
              ...(filters.from === undefined ? {} : { gte: filters.from }),
              ...(filters.to === undefined ? {} : { lte: filters.to }),
            },
          }),
    });

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...this.page(query),
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }
}
