import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ExternalReference,
  IntegrationConnection,
  IntegrationStatus,
  Prisma,
  TestResultStatus,
  TestRun,
  TestRunCase,
} from '@prisma/client';
import {
  AutomatedResultView,
  ExternalArtifactView,
  ExternalBranchView,
  ExternalJobView,
  ExternalReferenceView,
  ExternalRepositoryView,
  ExternalWorkflowRunView,
  ExternalWorkflowView,
  GitHubSyncableEntity,
  GitHubSyncResultView,
  ImportAutomatedResultsView,
  LinkWorkflowRunInput,
  ListGitHubReferencesQuery,
  ListWorkflowRunsQuery,
  RepositoryQuery,
  RunCaseSnapshot,
  SkippedAutomatedResultView,
  WorkflowRunQuery,
} from '@qa-flow-hub/shared';
import {
  AdapterContext,
  AutomatedResult,
  AutomationProviderAdapter,
  AUTOMATION_PROVIDER_ADAPTER,
  ExternalArtifact,
  ExternalJob,
  ExternalRepository,
  ExternalWorkflowRun,
} from '../../integrations';
import { PrismaService } from '../../database/prisma.service';
import { TenantContextService } from '../../database/tenant-context.service';
import {
  ConflictError,
  IntegrationNotConfiguredError,
  IntegrationProviderError,
  NotFoundError,
  ValidationError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TestRunsRepository } from '../test-runs/test-runs.repository';
import { ExternalReferencesRepository } from './external-references.repository';
import { IntegrationSettingsRepository } from './integration-settings.repository';

const PROVIDER = 'github' as const;
const DISPLAY_NAME = 'GitHub';

/** Fields of the observed workflow run kept on the reference, so the UI needs no second call. */
const RUN_METADATA_KEYS = [
  'repositoryExternalId',
  'repositoryFullName',
  'workflowExternalId',
  'workflowName',
  'runNumber',
  'status',
  'conclusion',
  'event',
  'headBranch',
  'headSha',
  'actor',
] as const;

interface RunLink {
  reference: ExternalReference;
  action: GitHubSyncResultView['action'];
  run: ExternalWorkflowRun;
  repository: ExternalRepository;
}

/**
 * The automation side of integrations: observe a CI run, import what it ran.
 *
 * This service is deliberately different from its Jira and TestRail siblings in
 * one respect: it never writes to the provider. CI produces runs; qa-flow-hub
 * decides which of them a `TestRun` *is the manual counterpart of*, records
 * that as a reference, and turns the run's automated results into
 * `TestResult` rows — the same rows a tester creates, with the same
 * append-only history, just with `executedById` pointing at whoever pressed
 * Import instead of whoever ran the test.
 *
 * The three rules of the other services still hold: authorization first, one
 * reference per entity, the connection records what happened. Business
 * entities stay provider-free: `TestRun` has no `workflowRunId`, and the
 * mapping from a Playwright title to a case is a tag (`@C-12`) resolved here
 * against the run's case keys, not a column anywhere.
 */
