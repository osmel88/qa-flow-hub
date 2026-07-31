import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { TenantContextService } from '../../../database/tenant-context.service';
import { UnauthenticatedError } from '../../../errors';

export interface CurrentUserContext {
  userId: string;
  organizationId?: string;
  role?: OrganizationRole;
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
    if (context?.userId === undefined) {
      void executionContext;
      throw new UnauthenticatedError();
    }
    return {
      userId: context.userId,
      ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
      ...(context.role === undefined ? {} : { role: context.role }),
    };
  },
);

/**
 * Parameter decorators are evaluated outside the injector, so the singleton is
 * handed to them once at bootstrap by AuthModule.
 */
export const CurrentUserContextHolder: { service?: TenantContextService } = {};
