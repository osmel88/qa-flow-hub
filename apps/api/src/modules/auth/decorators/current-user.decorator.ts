import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { TenantContextService } from '../../../database/tenant-context.service';
import { UnauthenticatedError } from '../../../errors';

/**
 * The caller, as handlers see it.
 *
 * A class with accessors rather than a plain object, so that the two shapes of
 * "authenticated" are both typed without `!` or `?.` in every controller:
 *
 *   - `userId` and `email` always exist — the authentication guard ran;
 *   - `organizationId` and `role` exist only on routes that require a tenant,
 *     so reading them on a `@SkipOrganization()` route throws instead of
 *     returning `undefined` and silently producing an unscoped query.
 */
export class CurrentUserContext {
  constructor(
    readonly userId: string,
    readonly email: string,
    private readonly tenant?: { organizationId: string; role: OrganizationRole },
  ) {}

  get organizationId(): string {
    if (this.tenant === undefined) {
      throw new UnauthenticatedError('No active organization for this request');
    }
    return this.tenant.organizationId;
  }

  get role(): OrganizationRole {
    if (this.tenant === undefined) {
      throw new UnauthenticatedError('No active organization for this request');
    }
    return this.tenant.role;
  }

  /** For handlers that legitimately work with or without a tenant. */
  get organizationIdOrNull(): string | null {
    return this.tenant?.organizationId ?? null;
  }
}

/**
 * Reads the caller from the request context.
 *
 * A parameter decorator rather than `request.user` because the value it returns
 * is typed. Handlers that use it are guaranteed a `userId`, so they never write
 * `if (!user)` for a case the guard already made impossible.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): CurrentUserContext => {
    // The context service is a singleton reading an AsyncLocalStorage, so the
    // decorator can reach it without the Nest injector.
    const context = CurrentUserContextHolder.service?.get();
    if (context?.userId === undefined || context.email === undefined) {
      void executionContext;
      throw new UnauthenticatedError();
    }

    return new CurrentUserContext(
      context.userId,
      context.email,
      context.organizationId === undefined || context.role === undefined
        ? undefined
        : { organizationId: context.organizationId, role: context.role },
    );
  },
);

/**
 * Parameter decorators are evaluated outside the injector, so the singleton is
 * handed to them once at bootstrap by AuthModule.
 */
export const CurrentUserContextHolder: { service?: TenantContextService } = {};
