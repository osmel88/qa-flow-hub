import { Injectable } from '@nestjs/common';
import { IntegrationProviderError } from '../../errors/domain-error';
import {
  AdapterContext,
  CasePayload,
  ExternalCase,
  ExternalProject,
  ExternalRef,
  ExternalResult,
  ExternalRun,
  ExternalSuite,
  HealthCheck,
  ImportedCase,
  ResultPayload,
  RunPayload,
  SuitePayload,
  TestManagementAdapter,
  TestManagementCatalog,
} from '../adapter.contracts';
import {
  TESTRAIL_MOCK_CASE_TYPES,
  TESTRAIL_MOCK_DEFAULT_PROJECT_ID,
  TESTRAIL_MOCK_PRIORITIES,
  TESTRAIL_MOCK_STATUSES,
  TESTRAIL_UNTESTED_STATUS_ID,
  TestRailMockCase,
  TestRailMockResult,
  TestRailMockRun,
  TestRailMockStore,
  TestRailMockSuite,
} from './testrail-mock.store';

/**
 * Non-sensitive settings the mock understands, stored in
 * `IntegrationConnection.settings` like any provider's:
 *
 *  - `projectId`        the TestRail project suites and runs are created in (`1`);
 *  - `simulateFailure`  `unreachable` fails every call, `write_failure` lets
 *                       reads succeed and refuses writes.
 */
export const TESTRAIL_MOCK_SETTING_PROJECT_ID = 'projectId';
export const TESTRAIL_MOCK_SETTING_SIMULATE_FAILURE = 'simulateFailure';
export const TESTRAIL_MOCK_FAILURE_MODES = ['unreachable', 'write_failure'] as const;
export type TestRailMockFailureMode = (typeof TESTRAIL_MOCK_FAILURE_MODES)[number];

const PROVIDER = 'TestRail mock';

/** Our `Priority` enum against TestRail's default priorities. */
const PRIORITY_ID_BY_NAME: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Our `TestCaseType` against TestRail's default case types. */
const TYPE_ID_BY_NAME: Record<string, number> = {
  functional: 6,
  regression: 9,
  smoke: 11,
  integration: 6,
  performance: 8,
  security: 10,
  usability: 12,
  exploratory: 7,
};

/** Our `TestResultStatus` against the mock's statuses (`skipped` is the custom one). */
const STATUS_ID_BY_NAME: Record<string, number> = {
  untested: 3,
  passed: 1,
  failed: 5,
  blocked: 2,
  skipped: 6,
};

@Injectable()
export class TestRailMockTestManagementAdapter implements TestManagementAdapter {
  readonly provider = 'testrail' as const;

  constructor(private readonly store: TestRailMockStore) {}

