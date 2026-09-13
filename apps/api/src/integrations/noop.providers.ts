import { Injectable, Logger } from '@nestjs/common';
import { IntegrationNotConfiguredError } from '../errors/domain-error';
import {
  AdapterContext,
  AutomatedResult,
  AutomationProviderAdapter,
  EmailAdapter,
  ExternalArtifact,
  ExternalBranch,
  ExternalJob,
  ExternalRepository,
  ExternalWorkflow,
  ExternalWorkflowRun,
  ExternalProject,
  ExternalRef,
  HealthCheck,
  CasePayload,
  ExternalCase,
  ExternalResult,
  ExternalRun,
  ExternalSuite,
  ImportedCase,
  ResultPayload,
  RunPayload,
  SuitePayload,
  TestManagementCatalog,
  IntegrationProviderName,
  IssuePayload,
  IssueState,
  IssueSummary,
  IssueTrackerAdapter,
  IssueTrackerCatalog,
  TestManagementAdapter,
} from './adapter.contracts';

/**
 * Noop implementations.
 *
 * They report `reachable: false` and refuse to act instead of returning
 * plausible fake data. A stub that answers "issue JIRA-123 created" teaches the
 * calling code that the integration works, and the failure surfaces in
 * production. A stub that says "not configured" makes the missing piece visible
 * on the first call.
 */

const NOT_CONFIGURED = 'Integration not configured: this build ships no real provider';

function unconfigured(provider: string): HealthCheck {
  return { reachable: false, message: `${provider}: ${NOT_CONFIGURED}`, checkedAt: new Date() };
}

/** Kept as a re-export: the error moved to the domain when it gained an HTTP status. */
export { IntegrationNotConfiguredError };

function notConfigured(provider: string, operation: string): IntegrationNotConfiguredError {
  return new IntegrationNotConfiguredError(
    provider,
    `cannot ${operation}, no adapter is configured`,
  );
}

@Injectable()
export class NoopIssueTrackerAdapter implements IssueTrackerAdapter {
  readonly provider: IntegrationProviderName = 'custom';
  private readonly logger = new Logger(NoopIssueTrackerAdapter.name);

  check(_context: AdapterContext): Promise<HealthCheck> {
    return Promise.resolve(unconfigured('issue tracker'));
  }

  createIssue(_context: AdapterContext, payload: IssuePayload): Promise<ExternalRef> {
    this.logger.debug(`Would push issue "${payload.title}" to an issue tracker`);
    return Promise.reject(notConfigured('issue tracker', 'create an issue'));
  }

  updateIssue(
    _context: AdapterContext,
    _externalId: string,
    _payload: IssuePayload,
  ): Promise<ExternalRef> {
    return Promise.reject(notConfigured('issue tracker', 'update an issue'));
  }

  fetchIssueState(_context: AdapterContext, _externalId: string): Promise<IssueState | null> {
    return Promise.resolve(null);
  }

  getIssue(_context: AdapterContext, _externalId: string): Promise<IssueSummary | null> {
    return Promise.resolve(null);
  }

  listProjects(_context: AdapterContext): Promise<ExternalProject[]> {
    return Promise.resolve([]);
  }

  listIssues(_context: AdapterContext): Promise<IssueSummary[]> {
    return Promise.resolve([]);
  }

  describe(_context: AdapterContext): Promise<IssueTrackerCatalog> {
    return Promise.resolve({ priorities: [], statuses: [], assignees: [] });
  }
}

@Injectable()
export class NoopTestManagementAdapter implements TestManagementAdapter {
  readonly provider: IntegrationProviderName = 'custom';

  check(_context: AdapterContext): Promise<HealthCheck> {
    return Promise.resolve(unconfigured('test management'));
  }

  describe(_context: AdapterContext): Promise<TestManagementCatalog> {
    return Promise.resolve({ statuses: [], priorities: [], caseTypes: [] });
  }

  listProjects(_context: AdapterContext): Promise<ExternalProject[]> {
    return Promise.resolve([]);
  }

  listSuites(_context: AdapterContext, _projectKey?: string): Promise<ExternalSuite[]> {
    return Promise.resolve([]);
  }

