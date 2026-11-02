import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CodeReviewDecisionInput,
  CodeReviewSettingsInput,
  CreateCodeReviewInput,
  ListCodeReviewsQuery,
  UpdateCodeReviewInput,
  codeReviewCommentSchema,
  codeReviewDecisionSchema,
  codeReviewReviewerSchema,
  codeReviewSettingsQuerySchema,
  codeReviewSettingsSchema,
  codeReviewWorkItemSchema,
  createCodeReviewSchema,
  listCodeReviewsQuerySchema,
  optionalCommentSchema,
  updateCodeReviewSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CodeReviewsService } from './code-reviews.service';

/**
 * Code reviews (S5-F3): reading needs `work_items.read`; opening, editing,
 * reviewers, comments and work item links `work_items.write`; approving or
 * requesting changes `code_reviews.review` (and being an assigned reviewer
 * who is not the author); dismissing, deleting and the project rule
 * `work_items.manage`.
 */
@ApiTags('code-reviews')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('code-reviews')
export class CodeReviewsController {
  constructor(private readonly reviews: CodeReviewsService) {}

  @RequirePermission('work_items.write')
  @Post()
  @ApiOperation({ summary: 'Open a code review' })
  create(
    @Body(zodBody(createCodeReviewSchema)) body: CreateCodeReviewInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.create(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get()
  @ApiOperation({ summary: 'Code reviews of a project, filtered by status, reviewer or author' })
  list(
    @Query(zodQuery(listCodeReviewsQuerySchema)) query: ListCodeReviewsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.list(query, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get('settings')
  @ApiOperation({ summary: 'Approvals a review of the project needs by default' })
  settings(@Query(zodQuery(codeReviewSettingsQuerySchema)) query: { projectId: string }) {
    return this.reviews.settings(query.projectId);
  }

  @RequirePermission('work_items.manage')
  @Put('settings')
  @ApiOperation({ summary: 'Set the approvals a review of the project needs by default' })
  updateSettings(
    @Body(zodBody(codeReviewSettingsSchema)) body: CodeReviewSettingsInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.updateSettings(body, user.userId);
  }

  @RequirePermission('work_items.read')
  @Get(':id')
  @ApiOperation({
    summary: 'A code review with reviewers, work items, history and merge readiness',
  })
  get(@Param('id') id: string) {
    return this.reviews.get(id);
  }

  @RequirePermission('work_items.write')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit title, summary or required approvals' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateCodeReviewSchema)) body: UpdateCodeReviewInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.update(id, body, user.userId);
  }

  @RequirePermission('work_items.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a code review (soft delete)' })
  async remove(@Param('id') id: string, @CurrentUser() user: CurrentUserContext) {
    await this.reviews.remove(id, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post(':id/reviewers')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a reviewer (idempotent)' })
  addReviewer(
    @Param('id') id: string,
    @Body(zodBody(codeReviewReviewerSchema)) body: { userId: string },
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.addReviewer(id, body.userId, user.userId);
  }

  @RequirePermission('work_items.write')
  @Delete(':id/reviewers/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a reviewer (idempotent)' })
  async removeReviewer(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    await this.reviews.removeReviewer(id, userId, user.userId);
  }

  @RequirePermission('code_reviews.review')
  @Post(':id/decision')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve, request changes or revoke your decision' })
  decide(
    @Param('id') id: string,
    @Body(zodBody(codeReviewDecisionSchema)) body: CodeReviewDecisionInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.decide(id, body, user.userId);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/reviewers/:userId/dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: "Dismiss a reviewer's approval or change request" })
  dismissDecision(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(zodBody(optionalCommentSchema)) body: { comment?: string },
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.dismissDecision(id, userId, body.comment, user.userId);
  }

  @RequirePermission('work_items.manage')
  @Post(':id/dismiss')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dismiss the whole review' })
  dismiss(
    @Param('id') id: string,
    @Body(zodBody(optionalCommentSchema)) body: { comment?: string },
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.dismiss(id, body.comment, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post(':id/comments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Comment on a review' })
  comment(
    @Param('id') id: string,
    @Body(zodBody(codeReviewCommentSchema)) body: { comment: string },
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.comment(id, body.comment, user.userId);
  }

  @RequirePermission('work_items.write')
  @Post(':id/work-items')
  @HttpCode(200)
  @ApiOperation({ summary: 'Link a work item to the review (idempotent)' })
  link(
    @Param('id') id: string,
    @Body(zodBody(codeReviewWorkItemSchema)) body: { workItemId: string },
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.reviews.link(id, body.workItemId, user.userId);
  }

  @RequirePermission('work_items.write')
  @Delete(':id/work-items/:workItemId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a work item from the review (idempotent)' })
  async unlink(
    @Param('id') id: string,
    @Param('workItemId') workItemId: string,
    @CurrentUser() user: CurrentUserContext,
  ) {
    await this.reviews.unlink(id, workItemId, user.userId);
  }
}

@ApiTags('work-items')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('work-items')
export class WorkItemCodeReviewsController {
  constructor(private readonly reviews: CodeReviewsService) {}

  @RequirePermission('work_items.read')
  @Get(':id/code-reviews')
  @ApiOperation({ summary: 'Code reviews of a work item, directly linked' })
  list(@Param('id') id: string) {
    return this.reviews.forWorkItem(id);
  }
}
