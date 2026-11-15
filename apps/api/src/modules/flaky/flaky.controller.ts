import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  FlakyDetailQuery,
  ListFlakyTestsQuery,
  MarkFlakyInput,
  flakyDetailQuerySchema,
  listFlakyTestsQuerySchema,
  markFlakySchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { FlakyService } from './flaky.service';

/**
 * Flaky test detection (S7-F6): reading needs `testruns.read`; confirming,
 * dismissing or clearing a mark `test_design.write`.
 */
@ApiTags('flaky-tests')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('flaky-tests')
export class FlakyController {
  constructor(private readonly flaky: FlakyService) {}

  @RequirePermission('testruns.read')
  @Get()
  @ApiOperation({ summary: 'Test cases with their detected stability, filtered and sorted' })
  list(@Query(zodQuery(listFlakyTestsQuerySchema)) query: ListFlakyTestsQuery) {
    return this.flaky.list(query);
  }

  @RequirePermission('testruns.read')
  @Get(':testCaseId')
  @ApiOperation({ summary: 'Stability of one case: metrics, result history and marks' })
  get(
    @Param('testCaseId') testCaseId: string,
    @Query(zodQuery(flakyDetailQuerySchema)) query: FlakyDetailQuery,
  ) {
    return this.flaky.get(testCaseId, query);
  }

  @RequirePermission('test_design.write')
  @Post(':testCaseId/marks')
  @ApiOperation({ summary: 'Confirm, dismiss or clear the flaky mark of a case' })
  mark(
    @Param('testCaseId') testCaseId: string,
    @Body(zodBody(markFlakySchema)) body: MarkFlakyInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.flaky.mark(testCaseId, body, user.userId);
  }
}
