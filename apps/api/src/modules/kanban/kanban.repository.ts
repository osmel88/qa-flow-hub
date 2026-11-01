import { Injectable } from '@nestjs/common';
import { Prisma, WorkItem, WorkItemStatus } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

@Injectable()
export class KanbanRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async wipLimits(projectId: string, tx?: PrismaTransaction): Promise<Map<WorkItemStatus, number>> {
    const rows = await (tx ?? this.prisma).kanbanColumnSetting.findMany({
      where: this.scope({ projectId, wipLimit: { not: null } }),
      select: { status: true, wipLimit: true },
    });
    return new Map(
      rows
        .filter((row): row is { status: WorkItemStatus; wipLimit: number } => row.wipLimit !== null)
        .map((row) => [row.status, row.wipLimit]),
    );
  }

  async setWipLimit(
    projectId: string,
    status: WorkItemStatus,
    wipLimit: number | null,
    userId: string,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.kanbanColumnSetting.upsert({
      where: { projectId_status: { projectId, status } },
      create: {
        organizationId: this.organizationId,
        projectId,
        status,
        wipLimit,
        updatedById: userId,
      },
      update: { wipLimit, updatedById: userId },
    });
  }

  /** Live items of the board: every status but cancelled, done only inside the window. */
  boardItems(projectId: string, windowStart: Date, take: number): Promise<WorkItem[]> {
    return this.prisma.workItem.findMany({
      where: this.active({ projectId, ...onBoard(windowStart) }),
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /** Column sizes over every board item, ignoring filters and the board cap. */
  async columnCounts(
    projectId: string,
    windowStart: Date,
    tx?: PrismaTransaction,
  ): Promise<Map<WorkItemStatus, number>> {
    const rows = await (tx ?? this.prisma).workItem.groupBy({
      by: ['status'],
      where: this.active({ projectId, ...onBoard(windowStart) }),
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.status, row._count._all]));
  }

  countInStatus(projectId: string, status: WorkItemStatus, tx: PrismaTransaction): Promise<number> {
    return tx.workItem.count({ where: this.active({ projectId, status }) });
  }

  /** What flow metrics need: items in flight and items done in the window. */
  flowItems(projectId: string, windowStart: Date) {
    return this.prisma.workItem.findMany({
      where: this.active({
        projectId,
        OR: [
          {
            status: {
              in: [WorkItemStatus.in_progress, WorkItemStatus.blocked, WorkItemStatus.in_review],
            },
          },
          { status: WorkItemStatus.done, completedAt: { gte: windowStart } },
        ],
      }),
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        startedAt: true,
        completedAt: true,
      },
    });
  }
}

function onBoard(windowStart: Date): Prisma.WorkItemWhereInput {
  return {
    OR: [
      { status: { notIn: [WorkItemStatus.done, WorkItemStatus.cancelled] } },
      { status: WorkItemStatus.done, completedAt: { gte: windowStart } },
    ],
  };
}
