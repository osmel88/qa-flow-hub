import { Injectable } from '@nestjs/common';
import { DevelopmentArtifact, Prisma, WorkItem, WorkItemDevelopmentLink } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export type LinkWithWorkItem = WorkItemDevelopmentLink & { workItem: WorkItem };
export type LinkWithArtifact = WorkItemDevelopmentLink & { artifact: DevelopmentArtifact };

export interface ArtifactFilters {
  projectId: string;
  kind?: DevelopmentArtifact['kind'] | undefined;
  provider?: DevelopmentArtifact['provider'] | undefined;
  status?: string | undefined;
  /** An id, or `null` for artifacts linked to no live work item. */
  workItemId?: string | null | undefined;
  search?: string | undefined;
}

interface LockedRow {
  id: string;
  projectId: string;
  key: string;
}

/** Development artifacts and their links to work items (S5-F1). */
@Injectable()
export class DevelopmentRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findArtifact(id: string, tx?: PrismaTransaction): Promise<DevelopmentArtifact | null> {
    return (tx ?? this.prisma).developmentArtifact.findFirst({ where: this.active({ id }) });
  }

  /**
   * Locks a live artifact: `share` for links (a concurrent soft delete waits),
   * `update` for edits and deletion.
   */
  async lockArtifact(
    id: string,
    mode: 'share' | 'update',
    tx: PrismaTransaction,
  ): Promise<DevelopmentArtifact | null> {
    if (mode === 'share') {
      await tx.$queryRaw`
        SELECT "id" FROM "development_artifacts"
        WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
        FOR SHARE`;
    } else {
      await tx.$queryRaw`
        SELECT "id" FROM "development_artifacts"
        WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
        FOR UPDATE`;
    }
    return this.findArtifact(id, tx);
  }

  /** Share-locks live work items of one project in id order; foreign ids are absent. */
  lockWorkItems(projectId: string, ids: readonly string[], tx: PrismaTransaction) {
    if (ids.length === 0) {
      return Promise.resolve<LockedRow[]>([]);
    }
    return tx.$queryRaw<LockedRow[]>`
      SELECT "id", "projectId", "key" FROM "work_items"
      WHERE "id" IN (${Prisma.join([...ids])})
        AND "organizationId" = ${this.organizationId}
        AND "projectId" = ${projectId}
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR SHARE`;
  }

  async lockWorkItem(id: string, tx: PrismaTransaction): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT "id", "projectId", "key" FROM "work_items"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR SHARE`;
    return rows[0] ?? null;
  }

  findWorkItem(id: string): Promise<WorkItem | null> {
    return this.prisma.workItem.findFirst({ where: this.active({ id }) });
  }

  create(
    data: Omit<Prisma.DevelopmentArtifactUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<DevelopmentArtifact> {
    return tx.developmentArtifact.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async update(
    id: string,
    data: Prisma.DevelopmentArtifactUncheckedUpdateManyInput,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.developmentArtifact.updateMany({
      where: this.active({ id }),
      data: { ...data, version: { increment: 1 } },
    });
  }

  async softDelete(id: string, tx: PrismaTransaction): Promise<boolean> {
    const { count } = await tx.developmentArtifact.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    return count === 1;
  }

  /** Inserts unless the link exists; true when a row was created. */
  async insertLinks(
    projectId: string,
    artifactId: string,
    workItemIds: readonly string[],
    createdById: string,
    tx: PrismaTransaction,
  ): Promise<number> {
    if (workItemIds.length === 0) {
      return 0;
    }
    const { count } = await tx.workItemDevelopmentLink.createMany({
      data: workItemIds.map((workItemId) => ({
        organizationId: this.organizationId,
        projectId,
        artifactId,
        workItemId,
        createdById,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  findLink(
    workItemId: string,
    artifactId: string,
    tx: PrismaTransaction,
  ): Promise<WorkItemDevelopmentLink | null> {
    return tx.workItemDevelopmentLink.findFirst({
      where: { organizationId: this.organizationId, workItemId, artifactId },
    });
  }

  async removeLink(
    workItemId: string,
    artifactId: string,
    tx: PrismaTransaction,
  ): Promise<string | null> {
    const existing = await this.findLink(workItemId, artifactId, tx);
    if (existing === null) {
      return null;
    }
    const { count } = await tx.workItemDevelopmentLink.deleteMany({
      where: { organizationId: this.organizationId, id: existing.id },
    });
    return count === 1 ? existing.id : null;
  }

  /** Links of these artifacts to live work items, in backlog order. */
  linksOfArtifacts(artifactIds: readonly string[]): Promise<LinkWithWorkItem[]> {
    if (artifactIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.workItemDevelopmentLink.findMany({
      where: {
        organizationId: this.organizationId,
        artifactId: { in: [...artifactIds] },
        workItem: { deletedAt: null },
      },
      include: { workItem: true },
      orderBy: [{ workItem: { rank: 'asc' } }, { id: 'asc' }],
    });
  }

  /** Live artifacts of a work item, newest activity first. */
  linksOfWorkItem(workItemId: string): Promise<LinkWithArtifact[]> {
    return this.prisma.workItemDevelopmentLink.findMany({
      where: {
        organizationId: this.organizationId,
        workItemId,
        artifact: { deletedAt: null },
      },
      include: { artifact: true },
      orderBy: [
        { artifact: { occurredAt: { sort: 'desc', nulls: 'last' } } },
        { createdAt: 'desc' },
      ],
    });
  }

  async list(
    query: PaginationQuery,
    filters: ArtifactFilters,
  ): Promise<Paginated<DevelopmentArtifact>> {
    const where: Prisma.DevelopmentArtifactWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.kind === undefined ? {} : { kind: filters.kind }),
      ...(filters.provider === undefined ? {} : { provider: filters.provider }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.workItemId === undefined
        ? {}
        : filters.workItemId === null
          ? { links: { none: { workItem: { deletedAt: null } } } }
          : { links: { some: { workItemId: filters.workItemId, workItem: { deletedAt: null } } } }),
      ...(filters.search === undefined
        ? {}
        : {
            OR: [
              { title: { contains: filters.search, mode: 'insensitive' as const } },
              { naturalKey: { contains: filters.search, mode: 'insensitive' as const } },
              { externalId: { contains: filters.search, mode: 'insensitive' as const } },
              { environment: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }),
    });
    const [data, total] = await Promise.all([
      this.prisma.developmentArtifact.findMany({
        where,
        orderBy: [
          { occurredAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        ...this.page(query),
      }),
      this.prisma.developmentArtifact.count({ where }),
    ]);
    return { data, meta: buildPaginationMeta(query, total) };
  }
}
