import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { PROJECT_SCOPED_KEY } from '../decorators/project-scoped.decorator';

/**
 * Enforces the `@ProjectScoped` contract instead of trusting every service to
 * remember it.
 *
 * On a project-scoped route the guard only pre-filters on the organization
 * role; the real decision is `ProjectAccessService` once the service knows the
 * project. A route that declares `@Roles`/`@RequirePermission` and returns
 * without ever reaching that decision would answer on the organization role
 * alone — ignoring project grants and revoke overrides. This interceptor turns
 * that omission into a 403 (fail closed) and an error log, so a forgotten check
 * is a failing test rather than a silent data leak.
 */
@Injectable()
export class ProjectScopeContractInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ProjectScopeContractInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tenant: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    const projectScoped = this.reflector.getAllAndOverride<boolean>(PROJECT_SCOPED_KEY, targets);
    const store = this.tenant.get();
    if (projectScoped !== true || store === undefined) {
      return next.handle();
    }
    const declaresRequirements =
      (store.requiredRoles?.length ?? 0) > 0 || (store.requiredPermissions?.length ?? 0) > 0;
    if (!declaresRequirements) {
      return next.handle();
    }

    return next.handle().pipe(
      tap(() => {
        if (store.projectAccessChecked !== true) {
          this.logger.error(
            `Project-scoped route answered without a project access decision: ${context.getClass().name}.${context.getHandler().name}`,
          );
          throw new ForbiddenError('This action could not be authorized for a project');
        }
      }),
    );
  }
}