  async check(context: AdapterContext): Promise<HealthCheck> {
    const checkedAt = new Date();
    if (failureMode(context) === 'unreachable') {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: simulated outage (settings.simulateFailure=unreachable)`,
        checkedAt,
      });
    }

    const projectId = projectIdOf(context);
    const project = this.store.findProject(context.organizationId, projectId);
    if (project === null) {
      return Promise.resolve({
        reachable: false,
        message: `${PROVIDER}: project ${projectId} does not exist. Known projects: ${this.store
          .listProjects(context.organizationId)
          .map((known) => `${known.id} (${known.name})`)
          .join(', ')}`,
        checkedAt,
      });
    }

    return Promise.resolve({
      reachable: true,
      message: `${PROVIDER}: reachable, suites and runs will be created in project ${project.name}`,
      checkedAt,
    });
  }

  async describe(context: AdapterContext): Promise<TestManagementCatalog> {
    this.assertReachable(context);
    return Promise.resolve({
      statuses: TESTRAIL_MOCK_STATUSES.map((status) => status.label),
      priorities: TESTRAIL_MOCK_PRIORITIES.map((priority) => priority.name),
      caseTypes: TESTRAIL_MOCK_CASE_TYPES.map((type) => type.name),
    });
  }

  async listProjects(context: AdapterContext): Promise<ExternalProject[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listProjects(context.organizationId)
        .map((project) => ({ externalId: project.id, key: project.id, name: project.name })),
    );
  }

  async listSuites(context: AdapterContext, projectKey?: string): Promise<ExternalSuite[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listSuites(context.organizationId, projectKey)
        .map((suite) => this.toSuite(context, suite)),
    );
  }

  async listCases(context: AdapterContext, suiteExternalId: string): Promise<ExternalCase[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listCases(context.organizationId, suiteExternalId)
        .map((testCase) => this.toCase(context, testCase)),
    );
  }

  async listRuns(context: AdapterContext, projectKey?: string): Promise<ExternalRun[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store
        .listRuns(context.organizationId, projectKey)
        .map((run) => this.toRun(context, run)),
    );
  }

  async importCases(context: AdapterContext, suiteExternalId: string): Promise<ImportedCase[]> {
    this.assertReachable(context);
    return Promise.resolve(
      this.store.listCases(context.organizationId, suiteExternalId).map((testCase) => ({
        externalId: testCase.id,
        key: `C${testCase.id}`,
        title: testCase.title,
        steps: testCase.steps.map((step) => ({
          action: step.content,
          expectedResult: step.expected,
        })),
      })),
    );
  }

  // -- suites ---------------------------------------------------------------

  async createSuite(context: AdapterContext, payload: SuitePayload): Promise<ExternalRef> {
    this.assertWritable(context);
    const projectId = payload.projectKey ?? projectIdOf(context);
    if (this.store.findProject(context.organizationId, projectId) === null) {
      throw new IntegrationProviderError(PROVIDER, `project ${projectId} does not exist`);
    }
    const suite = this.store.createSuite(context.organizationId, {
      projectId,
      name: payload.name,
      description: payload.description,
    });
    return Promise.resolve(this.suiteRef(context, suite));
  }

  async updateSuite(
    context: AdapterContext,
    externalId: string,
    payload: SuitePayload,
  ): Promise<ExternalRef> {
    this.assertWritable(context);
    const suite = this.store.updateSuite(context.organizationId, externalId, {
      name: payload.name,
      description: payload.description,
    });
    if (suite === null) {
      throw new IntegrationProviderError(PROVIDER, `suite S${externalId} does not exist`);
    }
    return Promise.resolve(this.suiteRef(context, suite));
  }

  async fetchSuite(context: AdapterContext, externalId: string): Promise<ExternalSuite | null> {
    this.assertReachable(context);
    const suite = this.store.findSuite(context.organizationId, externalId);
    return Promise.resolve(suite === null ? null : this.toSuite(context, suite));
  }

  // -- cases ----------------------------------------------------------------

  async createCase(context: AdapterContext, payload: CasePayload): Promise<ExternalRef> {
    this.assertWritable(context);
    if (this.store.findSuite(context.organizationId, payload.suiteExternalId) === null) {
      throw new IntegrationProviderError(
        PROVIDER,
        `suite S${payload.suiteExternalId} does not exist`,
      );
    }
    const section = this.store.ensureSection(
      context.organizationId,
      payload.suiteExternalId,
      payload.sectionName,
    );
    const testCase = this.store.createCase(context.organizationId, {
      suiteId: payload.suiteExternalId,
      sectionId: section.id,
      ...caseFields(payload),
    });
    return Promise.resolve(this.caseRef(context, testCase));
  }

  async updateCase(
    context: AdapterContext,
    externalId: string,
    payload: CasePayload,
  ): Promise<ExternalRef> {
    this.assertWritable(context);
    const current = this.store.findCase(context.organizationId, externalId);
    if (current === null) {
      throw new IntegrationProviderError(PROVIDER, `case C${externalId} does not exist`);
    }
    const section = this.store.ensureSection(
      context.organizationId,
      current.suiteId,
      payload.sectionName,
    );
    const testCase = this.store.updateCase(context.organizationId, externalId, {
      sectionId: section.id,
      ...caseFields(payload),
    });
    if (testCase === null) {
      throw new IntegrationProviderError(PROVIDER, `case C${externalId} does not exist`);
    }
    return Promise.resolve(this.caseRef(context, testCase));
  }

  async fetchCase(context: AdapterContext, externalId: string): Promise<ExternalCase | null> {
    this.assertReachable(context);
    const testCase = this.store.findCase(context.organizationId, externalId);
    return Promise.resolve(testCase === null ? null : this.toCase(context, testCase));
  }

  // -- runs -----------------------------------------------------------------

  async createRun(context: AdapterContext, payload: RunPayload): Promise<ExternalRef> {
    this.assertWritable(context);
    const suite = this.store.findSuite(context.organizationId, payload.suiteExternalId);
    if (suite === null) {
      throw new IntegrationProviderError(
        PROVIDER,
        `suite S${payload.suiteExternalId} does not exist`,
      );
    }
    this.assertCasesExist(context, payload.caseExternalIds);
    const run = this.store.createRun(
      context.organizationId,
      {
        projectId: suite.projectId,
        suiteId: suite.id,
        name: payload.name,
        description: payload.description,
      },
      payload.caseExternalIds,
    );
    const completed = this.store.updateRun(context.organizationId, run.id, {
      isCompleted: isCompletedState(payload.state),
    });
    return Promise.resolve(this.runRef(context, completed ?? run));
  }

  async updateRun(
    context: AdapterContext,
    externalId: string,
    payload: RunPayload,
  ): Promise<ExternalRef> {
    this.assertWritable(context);
    this.assertCasesExist(context, payload.caseExternalIds);
    const run = this.store.updateRun(context.organizationId, externalId, {
      name: payload.name,
      description: payload.description,
      isCompleted: isCompletedState(payload.state),
      caseIds: payload.caseExternalIds,
    });
    if (run === null) {
      throw new IntegrationProviderError(PROVIDER, `run R${externalId} does not exist`);
    }
    return Promise.resolve(this.runRef(context, run));
  }

  async fetchRun(context: AdapterContext, externalId: string): Promise<ExternalRun | null> {
    this.assertReachable(context);
    const run = this.store.findRun(context.organizationId, externalId);
    return Promise.resolve(run === null ? null : this.toRun(context, run));
  }

  // -- results --------------------------------------------------------------

  async addResult(context: AdapterContext, payload: ResultPayload): Promise<ExternalRef> {
    this.assertWritable(context);
    if (this.store.findRun(context.organizationId, payload.runExternalId) === null) {
      throw new IntegrationProviderError(PROVIDER, `run R${payload.runExternalId} does not exist`);
    }
    const result = this.store.addResult(context.organizationId, {
      runId: payload.runExternalId,
      caseId: payload.caseExternalId,
      statusId: STATUS_ID_BY_NAME[payload.status] ?? TESTRAIL_UNTESTED_STATUS_ID,
      comment: payload.comment,
      elapsedSeconds: payload.elapsedSeconds,
    });
    if (result === null) {
      throw new IntegrationProviderError(
        PROVIDER,
        `case C${payload.caseExternalId} is not part of run R${payload.runExternalId}`,
      );
    }
    return Promise.resolve(
      this.resultRef(context, result, payload.runExternalId, payload.caseExternalId),
    );
  }

  async fetchResult(context: AdapterContext, externalId: string): Promise<ExternalResult | null> {
    this.assertReachable(context);
    const result = this.store.findResult(context.organizationId, externalId);
    if (result === null) {
      return Promise.resolve(null);
    }
    const test = this.store.findTestById(context.organizationId, result.testId);
    return Promise.resolve({
      externalId: result.id,
      runExternalId: test?.runId ?? '',
      caseExternalId: test?.caseId ?? '',
      status: statusLabel(result.statusId),
      comment: result.comment,
      elapsedSeconds: result.elapsedSeconds,
      recordedAt: result.createdAt,
    });
  }

  // -- helpers --------------------------------------------------------------

  private assertReachable(context: AdapterContext): void {
    if (failureMode(context) === 'unreachable') {
      throw new IntegrationProviderError(PROVIDER, 'simulated outage, the provider is unreachable');
    }
  }

  private assertWritable(context: AdapterContext): void {
    this.assertReachable(context);
    if (failureMode(context) === 'write_failure') {
      throw new IntegrationProviderError(
        PROVIDER,
        'simulated failure, the provider refused the write',
      );
    }
  }

  private assertCasesExist(context: AdapterContext, caseIds: string[]): void {
    for (const caseId of caseIds) {
      if (this.store.findCase(context.organizationId, caseId) === null) {
        throw new IntegrationProviderError(PROVIDER, `case C${caseId} does not exist`);
      }
    }
  }

  private suiteRef(context: AdapterContext, suite: TestRailMockSuite): ExternalRef {
    return ref(context, suite.id, `S${suite.id}`, `suites/view/${suite.id}`, {
      projectId: suite.projectId,
      name: suite.name,
    });
  }

  private caseRef(context: AdapterContext, testCase: TestRailMockCase): ExternalRef {
    const section = this.store.findSection(context.organizationId, testCase.sectionId);
    return ref(context, testCase.id, `C${testCase.id}`, `cases/view/${testCase.id}`, {
      suiteId: testCase.suiteId,
      sectionId: testCase.sectionId,
      sectionName: section?.name ?? '',
      type: typeName(testCase.typeId),
      priority: priorityName(testCase.priorityId),
    });
  }

  private runRef(context: AdapterContext, run: TestRailMockRun): ExternalRef {
    return ref(context, run.id, `R${run.id}`, `runs/view/${run.id}`, {
      projectId: run.projectId,
      suiteId: run.suiteId,
      status: run.isCompleted ? 'Completed' : 'Active',
    });
  }

  private resultRef(
    context: AdapterContext,
    result: TestRailMockResult,
    runId: string,
    caseId: string,
  ): ExternalRef {
    return ref(context, result.id, null, `tests/view/${result.testId}`, {
      testId: result.testId,
      runId,
      caseId,
      status: statusLabel(result.statusId),
    });
  }

  private toSuite(context: AdapterContext, suite: TestRailMockSuite): ExternalSuite {
    return {
      externalId: suite.id,
      projectKey: suite.projectId,
      name: suite.name,
      description: suite.description,
      url: viewUrl(context, `suites/view/${suite.id}`),
      caseCount: this.store.countCases(context.organizationId, suite.id),
      updatedAt: suite.updatedAt,
    };
  }

  private toCase(context: AdapterContext, testCase: TestRailMockCase): ExternalCase {
    const section = this.store.findSection(context.organizationId, testCase.sectionId);
    return {
      externalId: testCase.id,
      key: `C${testCase.id}`,
      url: viewUrl(context, `cases/view/${testCase.id}`),
      suiteExternalId: testCase.suiteId,
      sectionName: section === null || section.parentId === null ? null : section.name,
      title: testCase.title,
      type: typeName(testCase.typeId),
      priority: priorityName(testCase.priorityId),
      stepCount: testCase.steps.length,
      updatedAt: testCase.updatedAt,
    };
  }

  private toRun(context: AdapterContext, run: TestRailMockRun): ExternalRun {
    const tests = this.store.listTests(context.organizationId, run.id);
    const statusCounts: Record<string, number> = {};
    for (const test of tests) {
      const label = statusLabel(test.statusId);
      statusCounts[label] = (statusCounts[label] ?? 0) + 1;
    }
    return {
      externalId: run.id,
      url: viewUrl(context, `runs/view/${run.id}`),
      suiteExternalId: run.suiteId,
      name: run.name,
      status: run.isCompleted ? 'Completed' : 'Active',
      caseCount: tests.length,
      statusCounts,
      updatedAt: run.updatedAt,
    };
  }
}

function settingOf(context: AdapterContext, key: string): string | undefined {
  const value = context.settings[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function projectIdOf(context: AdapterContext): string {
  return settingOf(context, TESTRAIL_MOCK_SETTING_PROJECT_ID) ?? TESTRAIL_MOCK_DEFAULT_PROJECT_ID;
}

function failureMode(context: AdapterContext): TestRailMockFailureMode | null {
  const value = settingOf(context, TESTRAIL_MOCK_SETTING_SIMULATE_FAILURE);
  return TESTRAIL_MOCK_FAILURE_MODES.find((mode) => mode === value) ?? null;
}

/** TestRail's `index.php?/<entity>/view/<id>` scheme; `null` without a base URL. */
function viewUrl(context: AdapterContext, path: string): string | null {
  if (context.baseUrl === null) {
    return null;
  }
  return `${context.baseUrl.replace(/\/+$/, '')}/index.php?/${path}`;
}

function ref(
  context: AdapterContext,
  externalId: string,
  externalKey: string | null,
  path: string,
  metadata: Record<string, string>,
): ExternalRef {
  const url = viewUrl(context, path);
  return {
    provider: 'testrail',
    externalId,
    ...(externalKey === null ? {} : { externalKey }),
    ...(url === null ? {} : { externalUrl: url }),
    metadata,
  };
}

function caseFields(payload: CasePayload): {
  title: string;
  typeId: number;
  priorityId: number;
  preconditions: string | null;
  expected: string | null;
  steps: Array<{ content: string; expected: string | null }>;
  refs: string | null;
} {
  const refs = [payload.originKey, ...payload.labels].filter(
    (value): value is string => value !== null && value !== '',
  );
  return {
    title: payload.title,
    typeId: TYPE_ID_BY_NAME[payload.type] ?? 7,
    priorityId: PRIORITY_ID_BY_NAME[payload.priority] ?? 2,
    preconditions: payload.preconditions,
    expected: payload.expectedResult,
    steps: payload.steps.map((step) => ({ content: step.action, expected: step.expectedResult })),
    refs: refs.length === 0 ? null : refs.join(','),
  };
}

/** Our `TestRunStatus` collapses onto TestRail's single `is_completed` flag. */
function isCompletedState(state: string): boolean {
  return state === 'completed' || state === 'aborted';
}

function statusLabel(statusId: number): string {
  return TESTRAIL_MOCK_STATUSES.find((status) => status.id === statusId)?.label ?? 'Untested';
}

function priorityName(priorityId: number): string {
  return TESTRAIL_MOCK_PRIORITIES.find((priority) => priority.id === priorityId)?.name ?? 'Medium';
}

function typeName(typeId: number): string {
  return TESTRAIL_MOCK_CASE_TYPES.find((type) => type.id === typeId)?.name ?? 'Other';
}
