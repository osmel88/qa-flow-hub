import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateEnvironmentInput,
  EnvironmentVersionInput,
  ListEnvironmentsQuery,
  UpdateEnvironmentInput,
  createEnvironmentSchema,
  environmentVersionSchema,
  listEnvironmentsQuerySchema,
  updateEnvironmentSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { EnvironmentsService } from './environments.service';

/**
 * Environments (S6-F1): reading needs `work_items.read`; creating, editing,
 * archiving, restoring and deleting `work_items.manage`.
 */
@ApiTags('environments')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'Environments of a project, filtered, with health and what runs there' })
  list(@Query(zodQuery(listEnvironmentsQuerySchema)) query: ListEnvironmentsQuery) {
    return this.environments.list(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({ summary: 'An environment with its current and last deployment' })
  get(@Param('id') id: string) {
    return this.environments.get(id);
  }

  @RequirePermission('work_items.manage')
  @Post()
  @ApiOperation({ summary: 'Create an environment (production starts protected)' })
  create(
    @Body(zodBody(createEnvironmentSchema)) body: CreateEnvironmentInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.environments.create(body, user.userId);
  }

  @RequirePermission('work_items.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an environment; optional version for optimistic concurrency' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateEnvironmentSchema)) body: UpdateEnvironmentInput,
  ) {
    return this.environments.update(id, body);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive an environment, keeping its deployment history' })
  archive(
    @Param('id') id: string,
    @Body(zodBody(environmentVersionSchema)) body: EnvironmentVersionInput,
  ) {
    return this.environments.archive(id, body);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring an archived environment back as active' })
  restore(
    @Param('id') id: string,
    @Body(zodBody(environmentVersionSchema)) body: EnvironmentVersionInput,
  ) {
    return this.environments.restore(id, body);
  }

  @RequirePermission('work_items.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an environment that never had a deployment; otherwise archive it',
  })
  async remove(@Param('id') id: string): Promise<void> {
    await this.environments.remove(id);
  }
}
