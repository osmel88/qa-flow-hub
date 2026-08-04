import { describe, expect, it } from 'vitest';
import { AdapterContext } from './adapter.contracts';
import {
  IntegrationNotConfiguredError,
  NoopAutomationProviderAdapter,
  NoopEmailAdapter,
  NoopIssueTrackerAdapter,
  NoopTestManagementAdapter,
} from './noop.providers';

const context: AdapterContext = {
  organizationId: 'org_1',
  connectionId: 'conn_1',
  secretRef: null,
  settings: {},
};

describe('noop integration providers', () => {
  it('report themselves as unreachable instead of pretending to work', async () => {
    const checks = await Promise.all([
      new NoopIssueTrackerAdapter().check(context),
      new NoopTestManagementAdapter().check(context),
      new NoopAutomationProviderAdapter().check(context),
    ]);

    expect(checks.every((check) => check.reachable)).toBe(false);
    expect(checks.every((check) => check.message.includes('not configured'))).toBe(true);
  });

  it('refuse to write instead of returning a fabricated external id', async () => {
    await expect(
      new NoopIssueTrackerAdapter().createIssue(context, {
        title: 'Card payment fails',
        description: null,
        severity: 'critical',
        priority: 'high',
        originKey: 'WEB-C-1',
      }),
    ).rejects.toBeInstanceOf(IntegrationNotConfiguredError);

    await expect(new NoopTestManagementAdapter().exportRun(context, 'run_1')).rejects.toBeInstanceOf(
      IntegrationNotConfiguredError,
    );
  });

  it('return nothing on reads, which callers must already handle', async () => {
    expect(await new NoopIssueTrackerAdapter().fetchIssueState(context, 'ABC-1')).toBeNull();
    expect(await new NoopTestManagementAdapter().importCases(context, 'suite_1')).toEqual([]);
    expect(await new NoopAutomationProviderAdapter().fetchResults(context, 'ci_1')).toEqual([]);
  });

  it('does not accept an email as sent', async () => {
    const outcome = await new NoopEmailAdapter().send({
      to: 'invitee@example.com',
      subject: 'You have been invited',
      text: 'token',
    });

    expect(outcome).toEqual({ accepted: false, messageId: null });
  });
});
