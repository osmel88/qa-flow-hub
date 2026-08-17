import { Injectable } from '@nestjs/common';
import { Defect, LinkableEntity, Prisma, TraceabilityLink } from '@prisma/client';
import { Paginated, PaginationQuery, buildPaginationMeta } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface DefectFilters {
  projectId: string;
  status?: Prisma.DefectWhereInput['status'];
  severity?: Prisma.DefectWhereInput['severity'];
  priority?: Prisma.DefectWhereInput['priority'];
  assigneeId?: string;
  testRunId?: string;
  open?: boolean;
  search?: string;
}

/** Anything not closed or rejected still costs the team something. */
export const OUTSTANDING_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'resolved',
  'reopened',
] as const;

@Injectable()
export class DefectsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findById(id: string, tx?: PrismaTransaction): Promise<Defect | null> {
    return (tx ?? this.prisma).defect.findFirst({ where: this.active({ id }) });
  }

  async list(query: PaginationQuery, filters: DefectFilters): Promise<Paginated<Defect>> {
    const where: Prisma.DefectWhereInput = this.active({
      projectId: filters.projectId,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.severity === undefined ? {} : { severity: filters.severity }),
      ...(filters.priority === undefined ? {} : { priority: filters.priority }),
      ...(filters.assigneeId === undefined ? {} : { assigneeId: filters.assigneeId }),
      ...(filters.testRunId === undefined ? {} : { testRunId: filters.testRunId }),
      ...(filters.open === undefined
        ? {}
        : filters.open
          ? { status: { in: [...OUTSTANDING_STATUSES] } }
          : { status: { in: ['closed', 'rejected'] } }),
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
      this.prisma.defect.findMany({ where, orderBy: { createdAt: 'desc' }, ...this.page(query) }),
      this.prisma.defect.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  create(
    data: Omit<Prisma.DefectUncheckedCreateInput, 'organizationId'>,
    tx: PrismaTransaction,
  ): Promise<Defect> {
    return tx.defect.create({ data: { ...data, organizationId: this.organizationId } });
  }

  async update(
    id: string,
    data: Prisma.DefectUpdateInput,
    tx?: PrismaTransaction,
  ): Promise<Defect | null> {
    const client = tx ?? this.prisma;
    const { count } = await client.defect.updateMany({ where: this.active({ id }), data });
    if (count === 0) {
      return null;
    }
    return client.defect.findFirst({ where: this.active({ id }) });
  }

  async softDelete(id: string, tx?: PrismaTransaction): Promise<boolean> {
    const { count } = await (tx ?? this.prisma).defect.updateMany({
      where: this.active({ id }),
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * The execution a defect claims to come from, with the case resolved through
   * the run case rather than taken from the client.
   */
  async findResultOrigin(testResultId: string): Promise<{
    id: string;
    status: string;
    testRunId: string;
    testCaseId: string;
  } | null> {
    const result = await this.prisma.testResult.findFirst({
      where: this.scope({ id: testResultId }),
      select: {
        id: true,
        status: true,
        testRunId: true,
        testRunCase: { select: { testCaseId: true } },
      },
    });

    return result === null
      ? null
      : {
          id: result.id,
          status: result.status,
          testRunId: result.testRunId,
          testCaseId: result.testRunCase.testCaseId,
        };
  }

  listForProject(projectId: string): Promise<Defect[]> {
    return this.prisma.defect.findMany({
      where: this.active({ projectId }),
      orderBy: { createdAt: 'desc' },
    });
  }

  // --- Traceability --------------------------------------------------------

  createLink(
    data: Omit<Prisma.TraceabilityLinkUncheckedCreateInput, 'organizationId'>,
    tx?: PrismaTransaction,
  ): Promise<TraceabilityLink> {
    return (tx ?? this.prisma).traceabilityLink.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  findLink(
    where: Pick<
      Prisma.TraceabilityLinkUncheckedCreateInput,
      'sourceType' | 'sourceId' | 'targetType' | 'targetId' | 'linkType'
    >,
  ): Promise<TraceabilityLink | null> {
    return this.prisma.traceabilityLink.findFirst({ where: this.scope(where) });
  }

  findLinkById(id: string): Promise<TraceabilityLink | null> {
    return this.prisma.traceabilityLink.findFirst({ where: this.scope({ id }) });
  }

  /** Both directions: a link is a fact about two entities, not about one. */
  linksFor(entityType: LinkableEntity, entityId: string): Promise<TraceabilityLink[]> {
    return this.prisma.traceabilityLink.findMany({
      where: this.scope({
        OR: [
          { sourceType: entityType, sourceId: entityId },
          { targetType: entityType, targetId: entityId },
        ],
      }),
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Every link of one shape, optionally restricted to known sources. */
  linksBetweenTypes(
    sourceType: LinkableEntity,
    targetType: LinkableEntity,
    sourceIds?: string[],
  ): Promise<TraceabilityLink[]> {
    return this.prisma.traceabilityLink.findMany({
      where: this.scope({
        sourceType,
        targetType,
        ...(sourceIds === undefined ? {} : { sourceId: { in: sourceIds } }),
      }),
    });
  }

  async deleteLink(id: string): Promise<boolean> {
    const { count } = await this.prisma.traceabilityLink.deleteMany({ where: this.scope({ id }) });
    return count > 0;
  }
}
