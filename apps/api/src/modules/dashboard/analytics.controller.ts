import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnalyticsQuery, analyticsQuerySchema } from '@qa-flow-hub/shared';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { AnalyticsService } from './analytics.service';

/**
 * KPI and analytics dashboards (S2-F9). Every route takes an optional window
 * (`from`, `to`, `bucket`) and answers with numbers already aggregated in SQL.
 * Project routes are `@ProjectScoped`, so a project-level revoke of
 * `analytics.read` is a 403 here; the organization route drops such projects
 * from every total instead.
 */
@ApiTags('analytics')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@RequirePermission('analytics.read')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @ProjectScoped()
  @Get('projects/:projectId/dashboard/summary')
  @ApiOperation({ summary: 'Headline KPIs of one project for a window' })
  summary(
    @Param('projectId') projectId: string,
    @Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.summary(projectId, query);
  }

  @ProjectScoped()
  @Get('projects/:projectId/dashboard/test-results')
  @ApiOperation({ summary: 'Execution distribution, per run and per milestone' })
  testResults(
    @Param('projectId') projectId: string,
    @Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.testResults(projectId, query);
  }

  @ProjectScoped()
  @Get('projects/:projectId/dashboard/coverage')
  @ApiOperation({ summary: 'Requirement → test case coverage and the uncovered requirements' })
  coverage(
    @Param('projectId') projectId: string,
    @Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.coverage(projectId, query);
  }

  @ProjectScoped()
  @Get('projects/:projectId/dashboard/defects')
  @ApiOperation({ summary: 'Defects by severity, priority and status, flow and time to resolve' })
  defects(
    @Param('projectId') projectId: string,
    @Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.defects(projectId, query);
  }

  @ProjectScoped()
  @Get('projects/:projectId/dashboard/trends')
  @ApiOperation({ summary: 'Pass rate, coverage and defects per bucket' })
  trends(
    @Param('projectId') projectId: string,
    @Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery,
  ) {
    return this.analytics.trends(projectId, query);
  }

  @Get('dashboard/organization')
  @ApiOperation({ summary: 'QA health across the projects the caller may analyse' })
  organization(@Query(zodQuery(analyticsQuerySchema)) query: AnalyticsQuery) {
    return this.analytics.organization(query);
  }
}
