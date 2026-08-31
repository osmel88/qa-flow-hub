import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError, UnauthenticatedError } from '../../../errors';
import { OrganizationMembersRepository } from '../../organizations/organization-members.repository';
import { SKIP_ORGANIZATION_KEY } from '../decorators/skip-organization.decorator';

export const ORGANIZATION_HEADER = 'x-organization-id';

/**
 * Resolves the active organization and proves the caller belongs to it.
 *
 * The organization arrives in a header rather than in the access token on
 * purpose. Putting it in the token would mean re-issuing tokens to switch
 * organization, and — worse — a token would keep asserting a membership that
 * may have been revoked minutes ago. Here, membership is verified against the
 * database on every request, so removing somebody takes effect immediately.
 *
 * The header is a *claim*, not a permission: it says which organization the
 * caller wants to act for, and this guard decides whether they may.
 */
@Injectable()
export class ActiveOrganizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly members: OrganizationMembersRepository,
    private readonly context: TenantContextService,
  ) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    // A public route has no user, so it can have no organization either.
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ORGANIZATION_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);
    if (skip === true || isPublic === true) {
      return true;
    }

    const userId = this.context.userId;
    if (userId === undefined) {
      // Reached only if this guard is used without the authentication guard.
      throw new UnauthenticatedError();
    }

    const request = executionContext.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers[ORGANIZATION_HEADER];
    const organizationId = Array.isArray(header) ? header[0] : header;

    if (organizationId === undefined || organizationId.length === 0) {
      throw new ForbiddenError(
        `Select an organization first: send the ${ORGANIZATION_HEADER} header`,
      );
    }

    const membership = await this.members.findActiveMembership(userId, organizationId);
    if (membership === null) {
      // Same answer whether the organization does not exist or the caller is
      // simply not a member: the difference would confirm that a tenant exists.
      throw new ForbiddenError('You are not a member of this organization');
    }

    this.context.setOrganization(membership.organizationId, membership.role);
    return true;
  }
}
