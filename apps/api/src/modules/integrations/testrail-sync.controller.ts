import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ListExternalCasesQuery,
  ListExternalSuitesQuery,
  ListTestRailReferencesQuery,
  listExternalCasesQuerySchema,
  listExternalSuitesQuerySchema,
  listTestRailReferencesQuerySchema,
} from '@qa-flow-hub/shared';
import { zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { TestRailSyncService } from './testrail-sync.service';

const AUTHORS = ['organization_owner', 'organization_admin', 'project_manager', 'qa_lead'] as const;

/**
 * The TestRail side of the integration: browse the provider, push our entities.
 *
 * Same split as the Jira controller — browsing is organization-scoped, syncing
 * is project-scoped and inherits the roles of the entity it pushes. Suites,
 * cases and runs follow their authors and planners; results may be synced by
 * anyone who may record them, testers included, because a result that exists
 * here and not in TestRail is precisely what a tester notices first.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('integrations/testrail')
export class TestRailSyncController {
  constructor(private readonly testrail: TestRailSyncService) {}

  @Get('projects')
  @ApiOperation({ summary: 'Projects the connected TestRail exposes' })
  listProjects() {
    return this.testrail.listProjects();
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Statuses, priorities and case types the connected TestRail accepts' })
  describe() {
    return this.testrail.describe();
  }

  @Get('suites')
  @ApiOperation({ summary: 'Suites in the connected TestRail, optionally by project' })
  listSuites(@Query(zodQuery(listExternalSuitesQuerySchema)) query: ListExternalSuitesQuery) {
    return this.testrail.listSuites(query);
  }

  @Get('cases')
  @ApiOperation({ summary: 'Cases of one suite in the connected TestRail' })
  listCases(@Query(zodQuery(listExternalCasesQuerySchema)) query: ListExternalCasesQuery) {
    return this.testrail.listCases(query);
  }

  @Get('runs')
  @ApiOperation({ summary: 'Runs in the connected TestRail, optionally by project' })
  listRuns(@Query(zodQuery(listExternalSuitesQuerySchema)) query: ListExternalSuitesQuery) {
    return this.testrail.listRuns(query);
  }

  @ProjectScoped()
  @Get('references')
  @ApiOperation({
    summary:
      'TestRail references of every suite, case or run in a project, or every result in a run',
  })
  listReferences(
    @Query(zodQuery(listTestRailReferencesQuerySchema)) query: ListTestRailReferencesQuery,
  ) {
    return this.testrail.listReferences(query);
  }

  @ProjectScoped()
  @Roles(...AUTHORS)
  @Post('sync/test-suites/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or update the TestRail suite for a test suite' })
  syncSuite(@Param('id') id: string) {
    return this.testrail.syncSuite(id);
  }

  @ProjectScoped()
  @Roles(...AUTHORS)
  @Post('sync/test-cases/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create or update the TestRail case for a test case (and its suite)' })
  syncCase(@Param('id') id: string) {
    return this.testrail.syncCase(id);
  }

  @ProjectScoped()
  @Roles(...AUTHORS)
  @Post('sync/test-runs/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create or update the TestRail run for a test run (and its suite and cases)',
  })
  syncRun(@Param('id') id: string) {
    return this.testrail.syncRun(id);
  }

  @ProjectScoped()
  @Roles(...AUTHORS, 'tester')
  @Post('sync/test-results/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add the TestRail result for a test result (and its run)' })
  syncResult(@Param('id') id: string) {
    return this.testrail.syncResult(id);
  }
}
