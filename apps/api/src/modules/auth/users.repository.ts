import { Injectable } from '@nestjs/common';
import { MembershipStatus, Prisma, User } from '@prisma/client';
import { OrganizationSummary } from '@qa-flow-hub/shared';
import { PrismaService, PrismaTransaction } from '../../database/prisma.service';

/**
 * Users are global, not tenant-scoped: the same person can be a qa-lead in one
 * organization and a viewer in another, so the account exists above the tenant
 * boundary. Membership is what carries the organization.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The email is expected to be already normalised by the Zod schema. */
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  create(data: Prisma.UserUncheckedCreateInput, tx?: PrismaTransaction): Promise<User> {
    return (tx ?? this.prisma).user.create({ data });
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  /**
   * The organizations the user may act for, with the role in each. This is what
   * the organization switcher shows and what the active-organization guard
   * checks against.
   */
  async listOrganizations(userId: string): Promise<OrganizationSummary[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        status: MembershipStatus.active,
        deletedAt: null,
        organization: { deletedAt: null },
      },
      include: { organization: { select: { id: true, name: true, slug: true } } },
      orderBy: { organization: { name: 'asc' } },
    });

    return memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role,
    }));
  }

  /** Records a failed login and locks the account once the threshold is hit. */
  async registerFailedLogin(
    userId: string,
    maxAttempts: number,
    lockoutMinutes: number,
  ): Promise<{ locked: boolean }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });

    if (user.failedLoginAttempts < maxAttempts) {
      return { locked: false };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lockedUntil: new Date(Date.now() + lockoutMinutes * 60_000),
        // Reset here so the next lockout needs a fresh run of failures rather
        // than a single attempt once the window expires.
        failedLoginAttempts: 0,
      },
    });
    return { locked: true };
  }

  async registerSuccessfulLogin(userId: string, passwordHash?: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(passwordHash === undefined ? {} : { passwordHash }),
      },
    });
  }
}
