import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '@prisma/client';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Checks the role the active-organization guard resolved for this request.
 *
 * Deliberately dumb: it compares against the list on the handler and nothing
 * else. Rules that depend on the *object* being touched ("a tester may edit
 * their own result but not somebody else's") are not authorization in the
 * route sense and belong in the service, where the object is loaded.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: TenantContextService,
  ) {}

  canActivate(executionContext: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<OrganizationRole[] | undefined>(ROLES_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);

    if (required === undefined || required.length === 0) {
      return true;
    }

    const role = this.context.role;
    if (role === undefined || !required.includes(role)) {
      throw new ForbiddenError('Your role does not allow this action');
    }

    return true;
  }
}
