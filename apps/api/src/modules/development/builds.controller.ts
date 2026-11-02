import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BuildMetricsQuery,
  CreateBuildInput,
  ListBuildsQuery,
  TransitionBuildInput,
  UpdateBuildInput,
  buildMetricsQuerySchema,
  createBuildSchema,
  listBuildsQuerySchema,
  transitionBuildSchema,
  updateBuildSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { BuildsService } from './builds.service';

/**
 * Builds (S5-F4): reading needs `work_items.read`; reporting, moving and
 * editing a build `work_items.write`. Linking work items and deleting use the
 * development artifact routes (a build is a `build` artifact).
 */
@ApiTags('builds')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('builds')
export class BuildsController {
  constructor(private readonly builds: BuildsService) {}

  @RequirePermission('work_items.write')
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Report a build; idempotent per provider and externalId' })
  create(
    @Body(zodBody(createBuildSchema)) body: CreateBuildInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.builds.create(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'Builds of a project, filtered by status, provider, branch or release' })
  list(@Query(zodQuery(listBuildsQuerySchema)) query: ListBuildsQuery) {
    return this.builds.list(query);
  }

  @RequirePermission('work_items.read')
  @Get('metrics')
  @ApiOperation({ summary: 'Success and failure rate and durations over a window' })
  metrics(@Query(zodQuery(buildMetricsQuerySchema)) query: BuildMetricsQuery) {
    return this.builds.metrics(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({ summary: 'A build with its work items, release and related branch/commit' })
  get(@Param('id') id: string) {
    return this.builds.get(id);
  }

  @RequirePermission('work_items.write')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit title, URL, branch, commit, release, metadata or log summary' })
  update(@Param('id') id: string, @Body(zodBody(updateBuildSchema)) body: UpdateBuildInput) {
    return this.builds.update(id, body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/transition')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a build: queued → running → passed/failed/cancelled' })
  transition(
    @Param('id') id: string,
    @Body(zodBody(transitionBuildSchema)) body: TransitionBuildInput,
  ) {
    return this.builds.transition(id, body);
  }
}
