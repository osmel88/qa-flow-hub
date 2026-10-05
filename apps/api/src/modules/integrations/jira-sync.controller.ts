import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ListExternalIssuesQuery,
  ListExternalReferencesQuery,
  listExternalIssuesQuerySchema,
  listExternalReferencesQuerySchema,
} from '@qa-flow-hub/shared';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JiraSyncService } from './jira-sync.service';

/**
 * The Jira side of the integration: browse the tracker, push our entities.
 *
 * Browsing is organization-scoped and open to any member, like the settings
 * screen it complements. Synchronising is project-scoped and inherits the roles
 * of the entity it pushes — whoever may edit a requirement may sync it, whoever
 * may report a defect may sync it — because creating an issue in somebody
 * else's tracker is at least as consequential as editing the record here.
 *
 * Routes live under `/integrations/jira/...` and stay clear of the settings
 * controller's `/integrations/:provider/<verb>` shape by having more segments.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('integrations/jira')
export class JiraSyncController {
  constructor(private readonly jira: JiraSyncService) {}

  @Get('projects')
  @ApiOperation({ summary: 'Projects the connected Jira exposes' })
  listProjects() {
    return this.jira.listProjects();
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Priorities, statuses and assignees the connected Jira accepts' })
  describe() {
    return this.jira.describe();
  }

  @Get('issues')
  @ApiOperation({ summary: 'Issues in the connected Jira, optionally by project or kind' })
  listIssues(@Query(zodQuery(listExternalIssuesQuerySchema)) query: ListExternalIssuesQuery) {
    return this.jira.listIssues(query);
  }

  @ProjectScoped()
  @RequirePermission('integrations.read')
  @Get('references')
  @ApiOperation({ summary: 'Jira references of every requirement or defect in a project' })
  listReferences(
    @Query(zodQuery(listExternalReferencesQuerySchema)) query: ListExternalReferencesQuery,
  ) {
    return this.jira.listReferences(query.projectId, query.entityType);
  }

  @ProjectScoped()
  @RequirePermission('requirements.write')
  @Post('sync/requirements/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or update the Jira issue for a requirement' })
  syncRequirement(@Param('id') id: string) {
    return this.jira.syncRequirement(id);
  }

  @ProjectScoped()
  @RequirePermission('defects.create')
  @Post('sync/defects/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or update the Jira bug for a defect' })
  syncDefect(@Param('id') id: string) {
    return this.jira.syncDefect(id);
  }
}
