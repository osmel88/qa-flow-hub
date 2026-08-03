import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * A stub that answers a single metadata key. Simpler and more readable than
 * mocking Reflector, and it fails to compile if the guard starts asking for
 * something else.
 */
function reflectorReturning(roles: OrganizationRole[] | undefined): Reflector {
  const reflector = new Reflector();
  reflector.getAllAndOverride = ((key: string) =>
    key === ROLES_KEY ? roles : undefined) as unknown as Reflector['getAllAndOverride'];
  return reflector;
}

const executionContext = {
  getHandler: () => undefined,
  getClass: () => undefined,
} as unknown as ExecutionContext;

function guardWithRole(
  required: OrganizationRole[] | undefined,
  actual: OrganizationRole | undefined,
): () => boolean {
  const context = new TenantContextService();
  const guard = new RolesGuard(reflectorReturning(required), context);

  return () =>
    context.run(
      {
        requestId: 'test',
        userId: 'user',
        organizationId: 'org',
        ...(actual === undefined ? {} : { role: actual }),
      },
      () => guard.canActivate(executionContext),
    );
}

describe('RolesGuard', () => {
  it('lets a handler with no @Roles through', () => {
    expect(guardWithRole(undefined, OrganizationRole.viewer)()).toBe(true);
  });

  it('lets a matching role through', () => {
    const run = guardWithRole(
      [OrganizationRole.organization_owner, OrganizationRole.qa_lead],
      OrganizationRole.qa_lead,
    );
    expect(run()).toBe(true);
  });

  it('rejects a role that is not listed', () => {
    const run = guardWithRole([OrganizationRole.organization_owner], OrganizationRole.tester);
    expect(run).toThrow(ForbiddenError);
  });

  it('rejects when no role was resolved', () => {
    // Reaching a role check without a resolved role means the organization
    // guard did not run. Failing closed is the only safe answer.
    const run = guardWithRole([OrganizationRole.viewer], undefined);
    expect(run).toThrow(ForbiddenError);
  });
});
