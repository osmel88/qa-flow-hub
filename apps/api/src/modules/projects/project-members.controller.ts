import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GrantProjectRoleInput,
  ListMembersQuery,
  UpdateProjectRoleInput,
  grantProjectRoleSchema,
  listMembersQuerySchema,
  updateProjectRoleSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProjectMembersService } from './project-members.service';

/**
 * Who may do what inside one project.
 *
 * Note that granting is allowed to `project_manager` as well as to the two
 * organization-wide roles: deciding who works on a project is the project
 * manager's job, and routing it through an administrator is how permissions end
 * up stale. The rank rules in the service are what keep that safe.
 */
@ApiTags('projects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('projects/:projectId/members')
export class ProjectMembersController {
  constructor(private readonly members: ProjectMembersService) {}

  /** No `@Roles`: any member may see who works on a project. */
  @Get()
  @ApiOperation({ summary: 'List the effective role of every member in a project' })
  list(
    @Param('projectId') projectId: string,
    @Query(zodQuery(listMembersQuerySchema)) query: ListMembersQuery,
  ) {
    return this.members.list(projectId, query);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Grant a member a role that applies only in this project' })
  grant(
    @Param('projectId') projectId: string,
    @Body(zodBody(grantProjectRoleSchema)) body: GrantProjectRoleInput,
  ) {
    return this.members.grant(projectId, body);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Patch(':userId')
  @ApiOperation({ summary: 'Change the role a member holds in this project' })
  update(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body(zodBody(updateProjectRoleSchema)) body: UpdateProjectRoleInput,
  ) {
    return this.members.update(projectId, userId, body);
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Delete(':userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the grant, returning the member to their organization role' })
  revoke(@Param('projectId') projectId: string, @Param('userId') userId: string) {
    return this.members.revoke(projectId, userId);
  }
}
