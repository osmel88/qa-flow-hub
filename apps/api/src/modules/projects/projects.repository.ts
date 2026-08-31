import { Injectable } from '@nestjs/common';
import { Prisma, Project, ProjectStatus } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface ProjectFilters {
  status?: ProjectStatus;
  search?: string;
}

/**
 * The first tenant-scoped repository, and the template for the rest.
 *
 * Note what is *not* here: no method accepts an `organizationId` argument. The
 * organization comes from the request context through `scope()`/`active()`, so
 * a caller cannot pass the wrong one, and a caller cannot forget to pass it.
 */
@Injectable()
export class ProjectsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  async findById(id: string): Promise<Project | null> {
    return this.prisma.project.findFirst({ where: this.active({ id }) });
  }

  async findByKey(key: string): Promise<Project | null> {
    return this.prisma.project.findFirst({ where: this.active({ key }) });
  }

  async list(query: PaginationQuery, filters: ProjectFilters = {}): Promise<Paginated<Project>> {
    const where: Prisma.ProjectWhereInput = this.active({
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
              { key: { contains: filters.search.toUpperCase() } },
            ],
          }),
    });

    const [data, total] = await Promise.all([
      this.prisma.project.findMany({ where, orderBy: { createdAt: 'desc' }, ...this.page(query) }),
      this.prisma.project.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  async create(
    data: Omit<Prisma.ProjectUncheckedCreateInput, 'organizationId'>,
    tx?: PrismaTransaction,
  ): Promise<Project> {
    const client = tx ?? this.prisma;
    return client.project.create({ data: { ...data, organizationId: this.organizationId } });
  }

  /**
   * Updates are expressed as `updateMany` with the tenant filter rather than
   * `update({ where: { id } })`. `update` by primary key would happily modify
   * another organization's row; `updateMany` cannot, because the filter is part
   * of the statement. The count tells the service whether the row existed
   * *within this organization*.
   */
  async update(id: string, data: Prisma.ProjectUpdateInput): Promise<Project | null> {
    const { count } = await this.prisma.project.updateMany({ where: this.active({ id }), data });
    return count === 0 ? null : this.findById(id);
  }

  /** Soft delete: history and audit entries keep pointing at a real row. */
  async softDelete(id: string): Promise<boolean> {
    const { count } = await this.prisma.project.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Reserves the next value of a per-project counter and returns the
   * human-readable key (WEB-R-14).
   *
   * The increment and the read happen in one statement, so two concurrent
   * requests cannot be handed the same number. Callers pass their transaction
   * so the reservation rolls back with the entity it was for.
   */
  async nextKey(
    projectId: string,
    counter: 'requirementCounter' | 'testCaseCounter' | 'defectCounter',
    infix: 'R' | 'C' | 'D',
    tx: PrismaTransaction,
  ): Promise<string> {
    const project = await tx.project.update({
      where: { id: projectId, organizationId: this.organizationId },
      data: { [counter]: { increment: 1 } },
      select: { key: true, requirementCounter: true, testCaseCounter: true, defectCounter: true },
    });

    return `${project.key}-${infix}-${project[counter]}`;
  }
}
