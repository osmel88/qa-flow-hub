import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ExternalReference,
  IntegrationConnection,
  IntegrationStatus,
  Prisma,
  TestCase,
  TestResult,
  TestRun,
  TestStep,
  TestSuite,
} from '@prisma/client';
import {
  ExternalCaseView,
  ExternalProjectView,
  ExternalReferenceView,
  ExternalRunView,
  ExternalSuiteView,
  ListExternalCasesQuery,
  ListExternalSuitesQuery,
  ListTestRailReferencesQuery,
  TestManagementCatalogView,
  TestRailSyncableEntity,
  TestRailSyncResultView,
} from '@qa-flow-hub/shared';
import {
  AdapterContext,
  ExternalCase,
  ExternalRef,
  ExternalRun,
  ExternalSuite,
  TestManagementAdapter,
  TEST_MANAGEMENT_ADAPTER,
} from '../../integrations';
import {
  ConflictError,
  IntegrationNotConfiguredError,
  IntegrationProviderError,
  NotFoundError,
} from '../../errors';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { TestDesignRepository } from '../test-design/test-design.repository';
import { TestRunsRepository } from '../test-runs/test-runs.repository';
import { ExternalReferencesRepository } from './external-references.repository';
import { IntegrationSettingsRepository } from './integration-settings.repository';

const PROVIDER = 'testrail' as const;
const DISPLAY_NAME = 'TestRail';

const AUDIT_ENTITY: Record<TestRailSyncableEntity, string> = {
  test_suite: 'TestSuite',
  test_case: 'TestCase',
  test_run: 'TestRun',
  test_result: 'TestResult',
};

interface SyncOutcome {
  ref: ExternalRef;
  action: TestRailSyncResultView['action'];
}

interface Synced {
  reference: ExternalReference;
  action: TestRailSyncResultView['action'];
}

/**
 * Pushes suites, cases, runs and results to the test management provider.
 *
 * Same three rules as `JiraSyncService` — authorization first, one reference
 * per entity, the connection records what happened — plus one that is specific
 * to this domain: **dependencies are synced on the way**. A TestRail case
 * cannot exist without its suite, a run without its suite and cases, a result
 * without its run; asking the user to sync each level by hand in the right
 * order would turn a button into a procedure. So `syncCase()` ensures the suite
 * reference first, `syncRun()` ensures the suite and every case, and each call
 * reports what it had to create along the way in `dependencies`.
 *
 * Every dependency is resolved through `ExternalReference`, never through a
 * column on the business entity: the day this runs against a real TestRail,
 * `TestSuite` still has no `testrailSuiteId`.
 */
@Injectable()
export class TestRailSyncService {
  constructor(
    @Inject(TEST_MANAGEMENT_ADAPTER) private readonly provider: TestManagementAdapter,
    private readonly connections: IntegrationSettingsRepository,
    private readonly references: ExternalReferencesRepository,
    private readonly design: TestDesignRepository,
    private readonly runs: TestRunsRepository,
    private readonly access: ProjectAccessService,
    private readonly projects: ProjectsRepository,
    private readonly audit: AuditService,
  ) {}

  // -- browsing -------------------------------------------------------------

  async listProjects(): Promise<ExternalProjectView[]> {
    return this.provider.listProjects(await this.requireContext());
  }

  async describe(): Promise<TestManagementCatalogView> {
    return this.provider.describe(await this.requireContext());
  }

  async listSuites(query: ListExternalSuitesQuery): Promise<ExternalSuiteView[]> {
    const suites = await this.provider.listSuites(await this.requireContext(), query.projectKey);
    return suites.map(toSuiteView);
  }

  async listCases(query: ListExternalCasesQuery): Promise<ExternalCaseView[]> {
    const cases = await this.provider.listCases(await this.requireContext(), query.suiteExternalId);
    return cases.map(toCaseView);
  }

  async listRuns(query: ListExternalSuitesQuery): Promise<ExternalRunView[]> {
    const runs = await this.provider.listRuns(await this.requireContext(), query.projectKey);
    return runs.map(toRunView);
  }

