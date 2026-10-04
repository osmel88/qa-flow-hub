import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '@prisma/client';
import { Permission, ROLE_PERMISSIONS } from '@qa-flow-hub/shared';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { ProjectAccessService } from '../../projects/project-access.service';
import { PROJECT_SCOPED_KEY } from '../decorators/project-scoped.decorator';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Authorization at the route boundary: `@Roles` and/or `@RequirePermission`.
 *
 * A route declaring neither is open to every member of the organization. A
 * route declaring one or both passes when the caller's organization role is in
 * the `@Roles` list, or when that role's default permissions cover every
 * required permission. Overrides are not consulted here: they exist per
 * project, and the guard does not know the project yet.
 *
 * For `@ProjectScoped` routes the guard is only a pre-filter: when the
 * organization role fails, it lets the request through if *some* project grant
 * or override could satisfy the route, and `ProjectAccessService.assertRouteAccess`
 * makes the real decision once the service knows the project. Routes that are
 * not project-scoped are decided here, finally, on the organization role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: TenantContextService,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const targets = [executionContext.getHandler(), executionContext.getClass()];
    const requiredRoles =
      this.reflector.getAllAndOverride<OrganizationRole[] | undefined>(ROLES_KEY, targets) ?? [];
    const requiredPermissions =
      this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets) ?? [];

    this.context.setRequiredRoles(requiredRoles);
    this.context.setRequiredPermissions(requiredPermissions);

    if (requiredRoles.length === 0 && requiredPermissions.length === 0) {
      return true;
    }

    const role = this.context.role;
    if (role !== undefined && satisfies(role, requiredRoles, requiredPermissions)) {
      return true;
    }

    const projectScoped = this.reflector.getAllAndOverride<boolean>(PROJECT_SCOPED_KEY, targets);

    if (
      projectScoped === true &&
      role !== undefined &&
      (await this.access.mayHoldGrantFor(requiredRoles, requiredPermissions))
    ) {
      return true;
    }

    throw new ForbiddenError('Your role does not allow this action');
  }
}

function satisfies(
  role: OrganizationRole,
  roles: readonly OrganizationRole[],
  permissions: readonly Permission[],
): boolean {
  if (roles.includes(role)) {
    return true;
  }
  if (permissions.length === 0) {
    return false;
  }
  const defaults = ROLE_PERMISSIONS[role];
  return permissions.every((permission) => defaults.includes(permission));
}
