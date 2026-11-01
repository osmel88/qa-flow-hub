import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BoardQuery,
  CloseSprintInput,
  CreateSprintInput,
  MoveBoardCardInput,
  ListSprintsQuery,
  SprintItemsInput,
  UpdateSprintInput,
  boardQuerySchema,
  closeSprintSchema,
  moveBoardCardSchema,
  createSprintSchema,
  listSprintsQuerySchema,
  sprintItemsSchema,
  updateSprintSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SprintBoardService } from './sprint-board.service';
import { SprintsService } from './sprints.service';

/**
 * Reading needs `work_items.read`; planning items into or out of a sprint
 * `work_items.write`; creating, editing and moving a sprint through its life
 * cycle `work_items.manage`. The board (S4-F6) is read with `work_items.read`
 * and its cards move with `work_items.write`.
 */
@ApiTags('sprints')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('sprints')
export class SprintsController {
  constructor(
    private readonly sprints: SprintsService,
    private readonly boards: SprintBoardService,
  ) {}

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
  @Get('board')
  @ApiOperation({ summary: 'Scrum board of the active (or given) sprint of a project' })
  board(
    @Query(zodQuery(boardQuerySchema)) query: BoardQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.boards.board(query, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post(':id/board/move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a card of the active sprint to a column and/or position' })
  moveCard(@Param('id') id: string, @Body(zodBody(moveBoardCardSchema)) body: MoveBoardCardInput) {
    return this.boards.move(id, body);
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
