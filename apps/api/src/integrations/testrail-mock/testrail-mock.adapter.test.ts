import { beforeEach, describe, expect, it } from 'vitest';
import { IntegrationProviderError } from '../../errors/domain-error';
import { AdapterContext, CasePayload, RunPayload } from '../adapter.contracts';
import { TestRailMockTestManagementAdapter } from './testrail-mock.adapter';
import { TestRailMockStore } from './testrail-mock.store';

const context = (
  organizationId: string,
  settings: Record<string, string> = {},
): AdapterContext => ({
  organizationId,
  connectionId: `conn_${organizationId}`,
  baseUrl: 'https://acme.testrail.io',
  secretRef: null,
  settings,
});

const suitePayload = { projectKey: null, name: 'Checkout', description: 'Payments' };

const casePayload = (suiteExternalId: string, sectionName: string | null = null): CasePayload => ({
  suiteExternalId,
  sectionName,
  title: 'Pay with a valid card',
  type: 'regression',
  priority: 'high',
  preconditions: 'A registered user',
  expectedResult: 'Payment confirmed',
  steps: [{ action: 'Enter the card number', expectedResult: 'Number accepted' }],
  originKey: 'WEB-C-1',
  labels: ['visa'],
});

const runPayload = (suiteExternalId: string, caseExternalIds: string[]): RunPayload => ({
  suiteExternalId,
  name: 'Release 1.0 regression',
  description: null,
  caseExternalIds,
  state: 'planned',
});

/**
 * The mock is only useful if it is boring: same seed, same ids, same answers,
 * for every organization, every time. These tests pin that down, plus the two
 * ways it is allowed to misbehave on request.
 */