  /**
   * Every TestRail reference of one entity type, in one query: per project for
   * suites, cases and runs; per run for results.
   */
  async listReferences(query: ListTestRailReferencesQuery): Promise<ExternalReferenceView[]> {
    let entityIds: string[];
    if (query.entityType === 'test_result') {
      const run = await this.runs.findById(query.testRunId ?? '');
      if (run === null) {
        throw new NotFoundError('Test run');
      }
      await this.access.assertRouteAccess(run.projectId);
      entityIds = await this.runs.resultIdsForRun(run.id);
    } else {
      const projectId = query.projectId ?? '';
      if ((await this.projects.findById(projectId)) === null) {
        throw new NotFoundError('Project');
      }
      await this.access.assertRouteAccess(projectId);
      entityIds =
        query.entityType === 'test_suite'
          ? await this.design.listSuiteIds(projectId)
          : query.entityType === 'test_case'
            ? await this.design.listCaseIds(projectId)
            : await this.runs.listIds(projectId);
    }

    const references = await this.references.listForEntities(PROVIDER, query.entityType, entityIds);
    return references.map((reference) => toReferenceView(reference, query.entityType));
  }

  // -- sync entry points ----------------------------------------------------

  async syncSuite(id: string): Promise<TestRailSyncResultView> {
    const suite = await this.requireSuite(id);
    await this.access.assertRouteAccess(suite.projectId);
    const connection = await this.requireConnection();

    const synced = await this.ensureSuite(connection, suite);
    return this.result('test_suite', suite.id, synced, []);
  }

  async syncCase(id: string): Promise<TestRailSyncResultView> {
    const testCase = await this.design.findCaseWithSteps(id);
    if (testCase === null) {
      throw new NotFoundError('Test case');
    }
    await this.access.assertRouteAccess(testCase.projectId);
    const connection = await this.requireConnection();

    const dependencies: ExternalReferenceView[] = [];
    const synced = await this.ensureCase(connection, testCase, dependencies);
    return this.result('test_case', testCase.id, synced, dependencies);
  }

  async syncRun(id: string): Promise<TestRailSyncResultView> {
    const run = await this.runs.findById(id);
    if (run === null) {
      throw new NotFoundError('Test run');
    }
    await this.access.assertRouteAccess(run.projectId);
    const connection = await this.requireConnection();

    const dependencies: ExternalReferenceView[] = [];
    const synced = await this.ensureRun(connection, run, dependencies);
    return this.result('test_run', run.id, synced, dependencies);
  }

  async syncResult(id: string): Promise<TestRailSyncResultView> {
    const result = await this.runs.findResultById(id);
    if (result === null) {
      throw new NotFoundError('Test result');
    }
    const run = await this.runs.findById(result.testRunId);
    const runCase = await this.runs.findRunCaseById(result.testRunCaseId);
    if (run === null || runCase === null) {
      throw new NotFoundError('Test run');
    }
    await this.access.assertRouteAccess(run.projectId);
    const connection = await this.requireConnection();

    const dependencies: ExternalReferenceView[] = [];
    const runRef = await this.ensureRun(connection, run, dependencies);
    dependencies.push(toReferenceView(runRef.reference, 'test_run'));
    const caseRef = await this.references.findForEntity(PROVIDER, 'test_case', runCase.testCaseId);
    if (caseRef === null) {
      // ensureRun() synced every case of the run's suite; a missing reference
      // means this case lives in another suite and was left out of the export.
      throw new ConflictError(
        `The case of this result is not part of the ${DISPLAY_NAME} run (it belongs to another suite)`,
        { testRunId: run.id, testCaseId: runCase.testCaseId },
      );
    }

    const existing = await this.references.findForEntity(PROVIDER, 'test_result', result.id);
    const context = toContext(connection);
    const outcome = await this.guarded(async () => {
      if (existing !== null) {
        const known = await this.provider.fetchResult(context, existing.externalId);
        if (known !== null) {
          return { ref: refFromReference(existing), action: 'unchanged' as const };
        }
      }
      return {
        ref: await this.provider.addResult(context, {
          runExternalId: runRef.reference.externalId,
          caseExternalId: caseRef.externalId,
          status: result.status,
          comment: result.comment,
          elapsedSeconds: result.elapsedSeconds,
        }),
        action: 'created' as const,
      };
    });

    const synced = await this.persist(
      connection,
      'test_result',
      result.id,
      run.projectId,
      existing,
      outcome,
    );
    await this.recordSuccess(
      connection,
      'test_result',
      result.id,
      describeResult(result, run),
      synced,
    );
    return this.result('test_result', result.id, synced, dependencies);
  }

