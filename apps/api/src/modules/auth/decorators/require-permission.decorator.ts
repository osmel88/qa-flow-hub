import { SetMetadata } from '@nestjs/common';
import { Permission } from '@qa-flow-hub/shared';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares which permissions a handler needs; every listed permission is
 * required. The successor to `@Roles`, which stays available: a route may carry
 * either, and the guard accepts whichever one the caller satisfies.
 *
 * The difference that matters: a `@Roles` list is closed — only those roles
 * pass — whereas a permission may be granted or revoked per project through
 * overrides. Routes that must stay tied to the organization role (creating
 * projects, managing organization members, the audit log) keep `@Roles`.
 */
export const RequirePermission = (...permissions: Permission[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);
