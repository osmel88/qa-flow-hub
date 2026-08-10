import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
  createProjectSchema,
  listProjectsQuerySchema,
  updateProjectSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Not `@ProjectScoped`: there is no project yet, so no grant can widen this.
   * Creating projects stays an organization-level decision.
   */
  @Roles('organization_owner', 'organization_admin')
  @Post()
  @ApiOperation({ summary: 'Create a project' })
  create(@Body(zodBody(createProjectSchema)) body: CreateProjectInput) {
    return this.projects.create(body);
  }

  /**
   * No `@Roles`: every member of the organization may list projects. The tenant
   * filter is not a permission — it is applied by the repository regardless of
   * role, which is why "readable by everyone here" is safe to state.
   */
  @Get()
  @ApiOperation({ summary: 'List projects with filters and pagination' })
  list(@Query(zodQuery(listProjectsQuerySchema)) query: ListProjectsQuery) {
    return this.projects.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Project detail' })
  get(@Param('id') id: string) {
    return this.projects.get(id);
  }

  @ProjectScoped()
  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Patch(':id')
  @ApiOperation({ summary: 'Rename a project or change its description' })
  update(@Param('id') id: string, @Body(zodBody(updateProjectSchema)) body: UpdateProjectInput) {
    return this.projects.update(id, body);
  }

  @ProjectScoped()
  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a project, making it read-only' })
  archive(@Param('id') id: string) {
    return this.projects.archive(id);
  }

  @ProjectScoped()
  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring an archived project back' })
  restore(@Param('id') id: string) {
    return this.projects.restore(id);
  }
}
