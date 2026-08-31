import { Injectable } from '@nestjs/common';
import { MembershipStatus, Organization, OrganizationRole, Prisma } from '@prisma/client';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

export interface OrganizationWithRole {
  organization: Organization;
  role: OrganizationRole;
}

/**
 * Organizations are the tenant boundary, so this repository is deliberately
 * *not* a `TenantAwareRepository`: `create` runs before any organization is in
 * context, and `listForUser` is scoped by user rather than by tenant. Every
 * other read here still takes the id from a membership the guard has already
 * verified, which is why passing an id is safe in this one place.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<Organization | null> {
    return this.prisma.organization.findFirst({ where: { id, deletedAt: null } });
  }

  findBySlug(slug: string): Promise<Organization | null> {
    return this.prisma.organization.findFirst({ where: { slug, deletedAt: null } });
  }

  /** Every organization the user is an active member of, with their role in each. */
  async listForUser(userId: string): Promise<OrganizationWithRole[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        status: MembershipStatus.active,
        deletedAt: null,
        organization: { deletedAt: null },
      },
      include: { organization: true },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((membership) => ({
      organization: membership.organization,
      role: membership.role,
    }));
  }

  /**
   * Creates the organization and its first membership — the creator as owner —
   * in one transaction. An organization without an owner is unreachable: nobody
   * could administer it, and nobody could even list it. So the two rows are one
   * operation, not two.
   */
  async createWithOwner(
    data: { name: string; slug: string },
    ownerUserId: string,
    onCreated?: (organization: Organization, tx: PrismaTransaction) => Promise<void>,
  ): Promise<Organization> {
    return this.prisma.runInTransaction(async (tx) => {
      const organization = await tx.organization.create({ data });

      await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: ownerUserId,
          role: OrganizationRole.organization_owner,
          status: MembershipStatus.active,
        },
      });

      await onCreated?.(organization, tx);
      return organization;
    });
  }

  async update(id: string, data: Prisma.OrganizationUpdateInput): Promise<Organization | null> {
    const { count } = await this.prisma.organization.updateMany({
      where: { id, deletedAt: null },
      data,
    });
    return count === 0 ? null : this.findById(id);
  }
}
