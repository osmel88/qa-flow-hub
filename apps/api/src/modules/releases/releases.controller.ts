import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateReleaseInput,
  ListReleasesQuery,
  UpdateReleaseInput,
  createReleaseSchema,
  listReleasesQuerySchema,
  updateReleaseSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ReleasesService } from './releases.service';

@ApiTags('releases')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('releases')
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @RequirePermission('releases.manage')
  @Post()
  @ApiOperation({ summary: 'Plan a release of a project' })
  create(
    @Body(zodBody(createReleaseSchema)) body: CreateReleaseInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.releases.create(body, user.userId);
  }

  @RequirePermission('releases.read')
  @Get()
  @ApiOperation({ summary: 'List a project’s releases' })
  list(@Query(zodQuery(listReleasesQuerySchema)) query: ListReleasesQuery) {
    return this.releases.list(query);
  }

  @RequirePermission('releases.read')
  @Get(':id')
  @ApiOperation({ summary: 'Get a release' })
  get(@Param('id') id: string) {
    return this.releases.get(id);
  }

  @RequirePermission('releases.read')
  @Get(':id/summary')
  @ApiOperation({ summary: 'Release dashboard: runs, latest case results, coverage, defects' })
  summary(@Param('id') id: string) {
    return this.releases.summary(id);
  }

  @RequirePermission('releases.read')
  @Get(':id/traceability')
  @ApiOperation({ summary: 'Requirements → cases → latest result in the release' })
  traceability(@Param('id') id: string) {
    return this.releases.traceability(id);
  }

  @RequirePermission('releases.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a release that is not archived' })
  update(@Param('id') id: string, @Body(zodBody(updateReleaseSchema)) body: UpdateReleaseInput) {
    return this.releases.update(id, body);
  }

  @RequirePermission('releases.manage')
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a planned release to in progress' })
  start(@Param('id') id: string) {
    return this.releases.transition(id, 'in_progress');
  }

  @RequirePermission('releases.manage')
  @Post(':id/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a release as shipped; no more runs can be attached' })
  ship(@Param('id') id: string) {
    return this.releases.transition(id, 'released');
  }

  @RequirePermission('releases.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a release; its runs and results are kept' })
  archive(@Param('id') id: string) {
    return this.releases.transition(id, 'archived');
  }
}
