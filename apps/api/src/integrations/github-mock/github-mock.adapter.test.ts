import { beforeEach, describe, expect, it } from 'vitest';
import { IntegrationProviderError } from '../../errors/domain-error';
import { AdapterContext } from '../adapter.contracts';
import { GitHubMockAutomationProviderAdapter, caseTagsOf } from './github-mock.adapter';
import { GitHubMockStore } from './github-mock.store';

const context = (
  organizationId: string,
  settings: Record<string, string> = {},
  baseUrl: string | null = null,
): AdapterContext => ({
  organizationId,
  connectionId: `conn_${organizationId}`,
  baseUrl,
  secretRef: null,
  settings,
});

/**
 * A read-only mock has one job: answer the same thing every time, for every
 * tenant, and fail only when told to. These tests pin the seed down by value
 * because the integration tests and the E2E rely on these exact ids.
 */
describe('GitHubMockAutomationProviderAdapter', () => {
  let store: GitHubMockStore;
  let adapter: GitHubMockAutomationProviderAdapter;

  beforeEach(() => {
    store = new GitHubMockStore();
    adapter = new GitHubMockAutomationProviderAdapter(store);
  });

  it('seeds every organization with the same repositories, workflows and runs', async () => {
    const repositories = await adapter.listRepositories(context('org_a'));
    expect(repositories.map((repository) => [repository.externalId, repository.fullName])).toEqual([
      ['1', 'acme/web-checkout'],
      ['2', 'acme/api-gateway'],
    ]);
    expect(repositories[0]?.url).toBe('https://github.example.com/acme/web-checkout');

    const branches = await adapter.listBranches(context('org_a'), '1');
    expect(branches.map((branch) => branch.name)).toEqual(['main', 'feature/checkout-retry']);
    expect(branches[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);

    const workflows = await adapter.listWorkflows(context('org_a'), '1');
    expect(workflows.map((workflow) => [workflow.externalId, workflow.name])).toEqual([
      ['1', 'Playwright E2E'],
      ['2', 'CI'],
    ]);

    const runs = await adapter.listWorkflowRuns(context('org_a'), '1', '1');
    expect(runs.map((run) => [run.externalId, run.runNumber, run.status, run.conclusion])).toEqual([
      ['1003', 43, 'in_progress', null],
      ['1002', 42, 'completed', 'failure'],
      ['1001', 41, 'completed', 'success'],
    ]);
    expect(runs[2]?.url).toBe('https://github.example.com/acme/web-checkout/actions/runs/1001');
    expect(runs[2]?.workflowName).toBe('Playwright E2E');

    expect(await adapter.listWorkflowRuns(context('org_b'), '1', '1')).toEqual(runs);
  });

  it('accepts the repository by id or by owner/name', async () => {
    const byId = await adapter.listWorkflows(context('org_a'), '2');
    const byName = await adapter.listWorkflows(context('org_a'), 'ACME/api-gateway');
    expect(byName).toEqual(byId);
    expect(byId.map((workflow) => workflow.externalId)).toEqual(['3']);
  });

  it('exposes jobs with steps and artifacts with their kind', async () => {
    const jobs = await adapter.listJobs(context('org_a'), '1', '1002');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'e2e (chromium)', conclusion: 'failure' });
    expect(jobs[0]?.steps.map((step) => step.conclusion)).toEqual([
      'success',
      'success',
      'failure',
      'success',
    ]);

    const artifacts = await adapter.listArtifacts(context('org_a'), '1', '1001');
    expect(artifacts.map((artifact) => [artifact.name, artifact.kind])).toEqual([
      ['playwright-report', 'playwright_report'],
      ['test-results', 'other'],
    ]);

    const expired = await adapter.listArtifacts(context('org_a'), '1', '1004');
    expect(expired[0]).toMatchObject({ kind: 'junit', expired: true, url: null });
  });

  it('turns Playwright tests into automated results with case tags', async () => {
    const results = await adapter.fetchResults(context('org_a'), '1', '1002');
    expect(results.map((result) => [result.externalId, result.caseTags, result.status])).toEqual([
      ['1002-1', ['C-1'], 'passed'],
      ['1002-2', ['C-2'], 'failed'],
      ['1002-3', ['C-3'], 'passed'],
      ['1002-4', [], 'failed'],
    ]);
    expect(results[1]).toMatchObject({
      framework: 'playwright',
      file: 'e2e/checkout.spec.ts',
      project: 'chromium',
      durationMs: 5230,
      testIdentifier: 'e2e/checkout.spec.ts › checkout › rejects an expired card @C-2',
    });
    expect(results[1]?.message).toContain('Card expired');

    expect(await adapter.fetchResults(context('org_a'), '1', '1003')).toEqual([]);
  });

  it('parses case tags case-insensitively and without duplicates', () => {
    expect(caseTagsOf('checkout › pays @c-1 and @C-1 then @C-12')).toEqual(['C-1', 'C-12']);
    expect(caseTagsOf('no tags here, C-1 without at-sign')).toEqual([]);
  });

  it('reports reachability against the configured repository', async () => {
    const ok = await adapter.check(context('org_a'));
    expect(ok.reachable).toBe(true);
    expect(ok.message).toContain('acme/web-checkout has 2 workflows');

    const missing = await adapter.check(context('org_a', { repository: 'acme/unknown' }));
    expect(missing.reachable).toBe(false);
    expect(missing.message).toContain('acme/unknown is not accessible');
    expect(missing.message).toContain('acme/api-gateway');

    const down = await adapter.check(context('org_a', { simulateFailure: 'unreachable' }));
    expect(down.reachable).toBe(false);
    expect(down.message).toContain('simulated outage');
  });

  it('fails every call when unreachable and only the report download on fetch_failure', async () => {
    const down = context('org_a', { simulateFailure: 'unreachable' });
    await expect(adapter.listRepositories(down)).rejects.toBeInstanceOf(IntegrationProviderError);
    await expect(adapter.fetchWorkflowRun(down, '1', '1001')).rejects.toBeInstanceOf(
      IntegrationProviderError,
    );

    const flaky = context('org_a', { simulateFailure: 'fetch_failure' });
    expect(await adapter.fetchWorkflowRun(flaky, '1', '1001')).not.toBeNull();
    await expect(adapter.fetchResults(flaky, '1', '1001')).rejects.toThrow(
      /downloading the report/,
    );
  });

  it('rejects unknown repositories and runs as provider errors, not as empty lists', async () => {
    await expect(adapter.listWorkflows(context('org_a'), '99')).rejects.toThrow(/not accessible/);
    await expect(adapter.listJobs(context('org_a'), '1', '4242')).rejects.toThrow(
      /does not exist in acme\/web-checkout/,
    );
    // A run that exists in another repository is not reachable through this one.
    expect(await adapter.fetchWorkflowRun(context('org_a'), '2', '1001')).toBeNull();
  });

  it('builds URLs on the connection base URL when one is set', async () => {
    const run = await adapter.fetchWorkflowRun(
      context('org_a', {}, 'https://ghe.acme.test/'),
      '1',
      '1001',
    );
    expect(run?.url).toBe('https://ghe.acme.test/acme/web-checkout/actions/runs/1001');
  });

  it('keeps organizations apart and re-seeds one on reset', async () => {
    store.forgetWorkflowRun('org_a', '1001');
    expect(await adapter.fetchWorkflowRun(context('org_a'), '1', '1001')).toBeNull();
    expect(await adapter.fetchResults(context('org_a'), '1', '1002')).toHaveLength(4);
    expect(await adapter.fetchWorkflowRun(context('org_b'), '1', '1001')).not.toBeNull();

    store.reset('org_a');
    expect(await adapter.fetchWorkflowRun(context('org_a'), '1', '1001')).not.toBeNull();
  });
});
