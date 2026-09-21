import { Module } from '@nestjs/common';
import {
  AUTOMATION_PROVIDER_ADAPTER,
  EMAIL_ADAPTER,
  ISSUE_TRACKER_ADAPTER,
  TEST_MANAGEMENT_ADAPTER,
} from './adapter.tokens';
import { GitHubMockAutomationProviderAdapter } from './github-mock/github-mock.adapter';
import { GitHubMockStore } from './github-mock/github-mock.store';
import { JiraMockIssueTrackerAdapter } from './jira-mock/jira-mock.adapter';
import { JiraMockStore } from './jira-mock/jira-mock.store';
import { MockEmailAdapter } from './email-mock/email-mock.adapter';
import { TestRailMockTestManagementAdapter } from './testrail-mock/testrail-mock.adapter';
import { TestRailMockStore } from './testrail-mock/testrail-mock.store';

/**
 * Adapters are injected by token, not by class, so adding a provider is a swap
 * in this module and nothing else changes — which is exactly what S2-F2 did:
 * the issue tracker token now resolves to the Jira mock instead of the noop.
 *
 * The mock stores are exported for tests only: they are
 * the one way to reset a simulated provider between cases, and production code
 * has no reason to reach them.
 */
@Module({
  providers: [
    JiraMockStore,
    TestRailMockStore,
    GitHubMockStore,
    { provide: ISSUE_TRACKER_ADAPTER, useClass: JiraMockIssueTrackerAdapter },
    { provide: TEST_MANAGEMENT_ADAPTER, useClass: TestRailMockTestManagementAdapter },
    { provide: AUTOMATION_PROVIDER_ADAPTER, useClass: GitHubMockAutomationProviderAdapter },
    MockEmailAdapter,
    { provide: EMAIL_ADAPTER, useExisting: MockEmailAdapter },
  ],
  exports: [
    JiraMockStore,
    TestRailMockStore,
    GitHubMockStore,
    MockEmailAdapter,
    ISSUE_TRACKER_ADAPTER,
    TEST_MANAGEMENT_ADAPTER,
    AUTOMATION_PROVIDER_ADAPTER,
    EMAIL_ADAPTER,
  ],
})
export class IntegrationsModule {}
