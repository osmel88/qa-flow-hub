import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateDevelopmentArtifactInput,
  LinkDevelopmentArtifactInput,
  LinkDevelopmentWorkItemInput,
  ListDevelopmentArtifactsQuery,
  UpdateDevelopmentArtifactInput,
  createDevelopmentArtifactSchema,
  linkDevelopmentArtifactSchema,
  linkDevelopmentWorkItemSchema,
  listDevelopmentArtifactsQuerySchema,
  updateDevelopmentArtifactSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { DevelopmentService } from './development.service';

/**
 * Development links (S5-F1): reading needs `work_items.read`; recording,
 * editing, linking and unlinking `work_items.write`; deleting an artifact
 * `work_items.manage`.
 */
@ApiTags('development')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('development-artifacts')
export class DevelopmentArtifactsController {
  constructor(private readonly development: DevelopmentService) {}

  @RequirePermission('work_items.write')
  @Post()
  @ApiOperation({ summary: 'Record a branch, commit, pull request, build or deployment' })
  create(
    @Body(zodBody(createDevelopmentArtifactSchema)) body: CreateDevelopmentArtifactInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.development.create(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'Development activity of a project, newest first' })
  list(@Query(zodQuery(listDevelopmentArtifactsQuerySchema)) query: ListDevelopmentArtifactsQuery) {
    return this.development.list(query);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({ summary: 'A development artifact with the work items it relates to' })
  get(@Param('id') id: string) {
    return this.development.get(id);
  }

  @RequirePermission('work_items.write')
  @Patch(':id')
  @ApiOperation({ summary: 'Update the title, URL, status, environment or time of an artifact' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateDevelopmentArtifactSchema)) body: UpdateDevelopmentArtifactInput,
  ) {
    return this.development.update(id, body);
  }

  @RequirePermission('work_items.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an artifact (soft delete)' })
  async remove(@Param('id') id: string) {
    await this.development.remove(id);
  }

  @RequirePermission('work_items.write')
  @Post(':id/work-items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Link a work item to the artifact (idempotent)' })
  link(
    @Param('id') id: string,
    @Body(zodBody(linkDevelopmentWorkItemSchema)) body: LinkDevelopmentWorkItemInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.development.link({ artifactId: id, workItemId: body.workItemId }, user.userId);
  }

  @RequirePermission('work_items.write')
  @Delete(':id/work-items/:workItemId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a work item from the artifact (idempotent)' })
  async unlink(@Param('id') id: string, @Param('workItemId') workItemId: string) {
    await this.development.unlink({ artifactId: id, workItemId });
  }
}

@ApiTags('work-items')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('work-items')
export class WorkItemDevelopmentController {
  constructor(private readonly development: DevelopmentService) {}

  @RequirePermission('work_items.read')
  @Get(':id/development')
  @ApiOperation({ summary: 'Development activity linked to a work item' })
  list(@Param('id') id: string) {
    return this.development.forWorkItem(id);
  }

  @RequirePermission('work_items.write')
  @Post(':id/development')
  @HttpCode(200)
  @ApiOperation({ summary: 'Link a development artifact to the work item (idempotent)' })
  link(
    @Param('id') id: string,
    @Body(zodBody(linkDevelopmentArtifactSchema)) body: LinkDevelopmentArtifactInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.development.link({ artifactId: body.artifactId, workItemId: id }, user.userId);
  }

  @RequirePermission('work_items.write')
  @Delete(':id/development/:artifactId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a development artifact (idempotent)' })
  async unlink(@Param('id') id: string, @Param('artifactId') artifactId: string) {
    await this.development.unlink({ artifactId, workItemId: id });
  }
}
