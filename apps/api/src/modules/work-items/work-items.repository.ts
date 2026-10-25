import { Injectable } from '@nestjs/common';
import { Prisma, WorkItem, WorkItemStatus, WorkItemType } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface WorkItemFilters {
  projectId: string;
  type?: WorkItemType;
  status?: WorkItemStatus;
  priority?: Prisma.WorkItemWhereInput['priority'];
  /** `null` filters items without one. */
  assigneeId?: string | null;
  reporterId?: string;
  parentId?: string | null;
  releaseId?: string | null;
  label?: string;
  open?: boolean;
  search?: string;
}

export interface WorkItemSummary {
  id: string;
  key: string;
  title: string;
  type: WorkItemType;
  status: WorkItemStatus;
  parentId: string | null;
}

const CLOSED: WorkItemStatus[] = ['done', 'cancelled'];

@Injectable()
export class WorkItemsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findById(id: string, tx?: PrismaTransaction): Promise<WorkItem | null> {
    return (tx ?? this.prisma).workItem.findFirst({ where: this.active({ id }) });
  }

  /** Serialises every write to one item. */
  async lock(id: string, tx: PrismaTransaction): Promise<WorkItem | null> {
    await tx.$queryRaw`
      SELECT "id" FROM "work_items"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId}
      FOR UPDATE`;
    return this.findById(id, tx);
  }

  /**
   * Serialises every change to the shape of a project's tree (parent or type
   * changes, creation under a parent, deletion), so two concurrent moves can
   * never combine into an invalid hierarchy. Always taken before row locks.
   */
  async lockTree(projectId: string, tx: PrismaTransaction): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-item-tree:${projectId}`}, 0))`;
  }

  async list(query: PaginationQuery, filters: WorkItemFilters): Promise<Paginated<WorkItem>> {
    const where: Prisma.WorkItemWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.type === undefined ? {} : { type: filters.type }),
      ...(filters.priority === undefined ? {} : { priority: filters.priority }),
      ...(filters.assigneeId === undefined ? {} : { assigneeId: filters.assigneeId }),
      ...(filters.reporterId === undefined ? {} : { reporterId: filters.reporterId }),
      ...(filters.parentId === undefined ? {} : { parentId: filters.parentId }),
      ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      ...(filters.label === undefined ? {} : { labels: { has: filters.label } }),
      ...(filters.status !== undefined
        ? { status: filters.status }
        : filters.open === undefined
          ? {}
          : filters.open
            ? { status: { notIn: CLOSED } }
            : { status: { in: CLOSED } }),
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
      this.prisma.workItem.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...this.page(query),
      }),
      this.prisma.workItem.count({ where }),
    ]);
    return { data, meta: buildPaginationMeta(query, total) };
  }

  create(
    data: Omit<Prisma.WorkItemUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<WorkItem> {
    return tx.workItem.create({ data: { ...data, organizationId: this.organizationId } });
  }

  /** Bumps `version`; `null` when the row is gone. */
  async update(
    id: string,
    data: Prisma.WorkItemUncheckedUpdateManyInput,
    tx: PrismaTransaction,
  ): Promise<WorkItem | null> {
    const { count } = await tx.workItem.updateMany({
      where: this.active({ id }),
      data: { ...data, version: { increment: 1 } },
    });
    return count === 0 ? null : this.findById(id, tx);
  }

  async softDelete(id: string, tx: PrismaTransaction): Promise<boolean> {
    const { count } = await tx.workItem.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return count > 0;
  }

  children(id: string, tx?: PrismaTransaction): Promise<WorkItemSummary[]> {
    return (tx ?? this.prisma).workItem.findMany({
      where: this.active({ parentId: id }),
      select: { id: true, key: true, title: true, type: true, status: true, parentId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Root first. The ranked hierarchy bounds the walk to four levels. */
  async ancestors(item: Pick<WorkItem, 'parentId'>): Promise<WorkItemSummary[]> {
    const chain: WorkItemSummary[] = [];
    let parentId = item.parentId;
    while (parentId !== null && chain.length < 8) {
      const parent = await this.prisma.workItem.findFirst({
        where: this.active({ id: parentId }),
        select: { id: true, key: true, title: true, type: true, status: true, parentId: true },
      });
      if (parent === null) {
        break;
      }
      chain.unshift(parent);
      parentId = parent.parentId;
    }
    return chain;
  }
}
