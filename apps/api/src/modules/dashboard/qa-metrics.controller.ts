import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { QaMetricsQuery, qaMetricsQuerySchema } from '@qa-flow-hub/shared';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { QaMetricsService } from './qa-metrics.service';

/** QA metrics dashboard of a project (S7-F7); reading needs `analytics.read`. */
@ApiTags('analytics')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@RequirePermission('analytics.read')
@Controller()
export class QaMetricsController {
  constructor(private readonly metrics: QaMetricsService) {}

  @ProjectScoped()
  @Get('projects/:projectId/qa-metrics')
  @ApiOperation({
    summary: 'QA metrics of one project: execution, plans, defects, flaky, exploratory',
  })
  get(
    @Param('projectId') projectId: string,
    @Query(zodQuery(qaMetricsQuerySchema)) query: QaMetricsQuery,
  ) {
    return this.metrics.get(projectId, query);
  }
}
