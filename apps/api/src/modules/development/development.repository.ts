import { Injectable } from '@nestjs/common';
import {
  DevelopmentArtifact,
  Prisma,
  WorkItem,
  WorkItemDevelopmentLink,
  WorkItemStatus,
} from '@prisma/client';
import {
  DevelopmentSignal,
  Paginated,
  PaginationQuery,
  buildPaginationMeta,
} from '@qa-flow-hub/shared';
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
  /** Builds (S5-F4). */
  branchName?: string | undefined;
  /** A release id, or `null` for builds of no release. */
  releaseId?: string | null | undefined;
  /** Deployments (S5-F5). */
  environmentId?: string | undefined;
  buildId?: string | undefined;
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
      FOR UPDATE`;
  }

  async lockWorkItem(id: string, tx: PrismaTransaction): Promise<LockedRow | null> {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT "id", "projectId", "key" FROM "work_items"
      WHERE "id" = ${id} AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR UPDATE`;
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
      ...(filters.branchName === undefined ? {} : { branchName: filters.branchName }),
      ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      ...(filters.environmentId === undefined ? {} : { environmentId: filters.environmentId }),
      ...(filters.buildId === undefined ? {} : { buildId: filters.buildId }),
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

  /** Live work items linked to an artifact, locked in id order (artifact edits). */
  async lockLinkedWorkItems(artifactId: string, tx: PrismaTransaction): Promise<LockedRow[]> {
    return tx.$queryRaw<LockedRow[]>`
      SELECT w."id", w."projectId", w."key" FROM "work_items" w
      JOIN "work_item_development_links" l ON l."workItemId" = w."id"
      WHERE l."artifactId" = ${artifactId}
        AND w."organizationId" = ${this.organizationId}
        AND w."deletedAt" IS NULL
      ORDER BY w."id"
      FOR UPDATE OF w`;
  }

  /** Live artifacts linked to each of these work items, as derivation signals. */
  async signals(
    workItemIds: readonly string[],
    tx?: PrismaTransaction,
  ): Promise<Map<string, DevelopmentSignal[]>> {
    const result = new Map<string, DevelopmentSignal[]>();
    if (workItemIds.length === 0) {
      return result;
    }
    const rows = await (tx ?? this.prisma).workItemDevelopmentLink.findMany({
      where: {
        organizationId: this.organizationId,
        workItemId: { in: [...workItemIds] },
        artifact: { deletedAt: null },
      },
      select: {
        workItemId: true,
        artifact: {
          select: { id: true, kind: true, status: true, occurredAt: true, createdAt: true },
        },
      },
    });
    for (const row of rows) {
      const list = result.get(row.workItemId) ?? [];
      list.push({
        id: row.artifact.id,
        kind: row.artifact.kind,
        status: row.artifact.status,
        occurredAt: row.artifact.occurredAt?.toISOString() ?? null,
        createdAt: row.artifact.createdAt.toISOString(),
      });
      result.set(row.workItemId, list);
    }
    for (const review of await this.reviewSignals(workItemIds, tx)) {
      const list = result.get(review.workItemId) ?? [];
      list.push({
        id: review.id,
        kind: 'pull_request',
        status: review.status === 'approved' ? 'approved' : 'open',
        occurredAt: review.updatedAt.toISOString(),
        createdAt: review.createdAt.toISOString(),
        source: 'code_review',
      });
      result.set(review.workItemId, list);
    }
    return result;
  }

  /**
   * Live, not dismissed code reviews of these work items, linked directly or
   * through a live pull request linked to the item (S5-F3).
   */
  private async reviewSignals(
    workItemIds: readonly string[],
    tx?: PrismaTransaction,
  ): Promise<
    Array<{ workItemId: string; id: string; status: string; updatedAt: Date; createdAt: Date }>
  > {
    const client = tx ?? this.prisma;
    const live = { deletedAt: null, status: { not: 'dismissed' as const } };
    const ids = [...workItemIds];
    const [direct, viaPullRequest] = await Promise.all([
      client.codeReviewWorkItem.findMany({
        where: { organizationId: this.organizationId, workItemId: { in: ids }, review: live },
        select: { workItemId: true, review: true },
      }),
      client.codeReview.findMany({
        where: {
          organizationId: this.organizationId,
          ...live,
          pullRequest: { deletedAt: null, links: { some: { workItemId: { in: ids } } } },
        },
        include: { pullRequest: { include: { links: { where: { workItemId: { in: ids } } } } } },
      }),
    ]);
    const seen = new Set<string>();
    const result: Array<{
      workItemId: string;
      id: string;
      status: string;
      updatedAt: Date;
      createdAt: Date;
    }> = [];
    const add = (
      workItemId: string,
      review: { id: string; status: string; updatedAt: Date; createdAt: Date },
    ) => {
      const key = `${workItemId}:${review.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          workItemId,
          id: review.id,
          status: review.status,
          updatedAt: review.updatedAt,
          createdAt: review.createdAt,
        });
      }
    };
    for (const row of direct) {
      add(row.workItemId, row.review);
    }
    for (const review of viaPullRequest) {
      for (const link of review.pullRequest?.links ?? []) {
        add(link.workItemId, review);
      }
    }
    return result;
  }

  /** Live work items of a project that have at least one live artifact. */
  async linkedWorkItemIds(projectId: string): Promise<string[]> {
    const rows = await this.prisma.workItemDevelopmentLink.findMany({
      where: {
        organizationId: this.organizationId,
        projectId,
        artifact: { deletedAt: null },
        workItem: { deletedAt: null },
      },
      select: { workItemId: true },
      distinct: ['workItemId'],
    });
    return rows.map((row) => row.workItemId);
  }

  /** Live, not cancelled work item ids of a project (development summary). */
  async openWorkItemIds(projectId: string): Promise<string[]> {
    const rows = await this.prisma.workItem.findMany({
      where: this.active({ projectId, status: { not: WorkItemStatus.cancelled } }),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async artifactCounts(projectId: string): Promise<Map<DevelopmentArtifact['kind'], number>> {
    const rows = await this.prisma.developmentArtifact.groupBy({
      by: ['kind'],
      where: this.active({ projectId }),
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.kind, row._count._all]));
  }

  // --- Builds (S5-F4) --------------------------------------------------------

  findBuildByExternalId(
    projectId: string,
    provider: DevelopmentArtifact['provider'],
    externalId: string,
  ): Promise<DevelopmentArtifact | null> {
    return this.prisma.developmentArtifact.findFirst({
      where: this.active({ projectId, provider, kind: 'build' as const, externalId }),
    });
  }

  /** A release of the project, locked for share so it cannot move meanwhile. */
  async lockRelease(projectId: string, id: string, tx: PrismaTransaction): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "releases"
      WHERE "id" = ${id} AND "projectId" = ${projectId} AND "organizationId" = ${this.organizationId}
      FOR SHARE`;
    return rows.length === 1;
  }

  releases(ids: readonly string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.release.findMany({
      where: { organizationId: this.organizationId, id: { in: [...ids] } },
      select: { id: true, name: true, version: true },
    });
  }

  /** Live branch and commit artifacts matching these names and SHAs. */
  relatedArtifacts(
    projectId: string,
    branchNames: readonly string[],
    commitShas: readonly string[],
  ) {
    if (branchNames.length === 0 && commitShas.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.developmentArtifact.findMany({
      where: this.active({
        projectId,
        OR: [
          { kind: 'branch' as const, branchName: { in: [...branchNames] } },
          { kind: 'commit' as const, commitSha: { in: [...commitShas] } },
        ],
      }),
      select: { id: true, kind: true, branchName: true, commitSha: true, provider: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  buildRows(
    projectId: string,
    filters: { branchName?: string | undefined; releaseId?: string | undefined; since: Date },
  ) {
    return this.prisma.developmentArtifact.findMany({
      where: this.active({
        projectId,
        kind: 'build' as const,
        createdAt: { gte: filters.since },
        ...(filters.branchName === undefined ? {} : { branchName: filters.branchName }),
        ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      }),
      select: { status: true, startedAt: true, finishedAt: true },
    });
  }

  // --- Deployments and environments (S5-F5) -----------------------------------

  findDeploymentByExternalId(
    projectId: string,
    provider: DevelopmentArtifact['provider'],
    externalId: string,
  ): Promise<DevelopmentArtifact | null> {
    return this.prisma.developmentArtifact.findFirst({
      where: this.active({ projectId, provider, kind: 'deployment' as const, externalId }),
    });
  }

  /** A live environment of the project, locked for share. */
  async lockEnvironment(projectId: string, id: string, tx: PrismaTransaction) {
    const rows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT "id", "name" FROM "environments"
      WHERE "id" = ${id} AND "projectId" = ${projectId} AND "organizationId" = ${this.organizationId}
        AND "deletedAt" IS NULL
      FOR SHARE`;
    return rows[0] ?? null;
  }

  /** A live build of the project, locked for share. */
  async lockBuild(projectId: string, id: string, tx: PrismaTransaction) {
    const rows = await tx.$queryRaw<Array<{ id: string; commitSha: string | null }>>`
      SELECT "id", "commitSha" FROM "development_artifacts"
      WHERE "id" = ${id} AND "projectId" = ${projectId} AND "kind" = 'build'
        AND "organizationId" = ${this.organizationId} AND "deletedAt" IS NULL
      FOR SHARE`;
    return rows[0] ?? null;
  }

  environments(projectId: string) {
    return this.prisma.environment.findMany({
      where: this.active({ projectId }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  environmentsByIds(ids: readonly string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.environment.findMany({
      where: { organizationId: this.organizationId, id: { in: [...ids] } },
    });
  }

  createEnvironment(
    data: { projectId: string; name: string; kind: string; createdById: string },
    tx: PrismaTransaction,
  ) {
    return tx.environment.create({ data: { ...data, organizationId: this.organizationId } });
  }

  artifactsByIds(ids: readonly string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.developmentArtifact.findMany({
      where: { organizationId: this.organizationId, id: { in: [...ids] }, deletedAt: null },
      select: { id: true, identifier: true, status: true, rollbackOfId: true },
    });
  }

  rollbacksOf(ids: readonly string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.developmentArtifact.findMany({
      where: this.active({ rollbackOfId: { in: [...ids] } }),
      select: { id: true, identifier: true, rollbackOfId: true },
    });
  }

  /** Newest live succeeded deployment per environment, for "what runs there". */
  currentDeployments(projectId: string) {
    return this.prisma.developmentArtifact.findMany({
      where: this.active({ projectId, kind: 'deployment' as const, status: 'succeeded' }),
      orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      select: { id: true, identifier: true, buildId: true, environmentId: true },
    });
  }

  /** The succeeded or rolled-back deployment that ran in the environment before this one. */
  previousDeployment(projectId: string, environmentId: string, before: Date, excludeId: string) {
    return this.prisma.developmentArtifact.findFirst({
      where: this.active({
        projectId,
        kind: 'deployment' as const,
        environmentId,
        id: { not: excludeId },
        status: { in: ['succeeded', 'rolled_back'] },
        createdAt: { lt: before },
        buildId: { not: null },
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { buildId: true },
    });
  }

  deploymentRows(
    projectId: string,
    filters: { environmentId?: string | undefined; releaseId?: string | undefined; since: Date },
  ) {
    return this.prisma.developmentArtifact.findMany({
      where: this.active({
        projectId,
        kind: 'deployment' as const,
        createdAt: { gte: filters.since },
        ...(filters.environmentId === undefined ? {} : { environmentId: filters.environmentId }),
        ...(filters.releaseId === undefined ? {} : { releaseId: filters.releaseId }),
      }),
      select: { status: true, startedAt: true, finishedAt: true, rollbackOfId: true },
    });
  }

  users(ids: readonly string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, fullName: true },
    });
  }
}
