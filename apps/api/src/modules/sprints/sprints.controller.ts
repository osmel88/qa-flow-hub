import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CloseSprintInput,
  CreateSprintInput,
  ListSprintsQuery,
  SprintItemsInput,
  UpdateSprintInput,
  closeSprintSchema,
  createSprintSchema,
  listSprintsQuerySchema,
  sprintItemsSchema,
  updateSprintSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SprintsService } from './sprints.service';

/**
 * Reading needs `work_items.read`; planning items into or out of a sprint
 * `work_items.write`; creating, editing and moving a sprint through its life
 * cycle `work_items.manage`.
 */
@ApiTags('sprints')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('sprints')
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @RequirePermission('work_items.manage')
  @Post()
  @ApiOperation({ summary: 'Plan a sprint of a project' })
  create(
    @Body(zodBody(createSprintSchema)) body: CreateSprintInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.sprints.create(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'List the sprints of a project with its velocity' })
  list(@Query(zodQuery(listSprintsQuerySchema)) query: ListSprintsQuery) {
    return this.sprints.list(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({ summary: 'A sprint with its backlog and metrics' })
  get(@Param('id') id: string) {
    return this.sprints.get(id);
  }

  @RequirePermission('work_items.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a planned or active sprint' })
  update(@Param('id') id: string, @Body(zodBody(updateSprintSchema)) body: UpdateSprintInput) {
    return this.sprints.update(id, body);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a planned sprint (one active sprint per project)' })
  start(@Param('id') id: string) {
    return this.sprints.start(id);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete the active sprint and carry unfinished items over' })
  complete(@Param('id') id: string, @Body(zodBody(closeSprintSchema)) body: CloseSprintInput) {
    return this.sprints.complete(id, body);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a planned or active sprint and carry its items over' })
  cancel(@Param('id') id: string, @Body(zodBody(closeSprintSchema)) body: CloseSprintInput) {
    return this.sprints.cancel(id, body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Plan work items into an open sprint' })
  addItems(@Param('id') id: string, @Body(zodBody(sprintItemsSchema)) body: SprintItemsInput) {
    return this.sprints.addItems(id, body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/items/remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send work items of an open sprint back to the backlog' })
  removeItems(@Param('id') id: string, @Body(zodBody(sprintItemsSchema)) body: SprintItemsInput) {
    return this.sprints.removeItems(id, body);
  }
}