  // -- ensure* : sync an entity and everything it depends on ----------------

  private async ensureSuite(connection: IntegrationConnection, suite: TestSuite): Promise<Synced> {
    const existing = await this.references.findForEntity(PROVIDER, 'test_suite', suite.id);
    const context = toContext(connection);
    const payload = { projectKey: null, name: suite.name, description: suite.description };

    const outcome = await this.guarded(async () => {
      if (existing === null) {
        return {
          ref: await this.provider.createSuite(context, payload),
          action: 'created' as const,
        };
      }
      const known: ExternalSuite | null = await this.provider.fetchSuite(
        context,
        existing.externalId,
      );
      if (known === null) {
        return {
          ref: await this.provider.createSuite(context, payload),
          action: 'created' as const,
        };
      }
      return {
        ref: await this.provider.updateSuite(context, existing.externalId, payload),
        action: 'updated' as const,
      };
    });

    const synced = await this.persist(
      connection,
      'test_suite',
      suite.id,
      suite.projectId,
      existing,
      outcome,
    );
    await this.recordSuccess(connection, 'test_suite', suite.id, suite.name, synced);
    return synced;
  }

  private async ensureCase(
    connection: IntegrationConnection,
    testCase: TestCase & { steps: TestStep[] },
    dependencies: ExternalReferenceView[],
  ): Promise<Synced> {
    const suite = await this.requireSuite(testCase.suiteId);
    const suiteRef = await this.ensureSuite(connection, suite);
    dependencies.push(toReferenceView(suiteRef.reference, 'test_suite'));

    const section =
      testCase.sectionId === null ? null : await this.design.findSectionById(testCase.sectionId);

    const existing = await this.references.findForEntity(PROVIDER, 'test_case', testCase.id);
    const context = toContext(connection);
    const payload = {
      suiteExternalId: suiteRef.reference.externalId,
      sectionName: section?.name ?? null,
      title: testCase.title,
      type: testCase.type,
      priority: testCase.priority,
      preconditions: testCase.preconditions,
      expectedResult: testCase.expectedResult,
      steps: testCase.steps.map((step) => ({
        action: step.action,
        expectedResult: step.expectedResult,
      })),
      originKey: testCase.key,
      labels: testCase.tags,
    };

    const outcome = await this.guarded(async () => {
      if (existing === null) {
        return {
          ref: await this.provider.createCase(context, payload),
          action: 'created' as const,
        };
      }
      const known: ExternalCase | null = await this.provider.fetchCase(
        context,
        existing.externalId,
      );
      if (known === null) {
        return {
          ref: await this.provider.createCase(context, payload),
          action: 'created' as const,
        };
      }
      return {
        ref: await this.provider.updateCase(context, existing.externalId, payload),
        action: 'updated' as const,
      };
    });

    const synced = await this.persist(
      connection,
      'test_case',
      testCase.id,
      testCase.projectId,
      existing,
      outcome,
    );
    await this.recordSuccess(connection, 'test_case', testCase.id, testCase.key, synced);
    return synced;
  }