@Injectable()
export class GitHubSyncService {
  constructor(
    @Inject(AUTOMATION_PROVIDER_ADAPTER) private readonly provider: AutomationProviderAdapter,
    private readonly connections: IntegrationSettingsRepository,
    private readonly references: ExternalReferencesRepository,
    private readonly runs: TestRunsRepository,
    private readonly projects: ProjectsRepository,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  // -- browsing -------------------------------------------------------------

  async listRepositories(): Promise<ExternalRepositoryView[]> {
    const repositories = await this.browse((context) => this.provider.listRepositories(context));
    return repositories.map(toRepositoryView);
  }

  async listBranches(query: RepositoryQuery): Promise<ExternalBranchView[]> {
    return this.browse((context) =>
      this.provider.listBranches(context, query.repositoryExternalId),
    );
  }

  async listWorkflows(query: RepositoryQuery): Promise<ExternalWorkflowView[]> {
    return this.browse((context) =>
      this.provider.listWorkflows(context, query.repositoryExternalId),
    );
  }

  async listWorkflowRuns(query: ListWorkflowRunsQuery): Promise<ExternalWorkflowRunView[]> {
    const runs = await this.browse((context) =>
      this.provider.listWorkflowRuns(context, query.repositoryExternalId, query.workflowExternalId),
    );
    return runs.map(toWorkflowRunView);
  }

  async listJobs(query: WorkflowRunQuery): Promise<ExternalJobView[]> {
    const jobs = await this.browse((context) =>
      this.provider.listJobs(context, query.repositoryExternalId, query.runExternalId),
    );
    return jobs.map(toJobView);
  }

  async listArtifacts(query: WorkflowRunQuery): Promise<ExternalArtifactView[]> {
    const artifacts = await this.browse((context) =>
      this.provider.listArtifacts(context, query.repositoryExternalId, query.runExternalId),
    );
    return artifacts.map(toArtifactView);
  }

  async listAutomatedResults(query: WorkflowRunQuery): Promise<AutomatedResultView[]> {
    const results = await this.browse((context) =>
      this.provider.fetchResults(context, query.repositoryExternalId, query.runExternalId),
    );
    return results.map(toAutomatedResultView);
  }

  /** Run references per project, result references per run — one query each. */
  async listReferences(query: ListGitHubReferencesQuery): Promise<ExternalReferenceView[]> {
    let entityIds: string[];
    if (query.entityType === 'test_result') {
      const run = await this.requireRun(query.testRunId ?? '');
      await this.access.assertRouteAccess(run.projectId);
      entityIds = await this.runs.resultIdsForRun(run.id);
    } else {
      const projectId = query.projectId ?? '';
      if ((await this.projects.findById(projectId)) === null) {
        throw new NotFoundError('Project');
      }
      await this.access.assertRouteAccess(projectId);
      entityIds = await this.runs.listIds(projectId);
    }
    const references = await this.references.listForEntities(PROVIDER, query.entityType, entityIds);
    return references.map((reference) => toReferenceView(reference, query.entityType));
  }

  // -- linking a test run to a workflow run ---------------------------------

  /**
   * With a body: link (or re-link) the test run to that workflow run. Without:
   * re-read the run already linked, which is how a `queued` reference becomes
   * `completed / success` once CI finishes.
   */
  async linkRun(id: string, input: LinkWorkflowRunInput | null): Promise<GitHubSyncResultView> {
    const run = await this.requireRun(id);
    await this.access.assertRouteAccess(run.projectId);
    const connection = await this.requireConnection();

    const linked = await this.ensureRunLink(connection, run, input);
    return {
      entityType: 'test_run',
      entityId: run.id,
      action: linked.action,
      reference: toReferenceView(linked.reference, 'test_run'),
    };
  }

  // -- importing automated results ------------------------------------------

  /**
   * Turns the automated results of the linked workflow run into `TestResult`
   * rows. Idempotent by external id: importing twice adds nothing and reports
   * every result as `already_imported`. The run must be linked first, and the
   * workflow run must have finished — importing half a run would record
   * `passed` for tests that are about to fail.
   */
  async importResults(id: string): Promise<ImportAutomatedResultsView> {
    const run = await this.requireRun(id);
    await this.access.assertRouteAccess(run.projectId);
    if (run.status === 'completed' || run.status === 'aborted') {
      throw new ConflictError('This run is closed. Results can no longer be recorded.');
    }
    const connection = await this.requireConnection();
    const linked = await this.ensureRunLink(connection, run, null);

    const results = await this.guarded(() =>
      this.provider.fetchResults(
        toContext(connection),
        linked.repository.externalId,
        linked.run.externalId,
      ),
    );

    const project = await this.projects.findById(run.projectId);
    if (project === null) {
      throw new NotFoundError('Project');
    }
    const runCases = await this.runs.listAllRunCases(run.id);
    const casesByKey = new Map<string, TestRunCase>();
    for (const runCase of runCases) {
      casesByKey.set(snapshotOf(runCase).key, runCase);
    }
    const alreadyImported = new Set(
      (
        await this.references.listForEntities(
          PROVIDER,
          'test_result',
          await this.runs.resultIdsForRun(run.id),
        )
      ).map((reference) => reference.externalId),
    );

    const imported: GitHubSyncResultView[] = [];
    const skipped: SkippedAutomatedResultView[] = [];
    const userId = this.tenant.requireUserId();

    for (const result of results) {
      const skip = (reason: SkippedAutomatedResultView['reason']): void => {
        skipped.push({
          externalId: result.externalId,
          testIdentifier: result.testIdentifier,
          caseTags: result.caseTags,
          reason,
        });
      };
      if (linked.run.status !== 'completed') {
        skip('run_not_completed');
        continue;
      }
      if (alreadyImported.has(result.externalId)) {
        skip('already_imported');
        continue;
      }
      if (result.caseTags.length === 0) {
        skip('no_case_tag');
        continue;
      }
      const runCase = result.caseTags
        .map((tag) => casesByKey.get(`${project.key}-${tag}`))
        .find((candidate): candidate is TestRunCase => candidate !== undefined);
      if (runCase === undefined) {
        skip('case_not_in_run');
        continue;
      }

      const reference = await this.recordResult(connection, run, runCase, linked, result, userId);
      alreadyImported.add(result.externalId);
      imported.push({
        entityType: 'test_result',
        entityId: reference.entityId,
        action: 'created',
        reference: toReferenceView(reference, 'test_result'),
      });
    }

    if (imported.length > 0) {
      await this.audit.record({
        action: AuditAction.create,
        entityType: 'TestRun',
        entityId: run.id,
        summary: `Imported ${imported.length} automated result(s) from ${DISPLAY_NAME} run ${
          linked.reference.externalKey ?? linked.reference.externalId
        } into ${run.name}`,
        changes: {
          provider: PROVIDER,
          connectionId: connection.id,
          workflowRunExternalId: linked.run.externalId,
          imported: imported.length,
          skipped: skipped.length,
        },
      });
    }

    return {
      testRunId: run.id,
      workflowRun: toReferenceView(linked.reference, 'test_run'),
      imported,
      skipped,
    };
  }

  // -- plumbing -------------------------------------------------------------

  private async ensureRunLink(
    connection: IntegrationConnection,
    run: TestRun,
    input: LinkWorkflowRunInput | null,
  ): Promise<RunLink> {
    const existing = await this.references.findForEntity(PROVIDER, 'test_run', run.id);
    const target = input ?? targetOf(existing);
    if (target === null) {
      throw new ValidationError(
        `This run is not linked to a ${DISPLAY_NAME} workflow run yet: choose one first`,
      );
    }

    const context = toContext(connection);
    const { repository, workflowRun } = await this.guarded(async () => {
      const repositories = await this.provider.listRepositories(context);
      const found = repositories.find(
        (candidate) =>
          candidate.externalId === target.repositoryExternalId ||
          candidate.fullName.toLowerCase() === target.repositoryExternalId.toLowerCase(),
      );
      if (found === undefined) {
        throw new NotFoundError(`${DISPLAY_NAME} repository`);
      }
      const fetched = await this.provider.fetchWorkflowRun(
        context,
        found.externalId,
        target.runExternalId,
      );
      if (fetched === null) {
        throw new NotFoundError(`${DISPLAY_NAME} workflow run`);
      }
      return { repository: found, workflowRun: fetched };
    });

    const metadata = runMetadata(repository, workflowRun);
    const write = {
      externalId: workflowRun.externalId,
      externalKey: `${repository.fullName}#${workflowRun.runNumber}`,
      externalUrl: workflowRun.url,
      connectionId: connection.id,
    };

    let reference: ExternalReference;
    let action: GitHubSyncResultView['action'];
    if (existing === null) {
      reference = await this.references.create({
        provider: PROVIDER,
        entityType: 'test_run',
        entityId: run.id,
        ...write,
        metadata,
      });
      action = 'created';
    } else if (sameObservation(existing, write.externalId, metadata)) {
      reference = existing;
      action = 'unchanged';
    } else {
      const moved = existing.externalId !== write.externalId;
      const updated = await this.references.update(existing.id, {
        ...write,
        metadata: moved ? { ...metadata, previousExternalId: existing.externalId } : metadata,
      });
      if (updated === null) {
        throw new NotFoundError('External reference');
      }
      reference = updated;
      action = 'updated';
    }

    await this.connections.update(PROVIDER, {
      lastSyncAt: new Date(),
      lastError: null,
      status: IntegrationStatus.connected,
    });
    if (action !== 'unchanged') {
      await this.audit.record({
        action: AuditAction.update,
        entityType: 'TestRun',
        entityId: run.id,
        summary: `${action === 'created' ? 'Linked' : 'Refreshed'} ${DISPLAY_NAME} run ${
          write.externalKey
        } (${workflowRun.status}${
          workflowRun.conclusion === null ? '' : ` / ${workflowRun.conclusion}`
        }) for ${run.name}`,
        changes: {
          provider: PROVIDER,
          connectionId: connection.id,
          action,
          externalId: reference.externalId,
          externalKey: reference.externalKey,
        },
      });
    }
    return { reference, action, run: workflowRun, repository };
  }

  private async recordResult(
    connection: IntegrationConnection,
    run: TestRun,
    runCase: TestRunCase,
    linked: RunLink,
    result: AutomatedResult,
    userId: string,
  ): Promise<ExternalReference> {
    const status = toResultStatus(result.status);
    const snapshot = snapshotOf(runCase);
    return this.prisma.runInTransaction(async (tx) => {
      const created = await this.runs.createResult(
        {
          testRunId: run.id,
          testRunCaseId: runCase.id,
          status,
          comment: describeAutomatedResult(result, linked),
          ...(result.durationMs === null
            ? {}
            : { elapsedSeconds: Math.max(1, Math.round(result.durationMs / 1000)) }),
          executedById: userId,
          executedAt: result.executedAt,
        },
        tx,
      );
      await this.runs.setLatestStatus(runCase.id, status, tx);
      if (run.status === 'planned') {
        await this.runs.update(run.id, { status: 'in_progress', startedAt: new Date() }, tx);
        run.status = 'in_progress';
      }
      const reference = await this.references.create(
        {
          provider: PROVIDER,
          entityType: 'test_result',
          entityId: created.id,
          externalId: result.externalId,
          externalKey: result.testIdentifier,
          externalUrl: linked.run.url,
          metadata: resultMetadata(result, linked),
          connectionId: connection.id,
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.create,
          entityType: 'TestResult',
          entityId: created.id,
          summary: `Imported ${status} for ${snapshot.key} from ${DISPLAY_NAME} run ${
            linked.reference.externalKey ?? linked.run.externalId
          }`,
          changes: {
            provider: PROVIDER,
            connectionId: connection.id,
            externalId: result.externalId,
            testIdentifier: result.testIdentifier,
          },
        },
        tx,
      );
      return reference;
    });
  }

  private async browse<T>(read: (context: AdapterContext) => Promise<T>): Promise<T> {
    const connection = await this.requireConnection();
    return this.guarded(() => read(toContext(connection)));
  }

  /** Runs one provider interaction and paints the connection red only on provider errors. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IntegrationProviderError) {
        await this.connections.update(PROVIDER, {
          lastError: error.message,
          status: IntegrationStatus.error,
        });
      }
      throw error;
    }
  }

  private async requireRun(id: string): Promise<TestRun> {
    const run = await this.runs.findById(id);
    if (run === null) {
      throw new NotFoundError('Test run');
    }
    return run;
  }

  private async requireConnection(): Promise<IntegrationConnection> {
    const connection = await this.connections.findByProvider(PROVIDER);
    if (connection === null) {
      throw new IntegrationNotConfiguredError(
        DISPLAY_NAME,
        'configure it under Settings → Integrations first',
      );
    }
    if (!connection.enabled) {
      throw new IntegrationNotConfiguredError(DISPLAY_NAME, 'the integration is disconnected');
    }
    if (connection.mode !== 'mock') {
      throw new IntegrationNotConfiguredError(
        DISPLAY_NAME,
        `${connection.mode} mode has no provider yet`,
      );
    }
    return connection;
  }
}

function targetOf(reference: ExternalReference | null): LinkWorkflowRunInput | null {
  if (reference === null) {
    return null;
  }
  const metadata = toStringRecord(reference.metadata);
  const repositoryExternalId = metadata['repositoryExternalId'];
  if (repositoryExternalId === undefined) {
    return null;
  }
  return { repositoryExternalId, runExternalId: reference.externalId };
}

function runMetadata(
  repository: ExternalRepository,
  run: ExternalWorkflowRun,
): Record<string, string> {
  const source: Record<(typeof RUN_METADATA_KEYS)[number], string> = {
    repositoryExternalId: repository.externalId,
    repositoryFullName: repository.fullName,
    workflowExternalId: run.workflowExternalId,
    workflowName: run.workflowName,
    runNumber: String(run.runNumber),
    status: run.status,
    conclusion: run.conclusion ?? '',
    event: run.event,
    headBranch: run.headBranch,
    headSha: run.headSha,
    actor: run.actor,
  };
  return { ...source, syncedAt: new Date().toISOString() };
}

/** Same run, same status, same conclusion: nothing to write, nothing to audit. */
function sameObservation(
  existing: ExternalReference,
  externalId: string,
  metadata: Record<string, string>,
): boolean {
  if (existing.externalId !== externalId) {
    return false;
  }
  const current = toStringRecord(existing.metadata);
  return RUN_METADATA_KEYS.every((key) => current[key] === metadata[key]);
}

function resultMetadata(result: AutomatedResult, linked: RunLink): Record<string, string> {
  return {
    workflowRunExternalId: linked.run.externalId,
    workflowName: linked.run.workflowName,
    repositoryFullName: linked.repository.fullName,
    headSha: linked.run.headSha,
    framework: result.framework,
    file: result.file ?? '',
    project: result.project ?? '',
    status: result.status,
    durationMs: result.durationMs === null ? '' : String(result.durationMs),
    executedAt: result.executedAt.toISOString(),
    syncedAt: new Date().toISOString(),
  };
}

function describeAutomatedResult(result: AutomatedResult, linked: RunLink): string {
  const where = [result.framework, result.project].filter(
    (part): part is string => part !== null && part !== '',
  );
  const header = `Automated (${where.join(' / ')}) — ${linked.repository.fullName}#${
    linked.run.runNumber
  } · ${result.testIdentifier}`;
  return result.message === null ? header : `${header}\n\n${result.message}`;
}

function toResultStatus(status: AutomatedResult['status']): TestResultStatus {
  return TestResultStatus[status];
}

function snapshotOf(runCase: TestRunCase): RunCaseSnapshot {
  return runCase.caseSnapshot as unknown as RunCaseSnapshot;
}

function toContext(connection: IntegrationConnection): AdapterContext {
  return {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    baseUrl: connection.baseUrl,
    secretRef: connection.secretRef,
    settings: toStringRecord(connection.settings),
  };
}

function toStringRecord(value: Prisma.JsonValue | null): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function toReferenceView(
  reference: ExternalReference,
  entityType: GitHubSyncableEntity,
): ExternalReferenceView {
  return {
    id: reference.id,
    provider: PROVIDER,
    entityType,
    entityId: reference.entityId,
    externalId: reference.externalId,
    externalKey: reference.externalKey,
    externalUrl: reference.externalUrl,
    metadata: toStringRecord(reference.metadata),
    connectionId: reference.connectionId,
    createdAt: reference.createdAt.toISOString(),
    updatedAt: reference.updatedAt.toISOString(),
  };
}

function toRepositoryView(repository: ExternalRepository): ExternalRepositoryView {
  return { ...repository, updatedAt: repository.updatedAt.toISOString() };
}

function toWorkflowRunView(run: ExternalWorkflowRun): ExternalWorkflowRunView {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function toJobView(job: ExternalJob): ExternalJobView {
  return {
    ...job,
    startedAt: job.startedAt === null ? null : job.startedAt.toISOString(),
    completedAt: job.completedAt === null ? null : job.completedAt.toISOString(),
  };
}

function toArtifactView(artifact: ExternalArtifact): ExternalArtifactView {
  return { ...artifact };
}

function toAutomatedResultView(result: AutomatedResult): AutomatedResultView {
  return { ...result, executedAt: result.executedAt.toISOString() };
}
