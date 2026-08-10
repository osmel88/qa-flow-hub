import { Injectable } from '@nestjs/common';
import { AuditAction, OrganizationRole, Project, ProjectStatus } from '@prisma/client';
import {
  GrantProjectRoleInput,
  ListMembersQuery,
  Paginated,
  ProjectMemberView,
  ROLE_RANK,
  UpdateProjectRoleInput,
} from '@qa-flow-hub/shared';
import { TenantContextService } from '../../database/tenant-context.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import {
  MemberWithUser,
  OrganizationMembersRepository,
} from '../organizations/organization-members.repository';
import { ProjectAccessService } from './project-access.service';
import { ProjectMembersRepository } from './project-members.repository';
import { ProjectsRepository } from './projects.repository';

/**
 * Management of project grants.
 *
 * The rules mirror the organization ones, for the same reasons: a grant must
 * never let somebody end up outranked by a person they themselves appointed,
 * and self-service role changes remove the second pair of eyes that makes
 * privilege changes reviewable.
 */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly projects: ProjectsRepository,
    private readonly grants: ProjectMembersRepository,
    private readonly organizationMembers: OrganizationMembersRepository,
    private readonly access: ProjectAccessService,
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists everybody in the organization together with the role that applies in
   * this project. Organization members without a grant are included on purpose:
   * the page has to answer "who can do what here", and leaving out the people
   * who reach the project through their organization role would answer a
   * different, misleading question.
   */
  async list(projectId: string, query: ListMembersQuery): Promise<Paginated<ProjectMemberView>> {
    await this.requireProject(projectId);

    const [members, grants] = await Promise.all([
      this.organizationMembers.listWithUsers(
        this.tenant.requireOrganizationId(),
        query,
        query.search,
      ),
      this.grants.listWithUsers(projectId),
    ]);

    const grantByUser = new Map(grants.map((grant) => [grant.userId, grant]));

    return {
      data: members.data.map((member) =>
        toProjectMemberView(member, grantByUser.get(member.userId) ?? null),
      ),
      meta: members.meta,
    };
  }

  async grant(projectId: string, input: GrantProjectRoleInput): Promise<ProjectMemberView> {
    const project = await this.requireProject(projectId);
    const target = await this.requireOrganizationMember(input.userId);

    await this.assertMayAssign(project, input.userId, input.role, target.role);

    const grant = await this.grants.upsert(projectId, input.userId, input.role);

    await this.audit.record({
      action: AuditAction.role_change,
      entityType: 'ProjectMember',
      entityId: grant.id,
      summary: `Granted ${input.role} on ${project.key} to a member`,
      changes: { projectId, userId: input.userId, role: input.role },
    });

    return this.viewOf(projectId, input.userId);
  }

  update(
    projectId: string,
    userId: string,
    input: UpdateProjectRoleInput,
  ): Promise<ProjectMemberView> {
    // Same operation as granting: one row per person per project, so "change
    // the role" and "give a role" cannot diverge in their rules.
    return this.grant(projectId, { userId, role: input.role });
  }

  /** Revokes the grant, which returns the person to their organization role. */
  async revoke(projectId: string, userId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const target = await this.requireOrganizationMember(userId);

    const grant = await this.grants.findGrant(projectId, userId);
    if (grant === null) {
      throw new NotFoundError('Project grant');
    }

    // A row whose role is null carries no override, so revoking it changes
    // nothing about power: the target's organization role is what to compare.
    await this.assertMayAssign(project, userId, grant.role ?? target.role, target.role);

    await this.grants.remove(projectId, userId);

    await this.audit.record({
      action: AuditAction.delete,
      entityType: 'ProjectMember',
      entityId: grant.id,
      summary: `Revoked the ${grant.role} grant on ${project.key}`,
      changes: { projectId, userId, previousRole: grant.role },
    });
  }

  /**
   * The three refusals, each of which is a real escalation if allowed:
   *
   *  1. granting above your own effective role in this project — an admin
   *     narrowed to `tester` here must not be able to make somebody `qa_lead`;
   *  2. changing your own grant — otherwise a narrowing is undone by the person
   *     it was applied to;
   *  3. touching an organization owner's grant — owners are not narrowed at all,
   *     so a row for them would be a lie the guard ignores.
   */
  private async assertMayAssign(
    project: Project,
    targetUserId: string,
    role: OrganizationRole,
    targetOrganizationRole: OrganizationRole,
  ): Promise<void> {
    if (project.status === ProjectStatus.archived) {
      throw new ConflictError('Restore the project before changing its members');
    }
    if (targetUserId === this.tenant.requireUserId()) {
      throw new ForbiddenError('You cannot change your own role in a project');
    }
    if (targetOrganizationRole === OrganizationRole.organization_owner) {
      throw new ForbiddenError('An organization owner cannot be scoped down to a project role');
    }

    const actorRole = await this.access.effectiveRole(project.id);
    if (ROLE_RANK[role] < ROLE_RANK[actorRole]) {
      throw new ForbiddenError('You cannot grant a role more powerful than your own');
    }
    if (ROLE_RANK[targetOrganizationRole] < ROLE_RANK[actorRole]) {
      throw new ForbiddenError('You cannot change the project role of a more powerful member');
    }
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (project === null) {
      // Another tenant's project is a plain 404, as everywhere else.
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
      // A grant is a narrowing of an organization role: without one there is
      // nothing to narrow, and inviting into a project is not a way around
      // joining the organization.
      throw new NotFoundError('Member');
    }
    return member;
  }

  private async viewOf(projectId: string, userId: string): Promise<ProjectMemberView> {
    const [member, grant] = await Promise.all([
      this.organizationMembers.findWithUser(this.tenant.requireOrganizationId(), userId),
      this.grants.findGrant(projectId, userId),
    ]);
    if (member === null) {
      throw new NotFoundError('Member');
    }
    return toProjectMemberView(member, grant);
  }
}

function toProjectMemberView(
  member: MemberWithUser,
  grant: { role: OrganizationRole | null; createdAt: Date } | null,
): ProjectMemberView {
  const projectRole = grant?.role ?? null;

  return {
    userId: member.userId,
    email: member.user.email,
    fullName: member.user.fullName,
    avatarUrl: member.user.avatarUrl,
    organizationRole: member.role,
    projectRole,
    // An owner is never narrowed, so their effective role is their own.
    effectiveRole:
      member.role === OrganizationRole.organization_owner
        ? member.role
        : (projectRole ?? member.role),
    grantedAt: grant?.createdAt.toISOString() ?? null,
  };
}
