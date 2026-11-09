import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AttachCycleRunInput,
  CreateTestCycleInput,
  ListTestCyclesQuery,
  TestCycleActionInput,
  UpdateTestCycleInput,
  attachCycleRunSchema,
  createTestCycleSchema,
  listTestCyclesQuerySchema,
  testCycleActionSchema,
  updateTestCycleSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { TestCyclesService } from './test-cycles.service';

/**
 * Test cycles (S7-F2): reading needs `testruns.read`; creating, editing,
 * and attaching runs `testruns.create`; starting,
 * completing, cancelling and archiving `testruns.manage`.
 */
@ApiTags('test-cycles')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('test-cycles')
export class TestCyclesController {
  constructor(private readonly cycles: TestCyclesService) {}

  @RequirePermission('testruns.read')
  @Get()
  @ApiOperation({
    summary: 'Cycles of a test plan, filtered by status, environment, release, owner',
  })
  list(@Query(zodQuery(listTestCyclesQuerySchema)) query: ListTestCyclesQuery) {
    return this.cycles.list(query);
  }

  @RequirePermission('testruns.create')
  @Post()
  @ApiOperation({ summary: 'Plan an execution cycle inside a test plan' })
  create(
    @Body(zodBody(createTestCycleSchema)) body: CreateTestCycleInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.cycles.create(body, user.userId);
  }

  @RequirePermission('testruns.read')
  @Get(':id')
  @ApiOperation({ summary: 'A test cycle with its scope and runs' })
  get(@Param('id') id: string) {
    return this.cycles.get(id);
  }

  @RequirePermission('testruns.read')
  @Get(':id/progress')
  @ApiOperation({ summary: 'Derived progress, coverage and defects of a cycle' })
  progress(@Param('id') id: string) {
    return this.cycles.progress(id);
  }

  @RequirePermission('testruns.create')
  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a planned or active cycle; environment and release only until it starts',
  })
  update(
    @Param('id') id: string,
    @Body(zodBody(updateTestCycleSchema)) body: UpdateTestCycleInput,
  ) {
    return this.cycles.update(id, body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start the cycle and freeze the plan scope into it' })
  start(@Param('id') id: string, @Body(zodBody(testCycleActionSchema)) body: TestCycleActionInput) {
    return this.cycles.transition(id, 'start', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete an active cycle' })
  complete(
    @Param('id') id: string,
    @Body(zodBody(testCycleActionSchema)) body: TestCycleActionInput,
  ) {
    return this.cycles.transition(id, 'complete', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a planned or active cycle' })
  cancel(
    @Param('id') id: string,
    @Body(zodBody(testCycleActionSchema)) body: TestCycleActionInput,
  ) {
    return this.cycles.transition(id, 'cancel', body);
  }

  @RequirePermission('testruns.manage')
  @Post(':id/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Archive a planned, completed or cancelled cycle' })
  archive(
    @Param('id') id: string,
    @Body(zodBody(testCycleActionSchema)) body: TestCycleActionInput,
  ) {
    return this.cycles.transition(id, 'archive', body);
  }

  @RequirePermission('testruns.create')
  @Post(':id/runs')
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach a run of the plan (or of no plan) to the cycle' })
  attach(@Param('id') id: string, @Body(zodBody(attachCycleRunSchema)) body: AttachCycleRunInput) {
    return this.cycles.attachRun(id, body);
  }

  @RequirePermission('testruns.create')
  @Delete(':id/runs/:testRunId')
  @ApiOperation({ summary: 'Detach a run from the cycle' })
  detach(@Param('id') id: string, @Param('testRunId') testRunId: string) {
    return this.cycles.detachRun(id, testRunId);
  }
}
