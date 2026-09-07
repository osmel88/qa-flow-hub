import { beforeEach, describe, expect, it } from 'vitest';
import { IntegrationProviderError } from '../../errors/domain-error';
import { AdapterContext, IssuePayload } from '../adapter.contracts';
import { JiraMockIssueTrackerAdapter } from './jira-mock.adapter';
import { JiraMockStore } from './jira-mock.store';

const context = (
  organizationId: string,
  settings: Record<string, string> = {},
): AdapterContext => ({
  organizationId,
  connectionId: `conn_${organizationId}`,
  baseUrl: 'https://acme.atlassian.net',
  secretRef: null,
  settings,
});

const story: IssuePayload = {
  kind: 'story',
  title: 'The user can log in',
  description: 'Given a registered user...',
  severity: null,
  priority: 'high',
  state: 'approved',
  originKey: 'WEB-R-1',
  labels: ['auth'],
};

const bug: IssuePayload = {
  kind: 'bug',
  title: 'Card payment fails',
  description: null,
  severity: 'critical',
  priority: 'critical',
  state: 'open',
  originKey: 'WEB-D-1',
  labels: [],
};

/**
 * The mock is only useful if it is boring: same seed, same ids, same answers,
 * for every organization, every time. These tests pin that down, plus the two
 * ways it is allowed to misbehave on request.
 */
describe('JiraMockIssueTrackerAdapter', () => {
  let store: JiraMockStore;
  let adapter: JiraMockIssueTrackerAdapter;

  beforeEach(() => {
    store = new JiraMockStore();
    adapter = new JiraMockIssueTrackerAdapter(store);
  });

  it('seeds every organization with the same deterministic catalog', async () => {
    const [projects, catalog, issues] = await Promise.all([
      adapter.listProjects(context('org_a')),
      adapter.describe(context('org_a')),
      adapter.listIssues(context('org_a'), {}),
    ]);

    expect(projects.map((project) => project.key)).toEqual(['QA', 'WEB']);
    expect(catalog.priorities).toEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest']);
    expect(catalog.statuses).toEqual(['To Do', 'In Progress', 'In Review', 'Done']);
    expect(catalog.assignees.map((user) => user.displayName)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Margaret Hamilton',
    ]);
    expect(issues.map((issue) => issue.key)).toEqual(['QA-1', 'QA-2', 'WEB-1']);
    expect(issues[1]).toMatchObject({ kind: 'bug', priority: 'Highest', status: 'To Do' });
  });

  it('creates issues with sequential ids and per-project keys', async () => {
    const first = await adapter.createIssue(context('org_a'), story);
    const second = await adapter.createIssue(context('org_a', { projectKey: 'WEB' }), bug);

    expect(first).toMatchObject({
      provider: 'jira',
      externalId: '10103',
      externalKey: 'QA-3',
      externalUrl: 'https://acme.atlassian.net/browse/QA-3',
      metadata: { projectKey: 'QA', issueType: 'Story', status: 'To Do', priority: 'High' },
    });
    expect(second).toMatchObject({
      externalId: '10104',
      externalKey: 'WEB-2',
      metadata: { issueType: 'Bug', priority: 'Highest' },
    });
  });

  it('keeps organizations apart: the same ids mean different issues', async () => {
    await adapter.createIssue(context('org_a'), story);
    await adapter.createIssue(context('org_b'), bug);

    const [a, b] = await Promise.all([
      adapter.getIssue(context('org_a'), '10103'),
      adapter.getIssue(context('org_b'), '10103'),
    ]);

    expect(a?.title).toBe(story.title);
    expect(b?.title).toBe(bug.title);
    expect(await adapter.getIssue(context('org_b'), '10104')).toBeNull();
  });

  it('updates in place and maps internal state to a Jira status', async () => {
    const created = await adapter.createIssue(context('org_a'), story);

    const updated = await adapter.updateIssue(context('org_a'), created.externalId, {
      ...story,
      title: 'The user can log in with SSO',
      state: 'implemented',
      priority: 'low',
    });

    expect(updated.externalId).toBe(created.externalId);
    expect(updated.externalKey).toBe(created.externalKey);
    expect(await adapter.fetchIssueState(context('org_a'), created.externalId)).toMatchObject({
      status: 'Done',
    });
    const issue = await adapter.getIssue(context('org_a'), created.externalId);
    expect(issue).toMatchObject({ title: 'The user can log in with SSO', priority: 'Low' });
    expect(await adapter.listIssues(context('org_a'), {})).toHaveLength(4);
  });

  it('refuses to update an issue it does not know', async () => {
    await expect(adapter.updateIssue(context('org_a'), '99999', story)).rejects.toBeInstanceOf(
      IntegrationProviderError,
    );
  });

  it('reports an unknown project instead of inventing one', async () => {
    const check = await adapter.check(context('org_a', { projectKey: 'NOPE' }));

    expect(check.reachable).toBe(false);
    expect(check.message).toContain('NOPE');
    await expect(
      adapter.createIssue(context('org_a', { projectKey: 'NOPE' }), story),
    ).rejects.toBeInstanceOf(IntegrationProviderError);
  });

  it('simulates an outage when asked to', async () => {
    const down = context('org_a', { simulateFailure: 'unreachable' });

    expect((await adapter.check(down)).reachable).toBe(false);
    await expect(adapter.listProjects(down)).rejects.toBeInstanceOf(IntegrationProviderError);
    await expect(adapter.createIssue(down, story)).rejects.toBeInstanceOf(IntegrationProviderError);
  });

  it('simulates a provider that reads fine but refuses writes', async () => {
    const readOnly = context('org_a', { simulateFailure: 'write_failure' });

    expect((await adapter.check(readOnly)).reachable).toBe(true);
    expect(await adapter.listIssues(readOnly, { kind: 'bug' })).toHaveLength(1);
    await expect(adapter.createIssue(readOnly, story)).rejects.toBeInstanceOf(
      IntegrationProviderError,
    );
    await expect(adapter.updateIssue(readOnly, '10101', story)).rejects.toBeInstanceOf(
      IntegrationProviderError,
    );
  });

  it('forgets everything on reset, which is what a restart does', async () => {
    await adapter.createIssue(context('org_a'), story);
    store.reset('org_a');

    expect(await adapter.getIssue(context('org_a'), '10103')).toBeNull();
    expect((await adapter.createIssue(context('org_a'), story)).externalId).toBe('10103');
  });
});
