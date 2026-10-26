import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BacklogQuery,
  BulkUpdateWorkItemsInput,
  MoveWorkItemInput,
  backlogQuerySchema,
  bulkUpdateWorkItemsSchema,
  moveWorkItemSchema,
  CreateWorkItemInput,
  ListWorkItemsQuery,
  UpdateWorkItemInput,
  createWorkItemSchema,
  listWorkItemsQuerySchema,
  updateWorkItemSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { WorkItemsService } from './work-items.service';

@ApiTags('work-items')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('work-items')
export class WorkItemsController {
  constructor(private readonly items: WorkItemsService) {}

  @RequirePermission('work_items.write')
  @Post()
  @ApiOperation({ summary: 'Add a work item to the backlog of a project' })
  create(
    @Body(zodBody(createWorkItemSchema)) body: CreateWorkItemInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.items.create(body, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post('bulk')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply the same change to up to 100 work items, all or nothing' })
  bulk(@Body(zodBody(bulkUpdateWorkItemsSchema)) body: BulkUpdateWorkItemsInput) {
    return this.items.bulkUpdate(body);
  }

  @RequirePermission('work_items.write')
  @Post(':id/move')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reorder the backlog: place an item before or after another' })
  move(@Param('id') id: string, @Body(zodBody(moveWorkItemSchema)) body: MoveWorkItemInput) {
    return this.items.move(id, body);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'List and search the work items of a project' })
  list(@Query(zodQuery(listWorkItemsQuerySchema)) query: ListWorkItemsQuery) {
    return this.items.list(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({ summary: 'Get a work item with its ancestors and children' })
  get(@Param('id') id: string) {
    return this.items.get(id);
  }

  @RequirePermission('work_items.write')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a work item (send `version` to avoid overwriting others)' })
  update(@Param('id') id: string, @Body(zodBody(updateWorkItemSchema)) body: UpdateWorkItemInput) {
    return this.items.update(id, body);
  }

  @RequirePermission('work_items.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft delete a work item without children' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.items.remove(id);
  }
}

@ApiTags('work-items')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('backlog')
export class BacklogController {
  constructor(private readonly items: WorkItemsService) {}

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'The ordered backlog of a project, optionally grouped and personal' })
  get(
    @Query(zodQuery(backlogQuerySchema)) query: BacklogQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.items.backlog(query, user.userId);
  }
}
