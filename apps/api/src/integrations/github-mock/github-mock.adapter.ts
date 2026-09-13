import { Injectable } from '@nestjs/common';
import { IntegrationProviderError } from '../../errors/domain-error';
import {
  AdapterContext,
  AutomatedResult,
  AutomationProviderAdapter,
  ExternalArtifact,
  ExternalBranch,
  ExternalJob,
  ExternalRepository,
  ExternalWorkflow,
  ExternalWorkflowRun,
  HealthCheck,
} from '../adapter.contracts';
import {
  GITHUB_MOCK_DEFAULT_REPOSITORY,
  GitHubMockArtifact,
  GitHubMockAutomatedResult,
  GitHubMockRepository,
  GitHubMockStore,
  GitHubMockWorkflowRun,
} from './github-mock.store';

/**
 * Non-sensitive settings the mock understands, stored in
 * `IntegrationConnection.settings` like any provider's:
 *
 *  - `repository`       the `owner/name` Test connection verifies and the UI
 *                       defaults to (`acme/web-checkout`);
 *  - `simulateFailure`  `unreachable` fails every call, `fetch_failure` lets
 *                       browsing succeed and refuses to fetch results.
 */
export const GITHUB_MOCK_SETTING_REPOSITORY = 'repository';
export const GITHUB_MOCK_SETTING_SIMULATE_FAILURE = 'simulateFailure';
export const GITHUB_MOCK_FAILURE_MODES = ['unreachable', 'fetch_failure'] as const;
export type GitHubMockFailureMode = (typeof GITHUB_MOCK_FAILURE_MODES)[number];

const PROVIDER = 'GitHub mock';
const DEFAULT_HOST = 'https://github.example.com';

/** `@C-12` anywhere in a title; case-insensitive because people type `@c-12`. */
const CASE_TAG = /@(C-\d+)\b/gi;

/**
 * The simulated GitHub behind `AUTOMATION_PROVIDER_ADAPTER`.
 *
 * Everything the host sees is expressed in the neutral vocabulary of
 * `adapter.contracts.ts`; the only GitHub-shaped things here are the URLs and
 * the words `workflow` and `artifact`, which the port already uses because
 * every CI has them. Swapping this for a real adapter is a change in this
 * directory and in `integrations.module.ts`, nowhere else — which was the point
 * of building the mock first.
 */
@Injectable()
export class GitHubMockAutomationProviderAdapter implements AutomationProviderAdapter {
  readonly provider = 'github' as const;

  constructor(private readonly store: GitHubMockStore) {}

