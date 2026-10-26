import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LinkRequirementInput,
  LinkWorkItemInput,
  linkRequirementSchema,
  linkWorkItemSchema,
} from '@qa-flow-hub/shared';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { RequirementLinksService } from './requirement-links.service';

@ApiTags('requirements')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('requirements')
export class RequirementWorkItemsController {
  constructor(private readonly links: RequirementLinksService) {}

  @RequirePermission('requirements.read')
  @Get(':id/work-items')
  @ApiOperation({ summary: 'Work items implementing a requirement, with its implementation' })
  list(@Param('id') id: string) {
    return this.links.forRequirement(id);
  }

  @RequirePermission('work_items.write')
  @Post(':id/work-items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Link a work item as implementing the requirement (idempotent)' })
  link(
    @Param('id') id: string,
    @Body(zodBody(linkWorkItemSchema)) body: LinkWorkItemInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.links.link(
      { requirementId: id, workItemId: body.workItemId, linkType: body.linkType },
      user.userId,
    );
  }

  @RequirePermission('work_items.write')
  @Delete(':id/work-items/:workItemId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a work item (idempotent)' })
  async unlink(@Param('id') id: string, @Param('workItemId') workItemId: string) {
    await this.links.unlink({ requirementId: id, workItemId, linkType: 'implements' });
  }
}

@ApiTags('work-items')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('work-items')
export class WorkItemRequirementsController {
  constructor(private readonly links: RequirementLinksService) {}

  @RequirePermission('work_items.read')
  @Get(':id/requirements')
  @ApiOperation({ summary: 'Requirements a work item implements' })
  list(@Param('id') id: string) {
    return this.links.forWorkItem(id);
  }

  @RequirePermission('work_items.write')
  @Post(':id/requirements')
  @HttpCode(200)
  @ApiOperation({ summary: 'Link the work item to a requirement it implements (idempotent)' })
  link(
    @Param('id') id: string,
    @Body(zodBody(linkRequirementSchema)) body: LinkRequirementInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.links.link(
      { requirementId: body.requirementId, workItemId: id, linkType: body.linkType },
      user.userId,
    );
  }

  @RequirePermission('work_items.write')
  @Delete(':id/requirements/:requirementId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a requirement (idempotent)' })
  async unlink(@Param('id') id: string, @Param('requirementId') requirementId: string) {
    await this.links.unlink({ requirementId, workItemId: id, linkType: 'implements' });
  }
}
