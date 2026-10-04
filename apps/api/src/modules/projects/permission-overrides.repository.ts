import { Injectable } from '@nestjs/common';
import { PermissionEffect, ProjectPermissionOverride } from '@prisma/client';
import { PermissionOverrideInput } from '@qa-flow-hub/shared';
import { PrismaService } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

/**
 * Project-level permission overrides. Read on the authorization path like
 * `project_members`, so every query carries the organization filter (and RLS
 * backs it up).
 */
@Injectable()
export class PermissionOverridesRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  listForMember(projectId: string, userId: string): Promise<ProjectPermissionOverride[]> {
    return this.prisma.projectPermissionOverride.findMany({
      where: this.scope({ projectId, userId }),
      orderBy: { permission: 'asc' },
    });
  }

  listForProject(projectId: string): Promise<ProjectPermissionOverride[]> {
    return this.prisma.projectPermissionOverride.findMany({
      where: this.scope({ projectId }),
      orderBy: [{ userId: 'asc' }, { permission: 'asc' }],
    });
  }

  /** Every grant override a person holds anywhere in the active organization. */
  listGrantsForUser(userId: string): Promise<ProjectPermissionOverride[]> {
    return this.prisma.projectPermissionOverride.findMany({
      where: this.scope({ userId, effect: PermissionEffect.grant }),
    });
  }

  /**
   * Replaces the member's overrides in one transaction so a reader never
   * observes half of the new state. Rows whose permission is not in `next` are
   * removed; the rest are upserted.
   */
  async replaceForMember(
    projectId: string,
    userId: string,
    next: readonly PermissionOverrideInput[],
    grantedById: string,
  ): Promise<ProjectPermissionOverride[]> {
    const organizationId = this.organizationId;

    return this.prisma.$transaction(async (tx) => {
      await tx.projectPermissionOverride.deleteMany({
        where: {
          organizationId,
          projectId,
          userId,
          permission: { notIn: next.map((override) => override.permission) },
        },
      });

      for (const override of next) {
        await tx.projectPermissionOverride.upsert({
          where: { projectId_userId_permission: { projectId, userId, permission: override.permission } },
          update: { effect: override.effect, grantedById },
          create: {
            organizationId,
            projectId,
            userId,
            permission: override.permission,
            effect: override.effect,
            grantedById,
          },
        });
      }

      return tx.projectPermissionOverride.findMany({
        where: { organizationId, projectId, userId },
        orderBy: { permission: 'asc' },
      });
    });
  }

  async removeForMember(projectId: string, userId: string): Promise<number> {
    const { count } = await this.prisma.projectPermissionOverride.deleteMany({
      where: this.scope({ projectId, userId }),
    });
    return count;
  }
}
