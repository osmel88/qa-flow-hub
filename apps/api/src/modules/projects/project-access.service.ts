import { Injectable } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PERMISSIONS, Permission, ROLE_PERMISSIONS, roleHasPermission } from '@qa-flow-hub/shared';
import { TenantContextService } from '../../database/tenant-context.service';
import { ForbiddenError } from '../../errors';
import { PermissionOverridesRepository } from './permission-overrides.repository';
import { ProjectMembersRepository } from './project-members.repository';

/**
 * Answers "what may this person do *in this project*".
 *
 * Resolution is layered, and each layer is only a default for the next:
 *
 *   organization role → project role (`project_members`) → permission overrides
 *   (`project_permission_overrides`) → effective permissions
 *
 * The organization role is the default, a grant in `project_members` replaces
 * it for one project, the role maps to a fixed permission set
 * (`ROLE_PERMISSIONS`), and overrides add or remove single permissions. Routes
 * declare either `@Roles` (a closed list, compared against the effective role)
 * or `@RequirePermission` (compared against the effective permission set).
 * Decisions worth stating, because both are choices rather than accidents:
 *
 *  - a grant may *raise* as well as lower the role. An organization `tester`
 *    who leads QA on one project is a real arrangement, and the alternative —
 *    promoting them organization-wide — is the escalation this feature exists
 *    to avoid. Whoever grants it can never grant above their own role, so the
 *    grant adds no power that did not already exist in the room. The same holds
 *    for overrides: only permissions the grantor effectively holds here;
 *  - `organization_owner` is never narrowed, by grants or by overrides. An
 *    owner who locked themselves out of a project in their own tenant would
 *    need support to get back in, which is the same reasoning that refuses to
 *    demote the last owner.
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
    private readonly overrides: PermissionOverridesRepository,
    private readonly tenant: TenantContextService,
  ) {}

  /**
   * Could *any* project let this caller through a route that requires `roles`
   * or `permissions`?
   *
   * Used by the permissions guard as a pre-filter, and only when the
   * organization role already failed. It answers a weaker question than
   * `assertRouteAccess` on purpose: the guard runs before the project is known,
   * and refusing there would make a grant that raises somebody's role in one
   * project impossible to honour. The service still decides on the actual
   * project, which is why this being permissive is not a hole — see the
   * `@ProjectScoped` contract.
   */
  async mayHoldGrantFor(
    roles: readonly OrganizationRole[],
    permissions: readonly Permission[] = [],
  ): Promise<boolean> {
    const userId = this.tenant.requireUserId();
    const grants = await this.grants.listForUser(userId);

    const roleSatisfies = (role: OrganizationRole): boolean =>
      roles.includes(role) ||
      (permissions.length > 0 &&
        permissions.every((permission) => roleHasPermission(role, permission)));

    if (grants.some((grant) => grant.role !== null && roleSatisfies(grant.role))) {
      return true;
    }
    if (permissions.length === 0) {
      return false;
    }

    const granted = await this.overrides.listGrantsForUser(userId);
    return granted.some((override) => isPermission(override.permission) && permissions.includes(override.permission));
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
   * `defaults(effective role) + granted overrides − revoked overrides`, memoised
   * per request. Owners get the whole catalogue without consulting overrides.
   */
  async effectivePermissions(projectId: string): Promise<ReadonlySet<Permission>> {
    const cached = this.tenant.cachedProjectPermissions(projectId);
    if (cached !== undefined) {
      return cached;
    }

    const role = await this.effectiveRole(projectId);
    const permissions = new Set<Permission>(ROLE_PERMISSIONS[role]);

    if (role !== OrganizationRole.organization_owner) {
      const overrides = await this.overrides.listForMember(projectId, this.tenant.requireUserId());
      for (const override of overrides) {
        if (!isPermission(override.permission)) {
          continue;
        }
        if (override.effect === 'grant') {
          permissions.add(override.permission);
        } else {
          permissions.delete(override.permission);
        }
      }
    }

    this.tenant.rememberProjectPermissions(projectId, permissions);
    return permissions;
  }

  async hasPermission(projectId: string, permission: Permission): Promise<boolean> {
    return (await this.effectivePermissions(projectId)).has(permission);
  }

  /**
   * Refuses unless the caller holds `permission` in this project. For checks a
   * service must make that its route did not declare (the route accepts several
   * kinds of entity and the required permission depends on which one).
   */
  async assertPermission(projectId: string, permission: Permission): Promise<void> {
    if (!(await this.hasPermission(projectId, permission))) {
      throw new ForbiddenError(`You need ${permission} in this project for this action`);
    }
  }

  /**
   * The check every project-scoped route must reach: applies the route's own
   * `@Roles` list and/or `@RequirePermission` set against what the caller
   * effectively holds in *this* project. A route declaring both passes when
   * either is satisfied.
   */
  async assertRouteAccess(projectId: string): Promise<OrganizationRole> {
    const requiredRoles = this.tenant.requiredRoles;
    const requiredPermissions = this.tenant.requiredPermissions;
    const role = await this.effectiveRole(projectId);

    if (requiredRoles.length === 0 && requiredPermissions.length === 0) {
      return role;
    }
    if (requiredRoles.includes(role)) {
      return role;
    }
    if (requiredPermissions.length > 0) {
      const held = await this.effectivePermissions(projectId);
      if (requiredPermissions.every((permission) => held.has(permission))) {
        return role;
      }
    }

    throw new ForbiddenError(`Your role in this project (${role}) does not allow this action`);
  }
}

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

/** A stored override may predate a renamed permission; unknown names are ignored. */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
