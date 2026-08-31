import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '@prisma/client';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { ProjectAccessService } from '../../projects/project-access.service';
import { PROJECT_SCOPED_KEY } from '../decorators/project-scoped.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Checks the role the active-organization guard resolved for this request.
 *
 * Deliberately dumb: it compares against the list on the handler and nothing
 * else. Rules that depend on the *object* being touched ("a tester may edit
 * their own result but not somebody else's") are not authorization in the
 * route sense and belong in the service, where the object is loaded.
 *
 * The one concession to complexity is project scoping. A role may be granted
 * per project, and the project is usually a property of the entity the request
 * names, so this guard cannot resolve it. On a route marked `@ProjectScoped` it
 * therefore lets a caller through when *some* grant they hold would allow the
 * action, and the service — which does know the project — makes the final
 * decision. Without that, a grant could only ever take power away.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: TenantContextService,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OrganizationRole[] | undefined>(ROLES_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    // Stashed even when empty: the project-scoped check reads this list instead
    // of restating it, so a route's roles are declared exactly once.
    this.context.setRequiredRoles(required ?? []);

    if (required === undefined || required.length === 0) {
      return true;
    }

    const role = this.context.role;
    if (role !== undefined && required.includes(role)) {
      return true;
    }

    const projectScoped = this.reflector.getAllAndOverride<boolean>(PROJECT_SCOPED_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    // `role === undefined` means the organization guard did not run, and no
    // grant may compensate for that: failing closed is the only safe answer.
    if (
      projectScoped === true &&
      role !== undefined &&
      (await this.access.mayHoldGrantFor(required))
    ) {
      return true;
    }

    throw new ForbiddenError('Your role does not allow this action');
  }
}
