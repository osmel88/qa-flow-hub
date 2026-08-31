import { Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { TenantContextService } from '../../database/tenant-context.service';
import { ForbiddenError } from '../../errors';
import { ProjectMembersRepository } from './project-members.repository';

/**
 * Answers "what may this person do *in this project*".
 *
 * The organization role is the default, a grant in `project_members` replaces
 * it for one project, and the route's own `@Roles` list is what the resulting
 * role is checked against. Two consequences worth stating, because both are
 * decisions rather than accidents:
 *
 *  - a grant may *raise* as well as lower the role. An organization `tester`
 *    who leads QA on one project is a real arrangement, and the alternative —
 *    promoting them organization-wide — is the escalation this feature exists
 *    to avoid. Whoever grants it can never grant above their own role, so the
 *    grant adds no power that did not already exist in the room;
 *  - `organization_owner` is never narrowed. An owner who locked themselves out
 *    of a project in their own tenant would need support to get back in, which
 *    is the same reasoning that refuses to demote the last owner.
 *
 * Visibility is deliberately *not* part of this: every member of the
 * organization can still see that a project exists. Private projects are a
 * product decision, not a consequence of role scoping, and it is recorded as
 * such in docs/technical-debt.md.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly grants: ProjectMembersRepository,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Could *any* project let this caller through a route that requires `roles`?
   *
   * Used by the roles guard as a pre-filter, and only when the organization role
   * already failed. It answers a weaker question than `assertRouteAccess` on
   * purpose: the guard runs before the project is known, and refusing there
   * would make a grant that raises somebody's role in one project impossible to
   * honour. The service still decides on the actual project, which is why this
   * being permissive is not a hole — see the `@ProjectScoped` contract.
   */
  async mayHoldGrantFor(roles: readonly OrganizationRole[]): Promise<boolean> {
    const grants = await this.grants.listForUser(this.tenant.requireUserId());

    return grants.some((grant) => grant.role !== null && roles.includes(grant.role));
  }

  async effectiveRole(projectId: string): Promise<OrganizationRole> {
    const organizationRole = this.tenant.requireRole();
    if (organizationRole === OrganizationRole.organization_owner) {
      return organizationRole;
    }

    const cached = this.tenant.cachedProjectRole(projectId);
    if (cached !== undefined) {
      return cached;
    }

    const grant = await this.grants.findGrant(projectId, this.tenant.requireUserId());
    const role = grant?.role ?? organizationRole;
    this.tenant.rememberProjectRole(projectId, role);
    return role;
  }

  /**
   * Re-applies the current route's `@Roles` list against the project role.
   *
   * Called from the place where the project becomes known — a service loader,
   * or the create path that received `projectId` — because for most routes the
   * project is a property of the entity being touched and no guard can know it
   * without loading that entity first. A route with no `@Roles` is open to
   * every member and stays that way here: narrowing reads would silently change
   * the product's meaning of "member".
   */
  async assertRouteAccess(projectId: string): Promise<OrganizationRole> {
    const required = this.tenant.requiredRoles;
    const role = await this.effectiveRole(projectId);

    if (required.length > 0 && !required.includes(role)) {
      throw new ForbiddenError(`Your role in this project (${role}) does not allow this action`);
    }

    return role;
  }
}