  /**
   * A TestRail run belongs to exactly one suite; ours can mix cases from
   * several. The run is exported against the suite that holds most of its
   * cases and the others are left out — listed in the reference's metadata so
   * the omission is visible rather than silent. A run with no cases has no
   * suite to belong to and is refused.
   */
  private async ensureRun(
    connection: IntegrationConnection,
    run: TestRun,
    dependencies: ExternalReferenceView[],
  ): Promise<Synced> {
    const runCases = await this.runs.listCaseIdsInRun(run.id);
    const cases: Array<TestCase & { steps: TestStep[] }> = [];
    for (const { testCaseId } of runCases) {
      const testCase = await this.design.findCaseWithSteps(testCaseId);
      if (testCase !== null) {
        cases.push(testCase);
      }
    }
    if (cases.length === 0) {
      throw new ConflictError(`Test run "${run.name}" has no cases to export to ${DISPLAY_NAME}`, {
        testRunId: run.id,
      });
    }

    const suiteId = dominantSuite(cases);
    const inSuite = cases.filter((testCase) => testCase.suiteId === suiteId);
    const skipped = cases.filter((testCase) => testCase.suiteId !== suiteId).map((c) => c.key);

    const suite = await this.requireSuite(suiteId);
    const suiteRef = await this.ensureSuite(connection, suite);
    dependencies.push(toReferenceView(suiteRef.reference, 'test_suite'));

    const caseExternalIds: string[] = [];
    for (const testCase of inSuite) {
      const caseRef = await this.ensureCase(connection, testCase, []);
      dependencies.push(toReferenceView(caseRef.reference, 'test_case'));
      caseExternalIds.push(caseRef.reference.externalId);
    }

    const existing = await this.references.findForEntity(PROVIDER, 'test_run', run.id);
    const context = toContext(connection);
    const payload = {
      suiteExternalId: suiteRef.reference.externalId,
      name: run.name,
      description: describeRun(run),
      caseExternalIds,
      state: run.status,
    };

    const outcome = await this.guarded(async () => {
      if (existing === null) {
        return { ref: await this.provider.createRun(context, payload), action: 'created' as const };
      }
      const known: ExternalRun | null = await this.provider.fetchRun(context, existing.externalId);
      if (known === null) {
        return { ref: await this.provider.createRun(context, payload), action: 'created' as const };
      }
      return {
        ref: await this.provider.updateRun(context, existing.externalId, payload),
        action: 'updated' as const,
      };
    });
    if (skipped.length > 0) {
      outcome.ref = {
        ...outcome.ref,
        metadata: { ...(outcome.ref.metadata ?? {}), skippedCases: skipped.join(',') },
      };
    }

    const synced = await this.persist(
      connection,
      'test_run',
      run.id,
      run.projectId,
      existing,
      outcome,
    );
    await this.recordSuccess(connection, 'test_run', run.id, run.name, synced);
    return synced;
  }

  // -- plumbing -------------------------------------------------------------

