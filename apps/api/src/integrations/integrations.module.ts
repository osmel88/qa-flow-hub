import { Module } from '@nestjs/common';
import {
  AUTOMATION_PROVIDER_ADAPTER,
  EMAIL_ADAPTER,
  ISSUE_TRACKER_ADAPTER,
  TEST_MANAGEMENT_ADAPTER,
} from './adapter.tokens';
import { JiraMockIssueTrackerAdapter } from './jira-mock/jira-mock.adapter';
import { JiraMockStore } from './jira-mock/jira-mock.store';
import {
  NoopAutomationProviderAdapter,
  NoopEmailAdapter,
  NoopTestManagementAdapter,
} from './noop.providers';

/**
 * Adapters are injected by token, not by class, so adding a provider is a swap
 * in this module and nothing else changes — which is exactly what S2-F2 did:
 * the issue tracker token now resolves to the Jira mock instead of the noop.
 *
 * `JiraMockStore` is exported for tests only: it is the one way to reset the
 * simulated Jira between cases, and production code has no reason to reach it.
 */
@Module({
  providers: [
    JiraMockStore,
    { provide: ISSUE_TRACKER_ADAPTER, useClass: JiraMockIssueTrackerAdapter },
    { provide: TEST_MANAGEMENT_ADAPTER, useClass: NoopTestManagementAdapter },
    { provide: AUTOMATION_PROVIDER_ADAPTER, useClass: NoopAutomationProviderAdapter },
    { provide: EMAIL_ADAPTER, useClass: NoopEmailAdapter },
  ],
  exports: [
    JiraMockStore,
    ISSUE_TRACKER_ADAPTER,
    TEST_MANAGEMENT_ADAPTER,
    AUTOMATION_PROVIDER_ADAPTER,
    EMAIL_ADAPTER,
  ],
})
export class IntegrationsModule {}
