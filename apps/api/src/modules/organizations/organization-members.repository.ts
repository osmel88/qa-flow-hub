import { Injectable } from '@nestjs/common';
import { MembershipStatus, OrganizationMember, OrganizationRole, Prisma } from '@prisma/client';
import {
  Paginated,
  PaginationQuery,
  buildPaginationMeta,
  toSkipTake,
} from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

export interface MemberWithUser extends OrganizationMember {
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    mfaTotpFactor: { confirmedAt: Date | null } | null;
  };
}

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
  ): Promise<(OrganizationMember & { organization: { requireMfa: boolean } }) | null> {
    return this.prisma.organizationMember.findFirst({
      where: {
        userId,
        organizationId,
        status: MembershipStatus.active,
        deletedAt: null,
        organization: { deletedAt: null },
      },
      include: { organization: { select: { requireMfa: true } } },
    });
  }

  create(
    data: Prisma.OrganizationMemberUncheckedCreateInput,
    tx?: PrismaTransaction,
  ): Promise<OrganizationMember> {
    return (tx ?? this.prisma).organizationMember.create({ data });
  }

  /** Any membership, including suspended and soft-deleted ones. */
  findAnyMembership(
    userId: string,
    organizationId: string,
    tx?: PrismaTransaction,
  ): Promise<OrganizationMember | null> {
    return (tx ?? this.prisma).organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
  }

  findWithUser(organizationId: string, userId: string): Promise<MemberWithUser | null> {
    return this.prisma.organizationMember.findFirst({
      where: { organizationId, userId, deletedAt: null },
      include: { user: { select: { id: true, email: true, fullName: true, avatarUrl: true, mfaTotpFactor: { select: { confirmedAt: true } } } } },
    });
  }

  listForOrganization(organizationId: string): Promise<OrganizationMember[]> {
    return this.prisma.organizationMember.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The members page: one query joined to `User`, paginated, optionally
   * filtered by name or email.
   */
  async listWithUsers(
    organizationId: string,
    query: PaginationQuery,
    search?: string,
  ): Promise<Paginated<MemberWithUser>> {
    const where: Prisma.OrganizationMemberWhereInput = {
      organizationId,
      deletedAt: null,
      ...(search === undefined
        ? {}
        : {
            user: {
              OR: [
                { fullName: { contains: search, mode: Prisma.QueryMode.insensitive } },
                { email: { contains: search.toLowerCase() } },
              ],
            },
          }),
    };

    const [data, total] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, fullName: true, avatarUrl: true, mfaTotpFactor: { select: { confirmedAt: true } } } },
        },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        ...toSkipTake(query),
      }),
      this.prisma.organizationMember.count({ where }),
    ]);

    return { data, meta: buildPaginationMeta(query, total) };
  }

  /**
   * Re-activates a soft-deleted or suspended membership instead of inserting a
   * second row. `(organizationId, userId)` is unique, so "invite somebody who
   * used to be a member" has to be an update — and getting the old role back by
   * accident would be a privilege bug, hence the explicit role.
   */
  async reactivate(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    tx?: PrismaTransaction,
  ): Promise<OrganizationMember> {
    return (tx ?? this.prisma).organizationMember.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role, status: MembershipStatus.active, deletedAt: null, joinedAt: new Date() },
    });
  }

  async updateRole(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<OrganizationMember | null> {
    const { count } = await this.prisma.organizationMember.updateMany({
      where: { organizationId, userId, deletedAt: null },
      data: { role },
    });
    return count === 0 ? null : this.findAnyMembership(userId, organizationId);
  }

  /**
   * Removes a member. Soft delete, because audit entries, test results and
   * defect assignments all point at this person and must keep resolving.
   * Every project grant and permission override they held here goes in the
   * same transaction: access must never outlive the membership that justified
   * it, nor come back with a later re-invitation.
   */
  async softDelete(organizationId: string, userId: string): Promise<boolean> {
    return this.prisma.runInTransaction(async (tx) => {
      const { count } = await tx.organizationMember.updateMany({
        where: { organizationId, userId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await this.purgeProjectAccess(organizationId, userId, tx);
      return count > 0;
    });
  }

  /** Every project grant and override a user holds in one organization. */
  async purgeProjectAccess(
    organizationId: string,
    userId: string,
    tx: PrismaTransaction,
  ): Promise<void> {
    await tx.projectPermissionOverride.deleteMany({ where: { organizationId, userId } });
    await tx.projectMember.deleteMany({ where: { organizationId, userId } });
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
