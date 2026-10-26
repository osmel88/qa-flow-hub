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

  /**
   * Serialises every change to the order of a project's backlog (creation,
   * moves, renumbering). Taken after the tree lock and before row locks.
   */
  async lockBacklog(projectId: string, tx: PrismaTransaction): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-item-backlog:${projectId}`}, 0))`;
  }

  async maxRank(projectId: string, tx: PrismaTransaction): Promise<number | null> {
    const row = await tx.workItem.aggregate({
      where: this.active({ projectId }),
      _max: { rank: true },
    });
    return row._max.rank;
  }

  /** The live neighbour just above (`below = false`) or below a rank, skipping one item. */
  neighbour(
    projectId: string,
    rank: number,
    direction: 'above' | 'below',
    excludeId: string,
    tx: PrismaTransaction,
  ): Promise<WorkItem | null> {
    return tx.workItem.findFirst({
      where: this.active({
        projectId,
        id: { not: excludeId },
        rank: direction === 'above' ? { lt: rank } : { gt: rank },
      }),
      orderBy: [{ rank: direction === 'above' ? 'desc' : 'asc' }, { id: 'asc' }],
    });
  }

  /** Position only: a move is not an edit of the item, so `version` stays. */
  async setRank(id: string, rank: number, tx: PrismaTransaction): Promise<void> {
    await tx.workItem.updateMany({ where: this.active({ id }), data: { rank } });
  }

  /** Spreads the live items of a project back to steps of `step`, keeping their order. */
  async renumber(projectId: string, step: number, tx: PrismaTransaction): Promise<void> {
    await tx.$executeRaw`
      UPDATE "work_items" AS w
      SET "rank" = ranked.position * ${step}
      FROM (
        SELECT "id", ROW_NUMBER() OVER (ORDER BY "rank", "createdAt", "id") AS position
        FROM "work_items"
        WHERE "organizationId" = ${this.organizationId}
          AND "projectId" = ${projectId}
          AND "deletedAt" IS NULL
      ) AS ranked
      WHERE w."id" = ranked."id"`;
  }

  /**
   * Locks a set of live items of one project in id order (so two bulk edits
   * never deadlock) and returns them; missing, deleted or foreign ids are
   * simply absent from the result.
   */
  async lockMany(
    projectId: string,
    ids: readonly string[],
    tx: PrismaTransaction,
  ): Promise<WorkItem[]> {
    await tx.$queryRaw`
      SELECT "id" FROM "work_items"
      WHERE "id" IN (${Prisma.join([...ids])})
        AND "organizationId" = ${this.organizationId}
        AND "projectId" = ${projectId}
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR UPDATE`;
    return tx.workItem.findMany({
      where: this.active({ projectId, id: { in: [...ids] } }),
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
    });
  }

  backlog(where: Prisma.WorkItemWhereInput, take: number): Promise<WorkItem[]> {
    return this.prisma.workItem.findMany({
      where: this.active(where),
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /** Every live item of a project, reduced to what grouping needs. */
  hierarchy(projectId: string): Promise<WorkItemSummary[]> {
    return this.prisma.workItem.findMany({
      where: this.active({ projectId }),
      select: { id: true, key: true, title: true, type: true, status: true, parentId: true },
    });
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
