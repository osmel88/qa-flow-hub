import { Injectable } from '@nestjs/common';
import { ExternalReference, IntegrationProvider, LinkableEntity, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface ExternalReferenceWrite {
  provider: IntegrationProvider;
  entityType: LinkableEntity;
  entityId: string;
  projectId: string | null;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  metadata: Prisma.InputJsonValue;
  connectionId: string | null;
}

export interface ProjectReferencesFilter {
  projectId: string;
  provider?: IntegrationProvider;
  entityType?: LinkableEntity;
}

/**
 * The generic bridge between our entities and a provider's.
 *
 * Nothing here knows about Jira: the same rows carry TestRail cases and GitHub
 * runs, keyed by `provider` and `entityType`. That is the whole reason
 * `Requirement` and `Defect` carry no `jiraIssueKey` column — the relationship
 * is data in this table, not schema in theirs.
 */
@Injectable()
export class ExternalReferencesRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findForEntity(
    provider: IntegrationProvider,
    entityType: LinkableEntity,
    entityId: string,
  ): Promise<ExternalReference | null> {
    return this.prisma.externalReference.findFirst({
      where: this.scope({ provider, entityType, entityId }),
      orderBy: { createdAt: 'asc' },
    });
  }

  listForEntities(
    provider: IntegrationProvider,
    entityType: LinkableEntity,
    entityIds: string[],
  ): Promise<ExternalReference[]> {
    if (entityIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.prisma.externalReference.findMany({
      where: this.scope({ provider, entityType, entityId: { in: entityIds } }),
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Every reference of a project, whether or not its entity still exists. */
  listForProject(filter: ProjectReferencesFilter): Promise<ExternalReference[]> {
    return this.prisma.externalReference.findMany({
      where: this.scope({
        projectId: filter.projectId,
        ...(filter.provider === undefined ? {} : { provider: filter.provider }),
        ...(filter.entityType === undefined ? {} : { entityType: filter.entityType }),
      }),
      orderBy: [{ entityType: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Stamps verification data without touching what the reference points at. */
  async updateMetadata(id: string, metadata: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.externalReference.updateMany({
      where: this.scope({ id }),
      data: { metadata },
    });
  }

  findById(id: string): Promise<ExternalReference | null> {
    return this.prisma.externalReference.findFirst({ where: this.scope({ id }) });
  }

  create(data: ExternalReferenceWrite, tx?: PrismaTransaction): Promise<ExternalReference> {
    return (tx ?? this.prisma).externalReference.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  async update(
    id: string,
    data: Pick<
      ExternalReferenceWrite,
      'externalId' | 'externalKey' | 'externalUrl' | 'metadata' | 'connectionId'
    >,
    tx?: PrismaTransaction,
  ): Promise<ExternalReference | null> {
    const { count } = await (tx ?? this.prisma).externalReference.updateMany({
      where: this.scope({ id }),
      data,
    });
    if (count === 0) {
      return null;
    }
    return this.prisma.externalReference.findFirst({ where: this.scope({ id }) });
  }
}