  check(context: AdapterContext): Promise<HealthCheck> {
    const checkedAt = new Date();
    if (failureMode(context) === 'unreachable') {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: simulated outage (settings.simulateFailure=unreachable)`,
        checkedAt,
      });
    }

    const wanted = repositoryOf(context);
    const repository = this.store.findRepository(context.organizationId, wanted);
    if (repository === null) {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: repository ${wanted} is not accessible. Known repositories: ${this.store
          .listRepositories(context.organizationId)
          .map((known) => known.fullName)
          .join(', ')}`,
        checkedAt,
      });
    }

    return Promise.resolve({
      reachable: true,
      message: `${PROVIDER}: reachable, ${repository.fullName} has ${
        this.store.listWorkflows(context.organizationId, repository.id).length
      } workflows`,
      checkedAt,
    });
  }

  async listRepositories(context: AdapterContext): Promise<ExternalRepository[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listRepositories(context.organizationId)
        .map((repository) => this.toRepository(context, repository)),
    );
  }

  async listBranches(
    context: AdapterContext,
    repositoryExternalId: string,
  ): Promise<ExternalBranch[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    return Promise.resolve(
      this.store.listBranches(context.organizationId, repository.id).map((branch) => ({
        name: branch.name,
        headSha: branch.headSha,
        isProtected: branch.isProtected,
      })),
    );
  }

  async listWorkflows(
    context: AdapterContext,
    repositoryExternalId: string,
  ): Promise<ExternalWorkflow[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    return Promise.resolve(
      this.store.listWorkflows(context.organizationId, repository.id).map((workflow) => ({
        externalId: workflow.id,
        repositoryExternalId: repository.id,
        name: workflow.name,
        path: workflow.path,
        state: workflow.state,
      })),
    );
  }

  async listWorkflowRuns(
    context: AdapterContext,
    repositoryExternalId: string,
    workflowExternalId?: string,
  ): Promise<ExternalWorkflowRun[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    return Promise.resolve(
      this.store
        .listWorkflowRuns(context.organizationId, repository.id, workflowExternalId)
        .map((run) => this.toRun(context, repository, run)),
    );
  }

  async fetchWorkflowRun(
    context: AdapterContext,
    repositoryExternalId: string,
    runExternalId: string,
  ): Promise<ExternalWorkflowRun | null> {
    const repository = this.requireRepository(context, repositoryExternalId);
    const run = this.store.findWorkflowRun(context.organizationId, repository.id, runExternalId);
    return Promise.resolve(run === null ? null : this.toRun(context, repository, run));
  }

  async listJobs(
    context: AdapterContext,
    repositoryExternalId: string,
    runExternalId: string,
  ): Promise<ExternalJob[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    this.requireRun(context, repository, runExternalId);
    return Promise.resolve(
      this.store.listJobs(context.organizationId, runExternalId).map((job) => ({
        externalId: job.id,
        runExternalId: job.runId,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        steps: job.steps.map((step) => ({ ...step })),
      })),
    );
  }

  async listArtifacts(
    context: AdapterContext,
    repositoryExternalId: string,
    runExternalId: string,
  ): Promise<ExternalArtifact[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    this.requireRun(context, repository, runExternalId);
    return Promise.resolve(
      this.store
        .listArtifacts(context.organizationId, runExternalId)
        .map((artifact) => this.toArtifact(context, repository, artifact)),
    );
  }

  async fetchResults(
    context: AdapterContext,
    repositoryExternalId: string,
    runExternalId: string,
  ): Promise<AutomatedResult[]> {
    const repository = this.requireRepository(context, repositoryExternalId);
    const run = this.requireRun(context, repository, runExternalId);
    if (failureMode(context) === 'fetch_failure') {
      throw new IntegrationProviderError(
        PROVIDER,
        `simulated failure downloading the report of run #${run.runNumber} (settings.simulateFailure=fetch_failure)`,
      );
    }
    return Promise.resolve(
      this.store.listResults(context.organizationId, run.id).map((result) => this.toResult(result)),
    );
  }

  // -- mapping ----------------------------------------------------------------

  private toRepository(
    context: AdapterContext,
    repository: GitHubMockRepository,
  ): ExternalRepository {
    return {
      externalId: repository.id,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      url: `${host(context)}/${repository.fullName}`,
      isPrivate: repository.isPrivate,
      updatedAt: repository.updatedAt,
    };
  }

  private toRun(
    context: AdapterContext,
    repository: GitHubMockRepository,
    run: GitHubMockWorkflowRun,
  ): ExternalWorkflowRun {
    const workflow = this.store.findWorkflow(context.organizationId, run.workflowId);
    return {
      externalId: run.id,
      repositoryExternalId: repository.id,
      workflowExternalId: run.workflowId,
      workflowName: workflow?.name ?? run.workflowId,
      runNumber: run.runNumber,
      url: `${host(context)}/${repository.fullName}/actions/runs/${run.id}`,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
      headBranch: run.headBranch,
      headSha: run.headSha,
      commitMessage: run.commitMessage,
      actor: run.actor,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private toArtifact(
    context: AdapterContext,
    repository: GitHubMockRepository,
    artifact: GitHubMockArtifact,
  ): ExternalArtifact {
    return {
      externalId: artifact.id,
      runExternalId: artifact.runId,
      name: artifact.name,
      kind: artifact.kind,
      sizeInBytes: artifact.sizeInBytes,
      expired: artifact.expired,
      url: artifact.expired
        ? null
        : `${host(context)}/${repository.fullName}/actions/runs/${artifact.runId}/artifacts/${artifact.id}`,
    };
  }

  private toResult(result: GitHubMockAutomatedResult): AutomatedResult {
    return {
      externalId: result.id,
      runExternalId: result.runId,
      testIdentifier: `${result.file} › ${result.title}`,
      caseTags: caseTagsOf(result.title),
      framework: 'playwright',
      file: result.file,
      project: result.project,
      status: result.status,
      durationMs: result.durationMs,
      message: result.message,
      executedAt: result.executedAt,
    };
  }

  // -- guards -----------------------------------------------------------------

  private assertReachable(context: AdapterContext): void {
    if (failureMode(context) === 'unreachable') {
      throw new IntegrationProviderError(
        PROVIDER,
        'simulated outage (settings.simulateFailure=unreachable)',
      );
    }
  }

  private requireRepository(context: AdapterContext, idOrFullName: string): GitHubMockRepository {
    this.assertReachable(context);
    const repository = this.store.findRepository(context.organizationId, idOrFullName);
    if (repository === null) {
      throw new IntegrationProviderError(
        PROVIDER,
        `repository ${idOrFullName} is not accessible with this connection`,
      );
    }
    return repository;
  }

  private requireRun(
    context: AdapterContext,
    repository: GitHubMockRepository,
    runId: string,
  ): GitHubMockWorkflowRun {
    const run = this.store.findWorkflowRun(context.organizationId, repository.id, runId);
    if (run === null) {
      throw new IntegrationProviderError(
        PROVIDER,
        `workflow run ${runId} does not exist in ${repository.fullName}`,
      );
    }
    return run;
  }
}

export function caseTagsOf(title: string): string[] {
  const tags = new Set<string>();
  for (const match of title.matchAll(CASE_TAG)) {
    const tag = match[1];
    if (tag !== undefined) {
      tags.add(tag.toUpperCase());
    }
  }
  return [...tags];
}

function host(context: AdapterContext): string {
  return (context.baseUrl ?? DEFAULT_HOST).replace(/\/+$/, '');
}

function repositoryOf(context: AdapterContext): string {
  const value = context.settings[GITHUB_MOCK_SETTING_REPOSITORY];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : GITHUB_MOCK_DEFAULT_REPOSITORY;
}

function failureMode(context: AdapterContext): GitHubMockFailureMode | null {
  const value = context.settings[GITHUB_MOCK_SETTING_SIMULATE_FAILURE];
  return typeof value === 'string' &&
    (GITHUB_MOCK_FAILURE_MODES as readonly string[]).includes(value)
    ? (value as GitHubMockFailureMode)
    : null;
}
