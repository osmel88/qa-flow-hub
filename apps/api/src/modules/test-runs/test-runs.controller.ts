import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AddRunCasesInput,
  AssignRunCasesInput,
  CreateTestRunInput,
  ListRunCasesQuery,
  ListTestRunsQuery,
  RecordResultInput,
  UpdateTestRunInput,
  addRunCasesSchema,
  assignRunCasesSchema,
  createTestRunSchema,
  listRunCasesQuerySchema,
  listTestRunsQuerySchema,
  recordResultSchema,
  updateTestRunSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { TestRunsService } from './test-runs.service';

/** Who plans execution. Testers execute, they do not decide what gets run. */
const PLANNERS = [
  'organization_owner',
  'organization_admin',
  'project_manager',
  'qa_lead',
] as const;

@ApiTags('test-runs')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('test-runs')
export class TestRunsController {
  constructor(private readonly runs: TestRunsService) {}

  @Roles(...PLANNERS)
  @Post()
  @ApiOperation({ summary: 'Plan a run, optionally including cases straight away' })
  create(
    @Body(zodBody(createTestRunSchema)) body: CreateTestRunInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.runs.create(body, user.userId);
  }

  @Get()
  @ApiOperation({ summary: 'List a project’s runs with their progress' })
  list(@Query(zodQuery(listTestRunsQuerySchema)) query: ListTestRunsQuery) {
    return this.runs.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a run with its progress breakdown' })
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Roles(...PLANNERS)
  @Patch(':id')
  @ApiOperation({ summary: 'Edit an open run' })
  update(@Param('id') id: string, @Body(zodBody(updateTestRunSchema)) body: UpdateTestRunInput) {
    return this.runs.update(id, body);
  }

  @Roles(...PLANNERS)
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move a planned run to in progress' })
  start(@Param('id') id: string) {
    return this.runs.transition(id, 'in_progress');
  }

  @Roles(...PLANNERS)
  @Post(':id/complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a run; it becomes read-only' })
  complete(@Param('id') id: string) {
    return this.runs.transition(id, 'completed');
  }

  @Roles(...PLANNERS)
  @Post(':id/abort')
  @HttpCode(200)
  @ApiOperation({ summary: 'Abandon a run; it becomes read-only' })
  abort(@Param('id') id: string) {
    return this.runs.transition(id, 'aborted');
  }

  @Roles('organization_owner', 'organization_admin', 'project_manager')
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft delete a run' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.runs.remove(id);
  }

  // --- Cases in a run ------------------------------------------------------

  @Roles(...PLANNERS)
  @Post(':id/cases')
  @HttpCode(200)
  @ApiOperation({ summary: 'Include more cases, frozen as snapshots' })
  addCases(@Param('id') id: string, @Body(zodBody(addRunCasesSchema)) body: AddRunCasesInput) {
    return this.runs.addCases(id, body);
  }

  @Get(':id/cases')
  @ApiOperation({ summary: 'List the cases in a run and their latest status' })
  listCases(
    @Param('id') id: string,
    @Query(zodQuery(listRunCasesQuerySchema)) query: ListRunCasesQuery,
  ) {
    return this.runs.listCases(id, query);
  }

  @Roles(...PLANNERS)
  @Delete(':id/cases/:runCaseId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a case that has not been executed yet' })
  async removeCase(@Param('id') id: string, @Param('runCaseId') runCaseId: string): Promise<void> {
    await this.runs.removeCase(id, runCaseId);
  }

  @Roles(...PLANNERS)
  @Post(':id/assignments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign or unassign cases in bulk' })
  assign(@Param('id') id: string, @Body(zodBody(assignRunCasesSchema)) body: AssignRunCasesInput) {
    return this.runs.assign(id, body);
  }

  // --- Results -------------------------------------------------------------

  @Roles(...PLANNERS, 'tester')
  @Post(':id/cases/:runCaseId/results')
  @ApiOperation({ summary: 'Record an execution attempt; results are append-only' })
  recordResult(
    @Param('id') id: string,
    @Param('runCaseId') runCaseId: string,
    @Body(zodBody(recordResultSchema)) body: RecordResultInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.runs.recordResult(id, runCaseId, body, user.userId, user.role);
  }

  @Get(':id/cases/:runCaseId/results')
  @ApiOperation({ summary: 'The full history of attempts, newest first' })
  listResults(@Param('id') id: string, @Param('runCaseId') runCaseId: string) {
    return this.runs.listResults(id, runCaseId);
  }
}
