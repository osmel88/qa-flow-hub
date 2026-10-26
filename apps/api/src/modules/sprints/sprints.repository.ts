import { Injectable } from '@nestjs/common';
import { Prisma, Sprint, SprintStatus, WorkItem } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface LockedSprint {
  id: string;
  projectId: string;
  status: SprintStatus;
  version: number;
}

@Injectable()
export class SprintsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findById(id: string, tx?: PrismaTransaction): Promise<Sprint | null> {
    return (tx ?? this.prisma).sprint.findFirst({ where: this.scope({ id }) });
  }

  async list(
    query: PaginationQuery,
    projectId: string,
    status: SprintStatus | undefined,
  ): Promise<Paginated<Sprint>> {
    const where: Prisma.SprintWhereInput = this.scope({
      projectId,
      ...(status === undefined ? {} : { status }),
    });
    const [data, total] = await Promise.all([
      this.prisma.sprint.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...this.page(query),
      }),
      this.prisma.sprint.count({ where }),
    ]);
    return { data, meta: buildPaginationMeta(query, total) };
  }

  /** The latest completed sprints of a project, newest first. */
  completed(projectId: string, take: number): Promise<Sprint[]> {
    return this.prisma.sprint.findMany({
      where: this.scope({ projectId, status: SprintStatus.completed }),
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  create(
    data: Omit<Prisma.SprintUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<Sprint> {
    return tx.sprint.create({ data: { ...data, organizationId: this.organizationId } });
  }

  /** Bumps `version`. */
  async update(
    id: string,
    data: Prisma.SprintUncheckedUpdateManyInput,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.sprint.updateMany({
      where: this.scope({ id }),
      data: { ...data, version: { increment: 1 } },
    });
  }

  /**
   * Status changes take `FOR UPDATE`; writes that only need the sprint to stay
   * open (planning items into it) take `FOR SHARE`. Several sprints are always
   * locked in id order so two requests never deadlock on each other.
   */
  async lock(
    ids: readonly string[],
    mode: 'share' | 'update',
    tx: PrismaTransaction,
  ): Promise<LockedSprint[]> {
    if (ids.length === 0) {
      return [];
    }
    const list = Prisma.join([...new Set(ids)].sort());
    return mode === 'update'
      ? tx.$queryRaw<LockedSprint[]>`
          SELECT "id", "projectId", "status", "version" FROM "sprints"
          WHERE "id" IN (${list}) AND "organizationId" = ${this.organizationId}
          ORDER BY "id" FOR UPDATE`
      : tx.$queryRaw<LockedSprint[]>`
          SELECT "id", "projectId", "status", "version" FROM "sprints"
          WHERE "id" IN (${list}) AND "organizationId" = ${this.organizationId}
          ORDER BY "id" FOR SHARE`;
  }

  /** Serialises sprint activation per project (backed by the partial unique index). */
  async lockActivation(projectId: string, tx: PrismaTransaction): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sprint-activation:${projectId}`}, 0))`;
  }

  findActive(projectId: string, tx: PrismaTransaction): Promise<Sprint | null> {
    return tx.sprint.findFirst({ where: this.scope({ projectId, status: SprintStatus.active }) });
  }

  /** Live items of a sprint in backlog order. */
  items(sprintId: string, tx?: PrismaTransaction): Promise<WorkItem[]> {
    return (tx ?? this.prisma).workItem.findMany({
      where: this.active({ sprintId }),
      orderBy: [{ rank: 'asc' }, { id: 'asc' }],
    });
  }

  /** Live items of a project, unlocked, to learn which sprints they are in. */
  peekItems(projectId: string, ids: readonly string[]): Promise<WorkItem[]> {
    return this.prisma.workItem.findMany({
      where: this.active({ projectId, id: { in: [...ids] } }),
    });
  }

  /** Locks live items of one project in id order; foreign or missing ids are absent. */
  async lockItems(
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

  /** Locks the live items of a sprint in id order. */
  async lockSprintItems(sprintId: string, tx: PrismaTransaction): Promise<WorkItem[]> {
    await tx.$queryRaw`
      SELECT "id" FROM "work_items"
      WHERE "sprintId" = ${sprintId} AND "organizationId" = ${this.organizationId}
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR UPDATE`;
    return this.items(sprintId, tx);
  }

  async setSprint(
    ids: readonly string[],
    sprintId: string | null,
    tx: PrismaTransaction,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await tx.workItem.updateMany({
      where: this.active({ id: { in: [...ids] } }),
      data: { sprintId, version: { increment: 1 } },
    });
  }
}
