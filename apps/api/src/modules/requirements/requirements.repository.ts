import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Requirement,
  RequirementStatus,
  RequirementType,
  RequirementVersion,
} from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface RequirementFilters {
  projectId: string;
  status?: RequirementStatus;
  type?: RequirementType;
  priority?: Prisma.RequirementWhereInput['priority'];
  tag?: string;
  search?: string;
}

@Injectable()
export class RequirementsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findById(id: string): Promise<Requirement | null> {
    return this.prisma.requirement.findFirst({ where: this.active({ id }) });
  }

  async list(
    query: PaginationQuery,
    filters: RequirementFilters,
  ): Promise<Paginated<Requirement>> {
    const where: Prisma.RequirementWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.type === undefined ? {} : { type: filters.type }),
      ...(filters.priority === undefined ? {} : { priority: filters.priority }),
      // `has` on a Postgres array column, not a LIKE over a joined string.
      ...(filters.tag === undefined ? {} : { tags: { has: filters.tag } }),
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
      this.prisma.requirement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...this.page(query),
      }),
      this.prisma.requirement.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  create(
    data: Omit<Prisma.RequirementUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<Requirement> {
    return tx.requirement.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(
    id: string,
    data: Prisma.RequirementUpdateInput,
    tx?: PrismaTransaction,
  ): Promise<Requirement | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.requirement.updateMany({ where: this.active({ id }), data });
    if (count === 0) {
      return null;
    }
    return client.requirement.findFirst({ where: this.active({ id }) });
  }

  async softDelete(id: string): Promise<boolean> {
    const { count } = await this.prisma.requirement.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Appends a version row. The version number comes from counting existing rows
   * inside the caller's transaction; the unique index on
   * `(requirementId, version)` is what actually prevents a duplicate if two
   * edits ever raced.
   */
  async appendVersion(
    requirementId: string,
    snapshot: Prisma.InputJsonValue,
    changedById: string | null,
    tx: PrismaTransaction,
  ): Promise<RequirementVersion> {
    const version = await tx.requirementVersion.count({ where: { requirementId } });
    return tx.requirementVersion.create({
      data: {
        organizationId: this.organizationId,
        requirementId,
        version: version + 1,
        snapshot,
        changedById,
      },
    });
  }

  listVersions(requirementId: string): Promise<RequirementVersion[]> {
    return this.prisma.requirementVersion.findMany({
      where: { organizationId: this.organizationId, requirementId },
      orderBy: { version: 'desc' },
    });
  }
}
