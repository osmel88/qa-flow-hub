import { Injectable } from '@nestjs/common';
import { MembershipStatus, OrganizationMember, OrganizationRole, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

/**
 * Membership is the join between a global user and a tenant, and it is the
 * table the active-organization guard consults on every request. It is not a
 * TenantAwareRepository because it is what *establishes* the tenant: it has to
 * be able to look up a membership before an organization is in context.
 */
@Injectable()
export class OrganizationMembersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The authorization lookup: is this user allowed to act for this org, and as what? */
  findActiveMembership(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMember | null> {
    return this.prisma.organizationMember.findFirst({
      where: {
        userId,
        organizationId,
        status: MembershipStatus.active,
        deletedAt: null,
        organization: { deletedAt: null },
      },
    });
  }

  create(
    data: Prisma.OrganizationMemberUncheckedCreateInput,
    tx?: PrismaTransaction,
  ): Promise<OrganizationMember> {
    return (tx ?? this.prisma).organizationMember.create({ data });
  }

  listForOrganization(organizationId: string): Promise<OrganizationMember[]> {
    return this.prisma.organizationMember.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Counts the remaining owners. Used to refuse the last owner's removal or
   * demotion: an organization with no owner cannot be administered again
   * without support intervention.
   */
  countOwners(organizationId: string, excludeUserId?: string): Promise<number> {
    return this.prisma.organizationMember.count({
      where: {
        organizationId,
        role: OrganizationRole.organization_owner,
        status: MembershipStatus.active,
        deletedAt: null,
        ...(excludeUserId === undefined ? {} : { userId: { not: excludeUserId } }),
      },
    });
  }
}
