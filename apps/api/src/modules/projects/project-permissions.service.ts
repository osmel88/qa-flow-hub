import { Injectable } from '@nestjs/common';
import { AuditAction, OrganizationRole, Project, ProjectPermissionOverride, ProjectStatus } from '@prisma/client';
import {
  MemberPermissionsView,
  PERMISSION_CATALOG,
  PermissionDescriptor,
  PermissionOverrideInput,
  PermissionOverrideView,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  SetPermissionOverridesInput,
  computeEffectivePermissions,
} from '@qa-flow-hub/shared';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { OrganizationMembersRepository } from '../organizations/organization-members.repository';
import { PermissionOverridesRepository } from './permission-overrides.repository';
import { ProjectAccessService, isPermission } from './project-access.service';
import { ProjectMembersRepository } from './project-members.repository';
import { ProjectsRepository } from './projects.repository';

/**
 * Reads and edits the third layer of project authorization: per-member
 * permission overrides. The first two layers (organization role, project role)
 * belong to `ProjectMembersService` and are only read here.
 *
 * Editing is governed by three refusals, each of which would otherwise be an
 * escalation:
 *
 *  1. an actor may only *grant* permissions they effectively hold in this very
 *     project — an override never introduces power that was not in the room;
 *  2. an actor may not edit their own overrides — a revoke would be undone by
 *     the person it was applied to;
 *  3. an owner's overrides are never written — the resolver ignores them, so a
 *     row would be a lie the UI could show and the backend never honours.
 *
 * Revoking is allowed against any permission the target holds: taking power
 * away is not an escalation. Rank still applies — a project manager cannot
 * touch the overrides of an administrator.
 */
@Injectable()
export class ProjectPermissionsService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly grants: ProjectMembersRepository,
    private readonly overrides: PermissionOverridesRepository,
    private readonly organizationMembers: OrganizationMembersRepository,
    private readonly access: ProjectAccessService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  catalog(): { permissions: readonly PermissionDescriptor[]; roles: typeof ROLE_PERMISSIONS } {
    return { permissions: PERMISSION_CATALOG, roles: ROLE_PERMISSIONS };
  }

  /** What the caller effectively holds here, with the source of each permission. */
  async mine(projectId: string): Promise<MemberPermissionsView> {
    await this.requireProject(projectId);
    return this.viewOf(projectId, this.tenant.requireUserId(), this.tenant.requireRole());
  }

  async forMember(projectId: string, userId: string): Promise<MemberPermissionsView> {
    await this.requireProject(projectId);
    const target = await this.requireOrganizationMember(userId);
    return this.viewOf(projectId, userId, target.role);
  }

  async listForProject(projectId: string): Promise<PermissionOverrideView[]> {
    await this.requireProject(projectId);
    const rows = await this.overrides.listForProject(projectId);
    return rows.filter((row) => isPermission(row.permission)).map(toOverrideView);
  }

  async replace(
    projectId: string,
    userId: string,
    input: SetPermissionOverridesInput,
  ): Promise<MemberPermissionsView> {
    const project = await this.requireProject(projectId);
    const target = await this.requireOrganizationMember(userId);

    await this.assertMayEdit(project, userId, target.role, input.overrides);

    const previous = await this.overrides.listForMember(projectId, userId);
    const next = await this.overrides.replaceForMember(
      projectId,
      userId,
      input.overrides,
      this.tenant.requireUserId(),
    );

    await this.audit.record({
      action: AuditAction.role_change,
      entityType: 'ProjectPermissionOverride',
      entityId: `${projectId}:${userId}`,
      summary: `Set ${next.length} permission override(s) on ${project.key} for a member`,
      changes: {
        projectId,
        userId,
        previous: previous.map(({ permission, effect }) => ({ permission, effect })),
        next: next.map(({ permission, effect }) => ({ permission, effect })),
      },
    });

    return this.viewOf(projectId, userId, target.role);
  }

  private async assertMayEdit(
    project: Project,
    targetUserId: string,
    targetOrganizationRole: OrganizationRole,
    overrides: readonly PermissionOverrideInput[],
  ): Promise<void> {
    if (project.status === ProjectStatus.archived) {
      throw new ConflictError('Restore the project before changing its members');
    }
    if (targetUserId === this.tenant.requireUserId()) {
      throw new ForbiddenError('You cannot change your own permissions in a project');
    }
    if (targetOrganizationRole === OrganizationRole.organization_owner) {
      throw new ForbiddenError('An organization owner always holds every permission');
    }

    const actorRole = await this.access.effectiveRole(project.id);
    if (ROLE_RANK[targetOrganizationRole] < ROLE_RANK[actorRole]) {
      throw new ForbiddenError('You cannot change the permissions of a more powerful member');
    }

    const held = await this.access.effectivePermissions(project.id);
    const beyondReach = overrides
      .filter((override) => override.effect === 'grant' && !held.has(override.permission))
      .map((override) => override.permission);
    if (beyondReach.length > 0) {
      throw new ForbiddenError(
        `You cannot grant permissions you do not hold in this project: ${beyondReach.join(', ')}`,
      );
    }
  }

  private async viewOf(
    projectId: string,
    userId: string,
    organizationRole: OrganizationRole,
  ): Promise<MemberPermissionsView> {
    const [grant, rows] = await Promise.all([
      this.grants.findGrant(projectId, userId),
      this.overrides.listForMember(projectId, userId),
    ]);

    const projectRole = grant?.role ?? null;
    const effectiveRole =
      organizationRole === OrganizationRole.organization_owner
        ? organizationRole
        : (projectRole ?? organizationRole);

    const overrides = rows.filter((row) => isPermission(row.permission));

    return {
      projectId,
      userId,
      organizationRole,
      projectRole,
      effectiveRole,
      overrides: overrides.map(toOverrideView),
      permissions: computeEffectivePermissions(
        effectiveRole,
        overrides.flatMap((row) =>
          isPermission(row.permission) ? [{ permission: row.permission, effect: row.effect }] : [],
        ),
      ),
    };
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    await this.access.assertRouteAccess(project.id);
    return project;
  }

  private async requireOrganizationMember(userId: string) {
    const member = await this.organizationMembers.findActiveMembership(
      userId,
      this.tenant.requireOrganizationId(),
    );
    if (member === null) {
      throw new NotFoundError('Member');
    }
    return member;
  }
}

function toOverrideView(row: ProjectPermissionOverride): PermissionOverrideView {
  if (!isPermission(row.permission)) {
    throw new Error(`Unknown permission stored: ${row.permission}`);
  }
  return {
    permission: row.permission,
    effect: row.effect,
    grantedById: row.grantedById,
    updatedAt: row.updatedAt.toISOString(),
  };
}