describe('TestRailMockTestManagementAdapter', () => {
  let store: TestRailMockStore;
  let adapter: TestRailMockTestManagementAdapter;

  beforeEach(() => {
    store = new TestRailMockStore();
    adapter = new TestRailMockTestManagementAdapter(store);
  });

  it('seeds every organization with the same deterministic catalog', async () => {
    const [projects, catalog, suites, cases, runs] = await Promise.all([
      adapter.listProjects(context('org_a')),
      adapter.describe(context('org_a')),
      adapter.listSuites(context('org_a')),
      adapter.listCases(context('org_a'), '1'),
      adapter.listRuns(context('org_a')),
    ]);

    expect(projects.map((project) => project.key)).toEqual(['1', '2']);
    expect(catalog.statuses).toEqual([
      'Passed',
      'Blocked',
      'Untested',
      'Retest',
      'Failed',
      'Skipped',
    ]);
    expect(catalog.priorities).toEqual(['Low', 'Medium', 'High', 'Critical']);
    expect(catalog.caseTypes).toContain('Regression');
    expect(suites).toEqual([expect.objectContaining({ externalId: '1', caseCount: 2 })]);
    expect(cases.map((testCase) => testCase.key)).toEqual(['C1', 'C2']);
    expect(runs).toEqual([expect.objectContaining({ externalId: '1', caseCount: 2 })]);

    expect(await adapter.listSuites(context('org_b'))).toEqual(suites);
  });

  it('reports reachable with the configured project, unreachable on request', async () => {
    const healthy = await adapter.check(context('org_a'));
    expect(healthy.reachable).toBe(true);
    expect(healthy.message).toContain('Quality Assurance');

    const other = await adapter.check(context('org_a', { projectId: '2' }));
    expect(other.message).toContain('Web Platform');

    const missing = await adapter.check(context('org_a', { projectId: '9' }));
    expect(missing.reachable).toBe(false);
    expect(missing.message).toContain('Known projects');

    const down = await adapter.check(context('org_a', { simulateFailure: 'unreachable' }));
    expect(down.reachable).toBe(false);
    expect(down.message).toContain('simulated outage');
  });

  it('creates suites, cases and runs with sequential ids after the seed', async () => {
    const suite = await adapter.createSuite(context('org_a'), suitePayload);
    expect(suite).toMatchObject({
      provider: 'testrail',
      externalId: '2',
      externalKey: 'S2',
      externalUrl: 'https://acme.testrail.io/index.php?/suites/view/2',
      metadata: { projectId: '1', name: 'Checkout' },
    });

    const testCase = await adapter.createCase(context('org_a'), casePayload('2', 'Payments'));
    expect(testCase).toMatchObject({
      externalId: '3',
      externalKey: 'C3',
      metadata: { suiteId: '2', sectionName: 'Payments', type: 'Regression', priority: 'High' },
    });
    expect(store.findCase('org_a', '3')).toMatchObject({
      refs: 'WEB-C-1,visa',
      steps: [{ content: 'Enter the card number', expected: 'Number accepted' }],
    });

    const run = await adapter.createRun(context('org_a'), runPayload('2', ['3']));
    expect(run).toMatchObject({
      externalId: '2',
      externalKey: 'R2',
      metadata: { status: 'Active' },
    });
    expect(store.listTests('org_a', '2').map((test) => test.caseId)).toEqual(['3']);
  });

  it('updates in place and returns null for ids it does not know', async () => {
    const suite = await adapter.createSuite(context('org_a'), suitePayload);
    const updated = await adapter.updateSuite(context('org_a'), suite.externalId, {
      ...suitePayload,
      name: 'Checkout v2',
    });
    expect(updated.externalId).toBe('2');
    expect((await adapter.fetchSuite(context('org_a'), '2'))?.name).toBe('Checkout v2');

    expect(await adapter.fetchSuite(context('org_a'), '999')).toBeNull();
    expect(await adapter.fetchCase(context('org_a'), '999')).toBeNull();
    expect(await adapter.fetchRun(context('org_a'), '999')).toBeNull();
    expect(await adapter.fetchResult(context('org_a'), '999')).toBeNull();
    await expect(adapter.updateSuite(context('org_a'), '999', suitePayload)).rejects.toBeInstanceOf(
      IntegrationProviderError,
    );
  });

  it('reuses a section by name within a suite instead of duplicating it', async () => {
    const suite = await adapter.createSuite(context('org_a'), suitePayload);
    const first = await adapter.createCase(
      context('org_a'),
      casePayload(suite.externalId, 'Payments'),
    );
    const second = await adapter.createCase(context('org_a'), {
      ...casePayload(suite.externalId, 'Payments'),
      title: 'Pay with an expired card',
    });

    expect(first.metadata?.['sectionId']).toBe(second.metadata?.['sectionId']);
    expect(store.listSections('org_a', suite.externalId).map((section) => section.name)).toEqual([
      'All Test Cases',
      'Payments',
    ]);
  });

  it('appends results to the test of a run and maps statuses', async () => {
    const suite = await adapter.createSuite(context('org_a'), suitePayload);
    const testCase = await adapter.createCase(context('org_a'), casePayload(suite.externalId));
    const run = await adapter.createRun(
      context('org_a'),
      runPayload(suite.externalId, [testCase.externalId]),
    );

    const result = await adapter.addResult(context('org_a'), {
      runExternalId: run.externalId,
      caseExternalId: testCase.externalId,
      status: 'skipped',
      comment: 'Out of scope',
      elapsedSeconds: 12,
    });

    expect(result).toMatchObject({
      externalId: '2',
      externalUrl: 'https://acme.testrail.io/index.php?/tests/view/3',
      metadata: { runId: '2', caseId: '3', status: 'Skipped' },
    });
    expect(await adapter.fetchResult(context('org_a'), '2')).toMatchObject({
      runExternalId: '2',
      caseExternalId: '3',
      status: 'Skipped',
      elapsedSeconds: 12,
    });

    await expect(
      adapter.addResult(context('org_a'), {
        runExternalId: run.externalId,
        caseExternalId: '1',
        status: 'passed',
        comment: null,
        elapsedSeconds: null,
      }),
    ).rejects.toThrow(/not part of run/);
  });

  it('keeps organizations apart', async () => {
    await adapter.createSuite(context('org_a'), suitePayload);

    expect(await adapter.fetchSuite(context('org_b'), '2')).toBeNull();
    expect(await adapter.listSuites(context('org_b'))).toHaveLength(1);

    const theirs = await adapter.createSuite(context('org_b'), suitePayload);
    expect(theirs.externalId).toBe('2');
  });

  it('refuses writes but not reads under write_failure, everything under unreachable', async () => {
    const flaky = context('org_a', { simulateFailure: 'write_failure' });
    expect(await adapter.listSuites(flaky)).toHaveLength(1);
    await expect(adapter.createSuite(flaky, suitePayload)).rejects.toThrow(/refused the write/);

    const down = context('org_a', { simulateFailure: 'unreachable' });
    await expect(adapter.listSuites(down)).rejects.toBeInstanceOf(IntegrationProviderError);
    await expect(adapter.fetchSuite(down, '1')).rejects.toBeInstanceOf(IntegrationProviderError);
  });

  it('refuses a project the mock does not have', async () => {
    await expect(
      adapter.createSuite(context('org_a', { projectId: '42' }), suitePayload),
    ).rejects.toThrow(/42/);
  });

  it('starts over after a reset', async () => {
    await adapter.createSuite(context('org_a'), suitePayload);
    await adapter.createSuite(context('org_b'), suitePayload);

    store.reset('org_a');
    expect(await adapter.listSuites(context('org_a'))).toHaveLength(1);
    expect(await adapter.listSuites(context('org_b'))).toHaveLength(2);

    store.reset();
    expect(await adapter.listSuites(context('org_b'))).toHaveLength(1);
    expect((await adapter.createSuite(context('org_b'), suitePayload)).externalId).toBe('2');
  });
});
