import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ListGitHubReferencesQuery,
  ListWorkflowRunsQuery,
  RepositoryQuery,
  OptionalLinkWorkflowRunInput,
  WorkflowRunQuery,
  listGitHubReferencesQuerySchema,
  listWorkflowRunsQuerySchema,
  optionalLinkWorkflowRunSchema,
  repositoryQuerySchema,
  workflowRunQuerySchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { GitHubSyncService } from './github-sync.service';

/**
 * The GitHub side of the integration: browse CI, link a run, import results.
 *
 * Browsing is organization-scoped and read-only, like the other providers.
 * Linking a test run to a workflow run is a planning decision and follows the
 * run's planners; importing results records `TestResult` rows and is open to
 * testers too, because a tester who sees the pipeline finish should not have
 * to wait for a lead to bring its results in.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('integrations/github')
export class GitHubSyncController {
  constructor(private readonly github: GitHubSyncService) {}

  @Get('repositories')
  @ApiOperation({ summary: 'Repositories the connected GitHub exposes' })
  listRepositories() {
    return this.github.listRepositories();
  }

  @Get('branches')
  @ApiOperation({ summary: 'Branches of one repository' })
  listBranches(@Query(zodQuery(repositoryQuerySchema)) query: RepositoryQuery) {
    return this.github.listBranches(query);
  }

  @Get('workflows')
  @ApiOperation({ summary: 'Workflows of one repository' })
  listWorkflows(@Query(zodQuery(repositoryQuerySchema)) query: RepositoryQuery) {
    return this.github.listWorkflows(query);
  }

  @Get('runs')
  @ApiOperation({
    summary: 'Workflow runs of one repository, newest first, optionally by workflow',
  })
  listWorkflowRuns(@Query(zodQuery(listWorkflowRunsQuerySchema)) query: ListWorkflowRunsQuery) {
    return this.github.listWorkflowRuns(query);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Jobs and steps of one workflow run' })
  listJobs(@Query(zodQuery(workflowRunQuerySchema)) query: WorkflowRunQuery) {
    return this.github.listJobs(query);
  }

  @Get('artifacts')
  @ApiOperation({ summary: 'Artifacts of one workflow run (metadata only)' })
  listArtifacts(@Query(zodQuery(workflowRunQuerySchema)) query: WorkflowRunQuery) {
    return this.github.listArtifacts(query);
  }

  @Get('results')
  @ApiOperation({ summary: 'Automated test results a workflow run produced' })
  listAutomatedResults(@Query(zodQuery(workflowRunQuerySchema)) query: WorkflowRunQuery) {
    return this.github.listAutomatedResults(query);
  }

  @ProjectScoped()
  @Get('references')
  @ApiOperation({
    summary: 'GitHub references of every run in a project, or every result in a run',
  })
  listReferences(
    @Query(zodQuery(listGitHubReferencesQuerySchema)) query: ListGitHubReferencesQuery,
  ) {
    return this.github.listReferences(query);
  }

  @ProjectScoped()
  @RequirePermission('testruns.create')
  @Post('sync/test-runs/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Link a test run to a workflow run (with a body) or refresh the linked one (without)',
  })
  linkRun(
    @Param('id') id: string,
    @Body(zodBody(optionalLinkWorkflowRunSchema)) input: OptionalLinkWorkflowRunInput,
  ) {
    return this.github.linkRun(id, input ?? null);
  }

  @ProjectScoped()
  @RequirePermission('testruns.execute')
  @Post('sync/test-runs/:id/results')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Import the automated results of the linked workflow run as test results',
  })
  importResults(@Param('id') id: string) {
    return this.github.importResults(id);
  }
}
