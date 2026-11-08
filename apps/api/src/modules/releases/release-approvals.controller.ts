import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateApprovalRuleInput,
  DecideApprovalInput,
  ListApprovalRulesQuery,
  ReleaseApprovalsQuery,
  RevokeApprovalInput,
  UpdateApprovalRuleInput,
  createApprovalRuleSchema,
  decideApprovalSchema,
  listApprovalRulesQuerySchema,
  releaseApprovalsQuerySchema,
  revokeApprovalSchema,
  updateApprovalRuleSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ReleaseApprovalsService } from './release-approvals.service';

/** Release approval rules (S6-F4): reading `releases.read`, configuring `releases.manage`. */
@ApiTags('release-approvals')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('release-approval-rules')
export class ReleaseApprovalRulesController {
  constructor(private readonly approvals: ReleaseApprovalsService) {}

  @RequirePermission('releases.read')
  @Get()
  @ApiOperation({ summary: 'Approval rules of a project' })
  list(@Query(zodQuery(listApprovalRulesQuerySchema)) query: ListApprovalRulesQuery) {
    return this.approvals.listRules(query);
  }

  @RequirePermission('releases.manage')
  @Post()
  @ApiOperation({ summary: 'Require an approval type, project-wide or for one environment' })
  create(
    @Body(zodBody(createApprovalRuleSchema)) body: CreateApprovalRuleInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.approvals.createRule(body, user.userId);
  }

  @RequirePermission('releases.manage')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an approval rule' })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateApprovalRuleSchema)) body: UpdateApprovalRuleInput,
  ) {
    return this.approvals.updateRule(id, body);
  }

  @RequirePermission('releases.manage')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an approval rule' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.approvals.removeRule(id);
  }
}

/** Release approval decisions (S6-F4): deciding needs `releases.approve`. */
@ApiTags('release-approvals')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('releases')
export class ReleaseApprovalsController {
  constructor(private readonly approvals: ReleaseApprovalsService) {}

  @RequirePermission('releases.read')
  @Get(':id/approvals')
  @ApiOperation({ summary: 'Approval requirements, derived state and history of a release' })
  view(
    @Param('id') id: string,
    @Query(zodQuery(releaseApprovalsQuerySchema)) query: ReleaseApprovalsQuery,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.approvals.view(id, query, user.userId);
  }

  @RequirePermission('releases.approve')
  @Post(':id/approvals')
  @HttpCode(201)
  @ApiOperation({ summary: 'Approve, reject or request changes; a comment is required to refuse' })
  decide(
    @Param('id') id: string,
    @Body(zodBody(decideApprovalSchema)) body: DecideApprovalInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.approvals.decide(id, body, user.userId);
  }

  @RequirePermission('releases.read')
  @Post(':id/approvals/:approvalId/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a live decision (its approver or a release manager)' })
  revoke(
    @Param('id') id: string,
    @Param('approvalId') approvalId: string,
    @Body(zodBody(revokeApprovalSchema)) body: RevokeApprovalInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.approvals.revoke(id, approvalId, body, user.userId);
  }
}
