import { Injectable } from '@nestjs/common';
import { OrganizationRole, ProjectMember } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';
import { TenantAwareRepository } from '../../database/tenant-aware.repository';
import { TenantContextService } from '../../database/tenant-context.service';

export interface ProjectMemberWithUser extends ProjectMember {
  user: { id: string; email: string; fullName: string; avatarUrl: string | null };
}

/**
 * Grants of a role *inside one project*.
 *
 * Tenant-aware like every other functional repository, which matters more here
 * than elsewhere: this table is read on the authorization path, and a query
 * that forgot the organization filter would hand another tenant's grant to the
 * guard. There is no soft delete — a revoked grant is not history, and the
 * audit log already records that it existed.
 */
@Injectable()
export class ProjectMembersRepository extends TenantAwareRepository {
  constructor(prisma: PrismaService, tenant: TenantContextService) {
    super(prisma, tenant);
  }

  findGrant(projectId: string, userId: string): Promise<ProjectMember | null> {
    return this.prisma.projectMember.findFirst({ where: this.scope({ projectId, userId }) });
  }

  listWithUsers(projectId: string): Promise<ProjectMemberWithUser[]> {
    return this.prisma.projectMember.findMany({
      where: this.scope({ projectId }),
      include: { user: { select: { id: true, email: true, fullName: true, avatarUrl: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * One grant per person per project, so re-granting is an update rather than a
   * second row: `(projectId, userId)` is unique, and two rows would make
   * "which role applies here" ambiguous on the authorization path.
   */
  upsert(
    projectId: string,
    userId: string,
    role: OrganizationRole,
    tx?: PrismaTransaction,
  ): Promise<ProjectMember> {
    return (tx ?? this.prisma).projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { role },
      create: { projectId, userId, role, organizationId: this.organizationId },
    });
  }

  async remove(projectId: string, userId: string): Promise<boolean> {
    const { count } = await this.prisma.projectMember.deleteMany({
      where: this.scope({ projectId, userId }),
    });
    return count > 0;
  }

  /** Every grant a person holds in the active organization. */
  listForUser(userId: string): Promise<ProjectMember[]> {
    return this.prisma.projectMember.findMany({ where: this.scope({ userId }) });
  }
}
