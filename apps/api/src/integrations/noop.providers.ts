import { Injectable, Logger } from '@nestjs/common';
import {
  AdapterContext,
  AutomatedResult,
  AutomationProviderAdapter,
  EmailAdapter,
  ExternalRef,
  HealthCheck,
  ImportedCase,
  IntegrationProviderName,
  IssuePayload,
  IssueState,
  IssueTrackerAdapter,
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

export class IntegrationNotConfiguredError extends Error {
  constructor(provider: string, operation: string) {
    super(`Cannot ${operation}: no ${provider} adapter is configured`);
    this.name = 'IntegrationNotConfiguredError';
  }
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
    return Promise.reject(new IntegrationNotConfiguredError('issue tracker', 'create an issue'));
  }

  fetchIssueState(_context: AdapterContext, _externalId: string): Promise<IssueState | null> {
    return Promise.resolve(null);
  }
}

@Injectable()
export class NoopTestManagementAdapter implements TestManagementAdapter {
  readonly provider: IntegrationProviderName = 'custom';

  check(_context: AdapterContext): Promise<HealthCheck> {
    return Promise.resolve(unconfigured('test management'));
  }

  importCases(_context: AdapterContext, _externalSuiteId: string): Promise<ImportedCase[]> {
    return Promise.resolve([]);
  }

  exportRun(_context: AdapterContext, _testRunId: string): Promise<ExternalRef> {
    return Promise.reject(new IntegrationNotConfiguredError('test management', 'export a run'));
  }
}

@Injectable()
export class NoopAutomationProviderAdapter implements AutomationProviderAdapter {
  readonly provider: IntegrationProviderName = 'custom';

  check(_context: AdapterContext): Promise<HealthCheck> {
    return Promise.resolve(unconfigured('automation provider'));
  }

  fetchResults(_context: AdapterContext, _externalRunId: string): Promise<AutomatedResult[]> {
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
