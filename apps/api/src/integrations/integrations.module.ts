import { Module } from '@nestjs/common';
import {
  AUTOMATION_PROVIDER_ADAPTER,
  EMAIL_ADAPTER,
  ISSUE_TRACKER_ADAPTER,
  TEST_MANAGEMENT_ADAPTER,
} from './adapter.tokens';
import {
  NoopAutomationProviderAdapter,
  NoopEmailAdapter,
  NoopIssueTrackerAdapter,
  NoopTestManagementAdapter,
} from './noop.providers';

/**
 * Adapters are injected by token, not by class, so adding Jira later is a
 * provider swap in this module and nothing else changes.
 */
@Module({
  providers: [
    { provide: ISSUE_TRACKER_ADAPTER, useClass: NoopIssueTrackerAdapter },
    { provide: TEST_MANAGEMENT_ADAPTER, useClass: NoopTestManagementAdapter },
    { provide: AUTOMATION_PROVIDER_ADAPTER, useClass: NoopAutomationProviderAdapter },
    { provide: EMAIL_ADAPTER, useClass: NoopEmailAdapter },
  ],
  exports: [
    ISSUE_TRACKER_ADAPTER,
    TEST_MANAGEMENT_ADAPTER,
    AUTOMATION_PROVIDER_ADAPTER,
    EMAIL_ADAPTER,
  ],
})
export class IntegrationsModule {}
