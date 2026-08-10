import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { TenantContextService } from '../../../database/tenant-context.service';
import { ForbiddenError } from '../../../errors';
import { ProjectAccessService } from '../../projects/project-access.service';
import { PROJECT_SCOPED_KEY } from '../decorators/project-scoped.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolesGuard } from './roles.guard';

/**
 * A stub that answers the two metadata keys the guard reads. Simpler and more
 * readable than mocking Reflector, and it fails to compile if the guard starts
 * asking for something else.
 */
function reflectorReturning(
  roles: OrganizationRole[] | undefined,
  projectScoped: boolean,
): Reflector {
  const reflector = new Reflector();
  reflector.getAllAndOverride = ((key: string) => {
    if (key === ROLES_KEY) {
      return roles;
    }
    return key === PROJECT_SCOPED_KEY ? projectScoped : undefined;
  }) as unknown as Reflector['getAllAndOverride'];
  return reflector;
}

const executionContext = {
  getHandler: () => undefined,
  getClass: () => undefined,
} as unknown as ExecutionContext;

interface GuardOptions {
  required?: OrganizationRole[];
  actual?: OrganizationRole;
  projectScoped?: boolean;
  /** What a grant lookup would find, if the guard gets that far. */
  grantRoles?: OrganizationRole[];
}

function guardWith(options: GuardOptions): () => Promise<boolean> {
  const context = new TenantContextService();
  const access = {
    mayHoldGrantFor: (roles: readonly OrganizationRole[]) =>
      Promise.resolve((options.grantRoles ?? []).some((role) => roles.includes(role))),
  } as unknown as ProjectAccessService;
  const guard = new RolesGuard(
    reflectorReturning(options.required, options.projectScoped ?? false),
    context,
    access,
  );

  return () =>
    context.run(
      {
        requestId: 'test',
        userId: 'user',
        organizationId: 'org',
        ...(options.actual === undefined ? {} : { role: options.actual }),
      },
      () => guard.canActivate(executionContext),
    );
}

describe('RolesGuard', () => {
  it('lets a handler with no @Roles through', async () => {
    await expect(guardWith({ actual: OrganizationRole.viewer })()).resolves.toBe(true);
  });

  it('lets a matching role through', async () => {
    const run = guardWith({
      required: [OrganizationRole.organization_owner, OrganizationRole.qa_lead],
      actual: OrganizationRole.qa_lead,
    });
    await expect(run()).resolves.toBe(true);
  });

  it('rejects a role that is not listed', async () => {
    const run = guardWith({
      required: [OrganizationRole.organization_owner],
      actual: OrganizationRole.tester,
    });
    await expect(run()).rejects.toThrow(ForbiddenError);
  });

  it('rejects when no role was resolved', async () => {
    // Reaching a role check without a resolved role means the organization
    // guard did not run. Failing closed is the only safe answer.
    const run = guardWith({ required: [OrganizationRole.viewer] });
    await expect(run()).rejects.toThrow(ForbiddenError);
  });

  it('does not consider grants on a route that is not project-scoped', async () => {
    // Creating a project is the case this protects: no project exists yet, so a
    // grant elsewhere must not become permission to create one.
    const run = guardWith({
      required: [OrganizationRole.organization_admin],
      actual: OrganizationRole.tester,
      grantRoles: [OrganizationRole.organization_admin],
    });
    await expect(run()).rejects.toThrow(ForbiddenError);
  });

  it('lets a project-scoped route through when a grant could allow it', async () => {
    const run = guardWith({
      required: [OrganizationRole.qa_lead],
      actual: OrganizationRole.tester,
      projectScoped: true,
      grantRoles: [OrganizationRole.qa_lead],
    });
    // True here means "some project might allow this", not "this one does": the
    // service re-checks against the project it resolves.
    await expect(run()).resolves.toBe(true);
  });

  it('still rejects a project-scoped route when no grant matches', async () => {
    const run = guardWith({
      required: [OrganizationRole.qa_lead],
      actual: OrganizationRole.tester,
      projectScoped: true,
      grantRoles: [OrganizationRole.viewer],
    });
    await expect(run()).rejects.toThrow(ForbiddenError);
  });

  it('never lets an unauthenticated request through on a grant', async () => {
    const run = guardWith({
      required: [OrganizationRole.qa_lead],
      projectScoped: true,
      grantRoles: [OrganizationRole.qa_lead],
    });
    await expect(run()).rejects.toThrow(ForbiddenError);
  });

  it('exposes the route roles so the project check does not restate them', async () => {
    const context = new TenantContextService();
    const access = {
      mayHoldGrantFor: () => Promise.resolve(false),
    } as unknown as ProjectAccessService;
    const guard = new RolesGuard(
      reflectorReturning([OrganizationRole.qa_lead], false),
      context,
      access,
    );

    await context.run(
      { requestId: 'test', userId: 'user', organizationId: 'org', role: OrganizationRole.qa_lead },
      async () => {
        await guard.canActivate(executionContext);
        expect(context.requiredRoles).toEqual([OrganizationRole.qa_lead]);
      },
    );
  });
});
