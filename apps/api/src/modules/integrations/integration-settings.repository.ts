import { Injectable } from '@nestjs/common';
import { IntegrationConnection, IntegrationProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

@Injectable()
export class IntegrationSettingsRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  list(): Promise<IntegrationConnection[]> {
    return this.prisma.integrationConnection.findMany({
      where: this.active(),
      orderBy: { provider: 'asc' },
    });
  }

  findByProvider(provider: IntegrationProvider): Promise<IntegrationConnection | null> {
    return this.prisma.integrationConnection.findFirst({ where: this.active({ provider }) });
  }

  create(
    data: Omit<Prisma.IntegrationConnectionUncheckedCreateInput, 'organizationId'>,
  ): Promise<IntegrationConnection> {
    return this.prisma.integrationConnection.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }

  /**
   * `updateMany` on a scoped where, then a scoped read: the same shape every
   * repository here uses. `update` by id would reach a row in another
   * organization if an id ever leaked, and returning `null` for "not yours" is
   * what turns that into a 404 rather than a cross-tenant write.
   */
  async update(
    provider: IntegrationProvider,
    data: Prisma.IntegrationConnectionUpdateManyMutationInput,
  ): Promise<IntegrationConnection | null> {
    const { count } = await this.prisma.integrationConnection.updateMany({
      where: this.active({ provider }),
      data,
    });
    if (count === 0) {
      return null;
    }
    return this.findByProvider(provider);
  }
}
