import { SetMetadata } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';

export const ROLES_KEY = 'requiredRoles';

/**
 * Declares which roles may reach a handler.
 *
 * Roles, not permissions, for the MVP. A permission matrix is more flexible and
 * also more machinery than six roles justify; the migration path is to keep
 * this decorator's name and change what it checks. See docs/permissions-matrix.md.
 */
export const Roles = (...roles: OrganizationRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
