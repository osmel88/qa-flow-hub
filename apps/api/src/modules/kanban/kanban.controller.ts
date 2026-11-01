import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  KanbanQuery,
  MoveKanbanCardInput,
  UpdateWipLimitsInput,
  kanbanQuerySchema,
  moveKanbanCardSchema,
  updateWipLimitsSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { KanbanService } from './kanban.service';

/**
 * The Kanban board (S4-F7) is read with `work_items.read`, its cards move with
 * `work_items.write` and its WIP limits change with `work_items.manage`.
 */
@ApiTags('kanban')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('kanban')
export class KanbanController {
  constructor(private readonly kanban: KanbanService) {}

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'Kanban board of a project with WIP limits and flow metrics' })
  board(
    @Query(zodQuery(kanbanQuerySchema)) query: KanbanQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.kanban.board(query, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post('move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a card to a status column and/or position' })
  move(@Body(zodBody(moveKanbanCardSchema)) body: MoveKanbanCardInput) {
    return this.kanban.move(body);
  }

  @RequirePermission('work_items.manage')
  @Put('wip-limits')
  @ApiOperation({ summary: 'Set or clear the WIP limits of the board columns' })
  async setWipLimits(
    @Body(zodBody(updateWipLimitsSchema)) body: UpdateWipLimitsInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return { wipLimits: await this.kanban.setWipLimits(body, user.userId) };
  }
}