  /** Runs one provider interaction and paints the connection red only on provider errors. */
  private async guarded(operation: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
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

  /** One reference per entity, always; a recreated external object moves the row. */
  private async persist(
    connection: IntegrationConnection,
    entityType: TestRailSyncableEntity,
    entityId: string,
    projectId: string,
    existing: ExternalReference | null,
    outcome: SyncOutcome,
  ): Promise<Synced> {
    const metadata = toMetadata(outcome.ref);
    if (existing === null) {
      const reference = await this.references.create({
        provider: PROVIDER,
        entityType,
        entityId,
        projectId,
        externalId: outcome.ref.externalId,
        externalKey: outcome.ref.externalKey ?? null,
        externalUrl: outcome.ref.externalUrl ?? null,
        metadata,
        connectionId: connection.id,
      });
      return { reference, action: outcome.action };
    }
    if (outcome.action === 'unchanged') {
      return { reference: existing, action: outcome.action };
    }
    const moved = existing.externalId !== outcome.ref.externalId;
    const reference = await this.references.update(existing.id, {
      externalId: outcome.ref.externalId,
      externalKey: outcome.ref.externalKey ?? null,
      externalUrl: outcome.ref.externalUrl ?? null,
      metadata: moved ? { ...metadata, previousExternalId: existing.externalId } : metadata,
      connectionId: connection.id,
    });
    if (reference === null) {
      throw new NotFoundError('External reference');
    }
    return { reference, action: outcome.action };
  }

  private async recordSuccess(
    connection: IntegrationConnection,
    entityType: TestRailSyncableEntity,
    entityId: string,
    label: string,
    synced: Synced,
  ): Promise<void> {
    await this.connections.update(PROVIDER, {
      lastSyncAt: new Date(),
      lastError: null,
      status: IntegrationStatus.connected,
    });
    if (synced.action === 'unchanged') {
      return;
    }
    const verb = synced.action === 'created' ? 'Created' : 'Updated';
    await this.audit.record({
      action: AuditAction.update,
      entityType: AUDIT_ENTITY[entityType],
      entityId,
      summary: `${verb} ${DISPLAY_NAME} ${entityType.replace('test_', '')} ${
        synced.reference.externalKey ?? synced.reference.externalId
      } from ${label}`,
      changes: {
        provider: PROVIDER,
        connectionId: connection.id,
        action: synced.action,
        externalId: synced.reference.externalId,
        externalKey: synced.reference.externalKey,
      },
    });
  }

  private result(
    entityType: TestRailSyncableEntity,
    entityId: string,
    synced: Synced,
    dependencies: ExternalReferenceView[],
  ): TestRailSyncResultView {
    return {
      entityType,
      entityId,
      action: synced.action,
      reference: toReferenceView(synced.reference, entityType),
      dependencies: dedupe(dependencies),
    };
  }

  private async requireSuite(id: string): Promise<TestSuite> {
    const suite = await this.design.findSuiteById(id);
    if (suite === null) {
      throw new NotFoundError('Test suite');
    }
    return suite;
  }

  private async requireContext(): Promise<AdapterContext> {
    return toContext(await this.requireConnection());
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

function dominantSuite(cases: Array<Pick<TestCase, 'suiteId'>>): string {
  const counts = new Map<string, number>();
  for (const testCase of cases) {
    counts.set(testCase.suiteId, (counts.get(testCase.suiteId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [suiteId, count] of counts) {
    if (count > bestCount) {
      best = suiteId;
      bestCount = count;
    }
  }
  if (best === null) {
    throw new Error('dominantSuite() called with no cases');
  }
  return best;
}

function dedupe(references: ExternalReferenceView[]): ExternalReferenceView[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.id)) return false;
    seen.add(reference.id);
    return true;
  });
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

function toMetadata(ref: ExternalRef): Record<string, string> {
  const metadata: Record<string, string> = { syncedAt: new Date().toISOString() };
  for (const [key, entry] of Object.entries(ref.metadata ?? {})) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
    }
  }
  return metadata;
}

function refFromReference(reference: ExternalReference): ExternalRef {
  return {
    provider: PROVIDER,
    externalId: reference.externalId,
    ...(reference.externalKey === null ? {} : { externalKey: reference.externalKey }),
    ...(reference.externalUrl === null ? {} : { externalUrl: reference.externalUrl }),
    metadata: toStringRecord(reference.metadata),
  };
}

function toReferenceView(
  reference: ExternalReference,
  entityType: TestRailSyncableEntity,
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

function toSuiteView(suite: ExternalSuite): ExternalSuiteView {
  return { ...suite, updatedAt: suite.updatedAt.toISOString() };
}

function toCaseView(testCase: ExternalCase): ExternalCaseView {
  return { ...testCase, updatedAt: testCase.updatedAt.toISOString() };
}

function toRunView(run: ExternalRun): ExternalRunView {
  return { ...run, updatedAt: run.updatedAt.toISOString() };
}

function describeRun(run: TestRun): string | null {
  const parts = [
    run.description,
    run.milestone === null ? null : `Milestone: ${run.milestone}`,
    run.environment === null ? null : `Environment: ${run.environment}`,
  ].filter((part): part is string => part !== null && part.trim() !== '');
  return parts.length === 0 ? null : parts.join('\n\n');
}

function describeResult(result: TestResult, run: TestRun): string {
  return `${run.name} (${result.status})`;
}
