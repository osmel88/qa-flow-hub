import { Injectable } from '@nestjs/common';
import { AuditAction, Organization, OrganizationRole } from '@prisma/client';
import {
  CreateOrganizationInput,
  ListMembersQuery,
  MemberView,
  OrganizationView,
  Paginated,
  ROLE_RANK,
  UpdateOrganizationInput,
} from '@qa-flow-hub/shared';
import { ConflictError, DuplicateResourceError, ForbiddenError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { MemberWithUser, OrganizationMembersRepository } from './organization-members.repository';
import { OrganizationsRepository } from './organizations.repository';

/**
 * The ranking lives in the shared package so the client can grey out an action
 * instead of offering one the server will refuse. It is used only to answer
 * "can this person hand out that role?" — not as a permission system, see
 * docs/permissions-matrix.md — and the check below is the one that counts.
 */

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizations: OrganizationsRepository,
    private readonly members: OrganizationMembersRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creating an organization is the one write that needs no active tenant: it
   * creates the tenant. The caller becomes its owner in the same transaction.
   */
  async create(userId: string, input: CreateOrganizationInput): Promise<OrganizationView> {
    if ((await this.organizations.findBySlug(input.slug)) !== null) {
      throw new DuplicateResourceError('organization', 'slug');
    }

    const organization = await this.organizations.createWithOwner(
      { name: input.name, slug: input.slug },
      userId,
    );

    await this.audit.record({
      action: AuditAction.create,
      entityType: 'Organization',
      entityId: organization.id,
      summary: `Created the organization ${organization.name}`,
      organizationId: organization.id,
      changes: { name: organization.name, slug: organization.slug },
    });

    return toOrganizationView(organization);
  }

  /**
   * The organizations the caller can switch between. This is what populates the
   * organization selector, and it is also the authoritative answer to "which
   * values of X-Organization-Id will be accepted for me".
   */
  async listMine(userId: string): Promise<Array<OrganizationView & { role: OrganizationRole }>> {
    const rows = await this.organizations.listForUser(userId);
    return rows.map(({ organization, role }) => ({ ...toOrganizationView(organization), role }));
  }

  async get(organizationId: string): Promise<OrganizationView> {
    const organization = await this.organizations.findById(organizationId);
    if (organization === null) {
      throw new NotFoundError('Organization');
    }
    return toOrganizationView(organization);
  }

  async update(organizationId: string, input: UpdateOrganizationInput): Promise<OrganizationView> {
    const organization = await this.organizations.update(organizationId, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
    });
    if (organization === null) {
      throw new NotFoundError('Organization');
    }

    await this.audit.record({
      action: AuditAction.update,
      entityType: 'Organization',
      entityId: organization.id,
      summary: 'Updated the organization settings',
      changes: { ...input },
    });

    return toOrganizationView(organization);
  }

  async listMembers(
    organizationId: string,
    query: ListMembersQuery,
  ): Promise<Paginated<MemberView>> {
    const page = await this.members.listWithUsers(organizationId, query, query.search);
    return { data: page.data.map(toMemberView), meta: page.meta };
  }

  /**
   * Changes a member's role.
   *
   * Three rules, each of which exists because breaking it is unrecoverable or a
   * privilege escalation:
   *
   *  1. nobody may grant a role above their own — otherwise an admin mints an
   *     owner and outranks the person who hired them;
   *  2. the last owner cannot be demoted — an organization with no owner cannot
   *     be administered again without support;
   *  3. changing your own role is refused outright, because every legitimate
   *     case (handing over ownership) is a two-person operation.
   */
  async changeMemberRole(
    organizationId: string,
    actor: { userId: string; role: OrganizationRole },
    targetUserId: string,
    role: OrganizationRole,
  ): Promise<MemberView> {
    if (targetUserId === actor.userId) {
      throw new ForbiddenError('You cannot change your own role');
    }
    if (ROLE_RANK[role] < ROLE_RANK[actor.role]) {
      throw new ForbiddenError('You cannot grant a role more powerful than your own');
    }

    const target = await this.members.findActiveMembership(targetUserId, organizationId);
    if (target === null) {
      throw new NotFoundError('Member');
    }
    if (ROLE_RANK[target.role] < ROLE_RANK[actor.role]) {
      throw new ForbiddenError('You cannot change the role of a more powerful member');
    }
    if (
      target.role === OrganizationRole.organization_owner &&
      role !== OrganizationRole.organization_owner &&
      (await this.members.countOwners(organizationId, targetUserId)) === 0
    ) {
      throw new ConflictError('The organization must keep at least one owner');
    }

    const updated = await this.members.updateRole(organizationId, targetUserId, role);
    if (updated === null) {
      throw new NotFoundError('Member');
    }

    await this.audit.record({
      action: AuditAction.role_change,
      entityType: 'OrganizationMember',
      entityId: updated.id,
      summary: `Changed a member role from ${target.role} to ${role}`,
      changes: { userId: targetUserId, from: target.role, to: role },
    });

    const view = await this.findMemberView(organizationId, targetUserId);
    if (view === null) {
      throw new NotFoundError('Member');
    }
    return view;
  }

  /**
   * Removes a member. Soft delete, and the removed person's sessions are *not*
   * revoked here: they may still belong to other organizations. What stops them
   * is the active-organization guard, which finds no membership on the next
   * request — which is exactly why that guard reads the database instead of
   * trusting the token.
   */
  async removeMember(
    organizationId: string,
    actor: { userId: string; role: OrganizationRole },
    targetUserId: string,
  ): Promise<void> {
    if (targetUserId === actor.userId) {
      throw new ForbiddenError('You cannot remove yourself. Ask another administrator.');
    }

    const target = await this.members.findActiveMembership(targetUserId, organizationId);
    if (target === null) {
      throw new NotFoundError('Member');
    }
    if (ROLE_RANK[target.role] < ROLE_RANK[actor.role]) {
      throw new ForbiddenError('You cannot remove a more powerful member');
    }
    if (
      target.role === OrganizationRole.organization_owner &&
      (await this.members.countOwners(organizationId, targetUserId)) === 0
    ) {
      throw new ConflictError('The organization must keep at least one owner');
    }

    await this.members.softDelete(organizationId, targetUserId);

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'OrganizationMember',
      entityId: target.id,
      summary: `Removed a member (${target.role})`,
      changes: { userId: targetUserId, role: target.role },
    });
  }

  private async findMemberView(
    organizationId: string,
    userId: string,
  ): Promise<MemberView | null> {
    const member = await this.members.findWithUser(organizationId, userId);
    return member === null ? null : toMemberView(member);
  }
}

export function toOrganizationView(organization: Organization): OrganizationView {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    plan: organization.plan,
    createdAt: organization.createdAt.toISOString(),
  };
}

function toMemberView(member: MemberWithUser): MemberView {
  return {
    userId: member.user.id,
    email: member.user.email,
    fullName: member.user.fullName,
    avatarUrl: member.user.avatarUrl,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt.toISOString(),
  };
}
