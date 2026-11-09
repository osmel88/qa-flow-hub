import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AttachPlanRunInput,
  CreateTestPlanInput,
  ListTestPlansQuery,
  TestPlanActionInput,
  UpdateTestPlanInput,
  attachPlanRunSchema,
  createTestPlanSchema,
  listTestPlansQuerySchema,
  testPlanActionSchema,
  updateTestPlanSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { TestPlansService } from './test-plans.service';

/**
 * Test plans (S7-F1): reading needs `testruns.read`; creating, editing,
 * refreshing the scope and attaching runs `testruns.create`; starting,
 * completing, cancelling and archiving `testruns.manage`.
 */
@ApiTags('test-plans')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('test-plans')
export class TestPlansController {
  constructor(private readonly plans: TestPlansService) {}

  @RequirePermission('testruns.read')
  @Get()
  @ApiOperation({
    summary: 'Test plans of a project, filtered by release, environment, status, owner',
  })
  list(@Query(zodQuery(listTestPlansQuerySchema)) query: ListTestPlansQuery) {
    return this.plans.list(query);
  }

  @RequirePermission('testruns.create')
  @Post()
  @ApiOperation({ summary: 'Plan QA work: suites, cases, environments and an optional release' })
  create(
    @Body(zodBody(createTestPlanSchema)) body: CreateTestPlanInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.plans.create(body, user.userId);
  }

  @RequirePermission('testruns.read')
  @Get(':id')
  @ApiOperation({ summary: 'A test plan with its scope, environments and runs' })
  get(@Param('id') id: string) {
    return this.plans.get(id);
  }

  @RequirePermission('testruns.read')
  @Get(':id/progress')
  @ApiOperation({ summary: 'Derived progress, coverage and related defects of a plan' })
  progress(@Param('id') id: string) {
    return this.plans.progress(id);
  }

  @RequirePermission('testruns.create')
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft or active plan; the scope only until it is frozen' })
  update(@Param('id') id: string, @Body(zodBody(updateTestPlanSchema)) body: UpdateTestPlanInput) {
    return this.plans.update(id, body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the plan and freeze its scope' })
  start(@Param('id') id: string, @Body(zodBody(testPlanActionSchema)) body: TestPlanActionInput) {
    return this.plans.transition(id, 'start', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete an active plan' })
  complete(
    @Param('id') id: string,
    @Body(zodBody(testPlanActionSchema)) body: TestPlanActionInput,
  ) {
    return this.plans.transition(id, 'complete', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a draft or active plan' })
  cancel(@Param('id') id: string, @Body(zodBody(testPlanActionSchema)) body: TestPlanActionInput) {
    return this.plans.transition(id, 'cancel', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a draft, completed or cancelled plan; it becomes read-only' })
  archive(@Param('id') id: string, @Body(zodBody(testPlanActionSchema)) body: TestPlanActionInput) {
    return this.plans.transition(id, 'archive', body);
  }

  @RequirePermission('testruns.create')
  @Post(':id/scope/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Append a new frozen scope version from the current suites and cases' })
  refresh(@Param('id') id: string, @Body(zodBody(testPlanActionSchema)) body: TestPlanActionInput) {
    return this.plans.refreshScope(id, body);
  }

  @RequirePermission('testruns.create')
  @Post(':id/runs')
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach a test run of the same project to the plan' })
  attach(@Param('id') id: string, @Body(zodBody(attachPlanRunSchema)) body: AttachPlanRunInput) {
    return this.plans.attachRun(id, body);
  }

  @RequirePermission('testruns.create')
  @Delete(':id/runs/:testRunId')
  @ApiOperation({ summary: 'Detach a run from the plan' })
  detach(@Param('id') id: string, @Param('testRunId') testRunId: string) {
    return this.plans.detachRun(id, testRunId);
  }
}