  listCases(_context: AdapterContext, _suiteExternalId: string): Promise<ExternalCase[]> {
    return Promise.resolve([]);
  }

  listRuns(_context: AdapterContext, _projectKey?: string): Promise<ExternalRun[]> {
    return Promise.resolve([]);
  }

  importCases(_context: AdapterContext, _externalSuiteId: string): Promise<ImportedCase[]> {
    return Promise.resolve([]);
  }

  createSuite(_context: AdapterContext, _payload: SuitePayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'create a suite'));
  }

  updateSuite(_context: AdapterContext, _id: string, _payload: SuitePayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'update a suite'));
  }

  fetchSuite(_context: AdapterContext, _id: string): Promise<ExternalSuite | null> {
    return Promise.resolve(null);
  }

  createCase(_context: AdapterContext, _payload: CasePayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'create a case'));
  }

  updateCase(_context: AdapterContext, _id: string, _payload: CasePayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'update a case'));
  }

  fetchCase(_context: AdapterContext, _id: string): Promise<ExternalCase | null> {
    return Promise.resolve(null);
  }

  createRun(_context: AdapterContext, _payload: RunPayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'export a run'));
  }

  updateRun(_context: AdapterContext, _id: string, _payload: RunPayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'update a run'));
  }

  fetchRun(_context: AdapterContext, _id: string): Promise<ExternalRun | null> {
    return Promise.resolve(null);
  }

  addResult(_context: AdapterContext, _payload: ResultPayload): Promise<ExternalRef> {
    return Promise.reject(notConfigured('test management', 'add a result'));
  }

  fetchResult(_context: AdapterContext, _id: string): Promise<ExternalResult | null> {
    return Promise.resolve(null);
  }
}

@Injectable()
export class NoopAutomationProviderAdapter implements AutomationProviderAdapter {
  readonly provider: IntegrationProviderName = 'custom';

  check(_context: AdapterContext): Promise<HealthCheck> {
    return Promise.resolve(unconfigured('automation provider'));
  }

  listRepositories(_context: AdapterContext): Promise<ExternalRepository[]> {
    return Promise.resolve([]);
  }

  listBranches(_context: AdapterContext, _repositoryId: string): Promise<ExternalBranch[]> {
    return Promise.resolve([]);
  }

  listWorkflows(_context: AdapterContext, _repositoryId: string): Promise<ExternalWorkflow[]> {
    return Promise.resolve([]);
  }

  listWorkflowRuns(
    _context: AdapterContext,
    _repositoryId: string,
    _workflowId?: string,
  ): Promise<ExternalWorkflowRun[]> {
    return Promise.resolve([]);
  }

  fetchWorkflowRun(
    _context: AdapterContext,
    _repositoryId: string,
    _runId: string,
  ): Promise<ExternalWorkflowRun | null> {
    return Promise.resolve(null);
  }

  listJobs(_context: AdapterContext, _repositoryId: string, _runId: string): Promise<ExternalJob[]> {
    return Promise.resolve([]);
  }

  listArtifacts(
    _context: AdapterContext,
    _repositoryId: string,
    _runId: string,
  ): Promise<ExternalArtifact[]> {
    return Promise.resolve([]);
  }

  fetchResults(
    _context: AdapterContext,
    _repositoryId: string,
    _runId: string,
  ): Promise<AutomatedResult[]> {
    return Promise.resolve([]);
  }
}

/**
 * Logs the subject and recipient, never the body: an invitation body carries a
 * usable token, and a log line is the easiest place to leak one.
 */
@Injectable()
export class NoopEmailAdapter implements EmailAdapter {
  readonly provider = 'noop';
  private readonly logger = new Logger(NoopEmailAdapter.name);

  send(message: { to: string; subject: string; text: string; html?: string }): Promise<{
    accepted: boolean;
    messageId: string | null;
  }> {
    this.logger.log(`Email suppressed (no provider): "${message.subject}" to ${message.to}`);
    return Promise.resolve({ accepted: false, messageId: null });
  }
}
