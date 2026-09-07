import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { TestRailMockStore } from '../src/integrations';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * TestSuite → suite, TestCase → case, TestRun → run, TestResult → result, over
 * HTTP and against the mock.
 *
 * What these tests protect: each entity ends up with exactly one reference
 * that is reused on re-sync, dependencies are synced on the way (a case brings
 * its suite, a run brings its suite and cases, a result brings its run), one
 * organization's suites are invisible to another, only those who may edit an
 * entity may sync it, and a provider failure is reported on the connection.
 */
describe('testrail synchronisation', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let store: TestRailMockStore;
  let workspace: TestWorkspace;
  let suiteId: string;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const as = (account: TestAccount, organizationId = workspace.organizationId) => ({
    token: account.accessToken,
    organizationId,
  });

  const connectTestRail = async (settings: Record<string, string> = {}) => {
    await request(
      'PUT',
      '/api/v1/integrations/testrail',
      asOwner({ mode: 'mock', baseUrl: 'https://acme.testrail.io', settings }),
    );
    return request('POST', '/api/v1/integrations/testrail/connect', asOwner());
  };

  const createSuite = async (name = 'Checkout') => {
    const response = await request(
      'POST',
      '/api/v1/test-suites',
      asOwner({ projectId: workspace.projectId, name }),
    );
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const createCase = async (payload: object = {}) => {
    const response = await request(
      'POST',
      '/api/v1/test-cases',
      asOwner({
        title: 'Pay with a valid card',
        priority: 'high',
        type: 'regression',
        steps: [{ action: 'Enter the card number', expectedResult: 'Number accepted' }],
        suiteId,
        ...payload,
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

  const createRun = async (testCaseIds: string[], payload: object = {}) => {
    const response = await request(
      'POST',
      '/api/v1/test-runs',
      asOwner({
        projectId: workspace.projectId,
        name: 'Release 1.0 regression',
        environment: 'staging',
        ...(testCaseIds.length === 0 ? {} : { selection: { testCaseIds } }),
        ...payload,
      }),
    );
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const firstRunCaseOf = async (runId: string): Promise<{ id: string; testCaseId: string }> => {
    const response = await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner());
    const [runCase] = response.json().data as Array<{ id: string; testCaseId: string }>;
    if (runCase === undefined) {
      throw new Error(`run ${runId} has no cases`);
    }
    return runCase;
  };

  const recordResult = async (runId: string, runCaseId: string, payload: object = {}) => {
    const response = await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
      asOwner({ status: 'failed', comment: 'Card declined', ...payload }),
    );
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const sync = (kind: string, id: string, options = asOwner()) =>
    request('POST', `/api/v1/integrations/testrail/sync/${kind}/${id}`, options);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    store = app.get(TestRailMockStore);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    store.reset();
    workspace = await createWorkspace(app);
    suiteId = (await createSuite()).id;
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('browsing the mock', () => {
    it('lists deterministic projects, catalog, suites, cases and runs once connected', async () => {
      await connectTestRail();

      const projects = await request('GET', '/api/v1/integrations/testrail/projects', asOwner());
      const catalog = await request('GET', '/api/v1/integrations/testrail/catalog', asOwner());
      const suites = await request('GET', '/api/v1/integrations/testrail/suites', asOwner());
      const cases = await request(
        'GET',
        '/api/v1/integrations/testrail/cases?suiteExternalId=1',
        asOwner(),
      );
      const runs = await request('GET', '/api/v1/integrations/testrail/runs', asOwner());

      expect(projects.json().map((project: { name: string }) => project.name)).toEqual([
        'Quality Assurance',
        'Web Platform',
      ]);
      expect(catalog.json().statuses).toContain('Passed');
      expect(suites.json()).toEqual([expect.objectContaining({ externalId: '1', caseCount: 2 })]);
      expect(cases.json().map((testCase: { key: string }) => testCase.key)).toEqual(['C1', 'C2']);
      expect(runs.json()).toEqual([expect.objectContaining({ externalId: '1', caseCount: 2 })]);
    });

    it('refuses to browse before TestRail is configured and connected', async () => {
      const unconfigured = await request(
        'GET',
        '/api/v1/integrations/testrail/projects',
        asOwner(),
      );
      expect(unconfigured.statusCode).toBe(409);
      expect(unconfigured.json().error.code).toBe('INTEGRATION_NOT_CONFIGURED');

      await request('PUT', '/api/v1/integrations/testrail', asOwner({ mode: 'mock' }));
      const disconnected = await request(
        'GET',
        '/api/v1/integrations/testrail/projects',
        asOwner(),
      );
      expect(disconnected.statusCode).toBe(409);
      expect(disconnected.json().error.message).toContain('disconnected');
    });

    it('lets Test connection see the outage the settings ask for, and recover', async () => {
      await connectTestRail({ simulateFailure: 'unreachable' });

      const tested = await request(
        'POST',
        '/api/v1/integrations/testrail/test-connection',
        asOwner(),
      );
      expect(tested.json()).toMatchObject({ reachable: false, connection: { status: 'error' } });

      await request(
        'PUT',
        '/api/v1/integrations/testrail',
        asOwner({ mode: 'mock', settings: {} }),
      );
      const recovered = await request(
        'POST',
        '/api/v1/integrations/testrail/test-connection',
        asOwner(),
      );
      expect(recovered.json()).toMatchObject({
        reachable: true,
        connection: { status: 'connected', lastError: null },
      });
    });
  });

  describe('suite → suite', () => {
    it('creates the suite on the first sync and updates it on the next', async () => {
      await connectTestRail();

      const first = await sync('test-suites', suiteId);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        entityType: 'test_suite',
        entityId: suiteId,
        action: 'created',
        reference: {
          provider: 'testrail',
          externalId: '2',
          externalKey: 'S2',
          externalUrl: 'https://acme.testrail.io/index.php?/suites/view/2',
          metadata: { projectId: '1', name: 'Checkout' },
        },
        dependencies: [],
      });

      await request('PATCH', `/api/v1/test-suites/${suiteId}`, asOwner({ name: 'Checkout v2' }));
      const second = await sync('test-suites', suiteId);
      expect(second.json()).toMatchObject({
        action: 'updated',
        reference: {
          id: first.json().reference.id,
          externalId: '2',
          metadata: { name: 'Checkout v2' },
        },
      });

      expect(store.findSuite(workspace.organizationId, '2')?.name).toBe('Checkout v2');
      expect(await prisma.externalReference.count()).toBe(1);
    });

    it('recreates the suite when the provider has forgotten it, and keeps the trail', async () => {
      await connectTestRail();
      const first = (await sync('test-suites', suiteId)).json();

      await prisma.externalReference.update({
        where: { id: first.reference.id },
        data: { externalId: '999', externalKey: 'S999' },
      });

      const second = (await sync('test-suites', suiteId)).json();
      expect(second.action).toBe('created');
      expect(second.reference).toMatchObject({
        id: first.reference.id,
        externalId: '3',
        externalKey: 'S3',
        metadata: { previousExternalId: '999' },
      });
      expect(await prisma.externalReference.count()).toBe(1);
    });

    it('uses the project the connection is configured for', async () => {
      await connectTestRail({ projectId: '2' });

      const synced = await sync('test-suites', suiteId);

      expect(synced.json().reference.metadata.projectId).toBe('2');
    });
  });

  describe('case → case', () => {
    it('creates the case with its steps, section and suite in one go', async () => {
      await connectTestRail();
      const section = (
        await request('POST', '/api/v1/test-sections', asOwner({ suiteId, name: 'Payments' }))
      ).json();
      const testCase = await createCase({ sectionId: section.id, tags: ['visa'] });

      const synced = await sync('test-cases', testCase.id);

      expect(synced.statusCode).toBe(200);
      expect(synced.json()).toMatchObject({
        entityType: 'test_case',
        action: 'created',
        reference: {
          externalId: '3',
          externalKey: 'C3',
          externalUrl: 'https://acme.testrail.io/index.php?/cases/view/3',
          metadata: { suiteId: '2', sectionName: 'Payments', type: 'Regression', priority: 'High' },
        },
        dependencies: [expect.objectContaining({ entityType: 'test_suite', externalKey: 'S2' })],
      });

      const stored = store.findCase(workspace.organizationId, '3');
      expect(stored).toMatchObject({
        title: 'Pay with a valid card',
        refs: `${testCase.key},visa`,
      });
      expect(stored?.steps).toEqual([
        { content: 'Enter the card number', expected: 'Number accepted' },
      ]);
      expect(await prisma.externalReference.count()).toBe(2);
    });

    it('updates the case in place and reuses the suite reference', async () => {
      await connectTestRail();
      const testCase = await createCase();
      const first = (await sync('test-cases', testCase.id)).json();

      await request(
        'PATCH',
        `/api/v1/test-cases/${testCase.id}`,
        asOwner({ title: 'Pay with a valid Visa', priority: 'critical' }),
      );
      const second = (await sync('test-cases', testCase.id)).json();

      expect(second).toMatchObject({
        action: 'updated',
        reference: { id: first.reference.id, externalId: '3', metadata: { priority: 'Critical' } },
      });
      expect(store.findCase(workspace.organizationId, '3')?.title).toBe('Pay with a valid Visa');
      expect(await prisma.externalReference.count()).toBe(2);
    });

    it('puts the references on the project list without a query per row', async () => {
      await connectTestRail();
      const synced = await createCase({ title: 'Synced' });
      await createCase({ title: 'Not synced' });
      await sync('test-cases', synced.id);

      const cases = await request(
        'GET',
        `/api/v1/integrations/testrail/references?projectId=${workspace.projectId}&entityType=test_case`,
        asOwner(),
      );
      const suites = await request(
        'GET',
        `/api/v1/integrations/testrail/references?projectId=${workspace.projectId}&entityType=test_suite`,
        asOwner(),
      );

      expect(cases.json()).toEqual([
        expect.objectContaining({ entityId: synced.id, externalKey: 'C3' }),
      ]);
      expect(suites.json()).toEqual([
        expect.objectContaining({ entityId: suiteId, externalKey: 'S2' }),
      ]);
    });
  });

  describe('run → run', () => {
    it('creates the run over the synced cases of its suite', async () => {
      await connectTestRail();
      const first = await createCase({ title: 'First' });
      const second = await createCase({ title: 'Second' });
      const run = await createRun([first.id, second.id], { milestone: 'v1.0' });

      const synced = await sync('test-runs', run.id);

      expect(synced.statusCode).toBe(200);
      expect(synced.json()).toMatchObject({
        entityType: 'test_run',
        action: 'created',
        reference: {
          externalId: '2',
          externalKey: 'R2',
          externalUrl: 'https://acme.testrail.io/index.php?/runs/view/2',
          metadata: { suiteId: '2', status: 'Active' },
        },
      });
      const dependencyKeys = synced
        .json()
        .dependencies.map((reference: { externalKey: string }) => reference.externalKey)
        .sort();
      expect(dependencyKeys).toEqual(['C3', 'C4', 'S2']);

      const stored = store.findRun(workspace.organizationId, '2');
      expect(stored?.description).toContain('Milestone: v1.0');
      expect(store.listTests(workspace.organizationId, '2').map((test) => test.caseId)).toEqual([
        '3',
        '4',
      ]);
      expect(await prisma.externalReference.count()).toBe(4);
    });

    it('follows the run to completion on re-sync', async () => {
      await connectTestRail();
      const testCase = await createCase();
      const run = await createRun([testCase.id]);
      const first = (await sync('test-runs', run.id)).json();

      await request('POST', `/api/v1/test-runs/${run.id}/start`, asOwner({}));
      await request('POST', `/api/v1/test-runs/${run.id}/complete`, asOwner({}));
      const second = (await sync('test-runs', run.id)).json();

      expect(second).toMatchObject({
        action: 'updated',
        reference: { id: first.reference.id, metadata: { status: 'Completed' } },
      });
      expect(store.findRun(workspace.organizationId, '2')?.isCompleted).toBe(true);
    });

    it('refuses to export a run without cases', async () => {
      await connectTestRail();
      const run = await createRun([]);

      const synced = await sync('test-runs', run.id);

      expect(synced.statusCode).toBe(409);
      expect(synced.json().error.message).toContain('no cases');
    });

    it('exports against the dominant suite and names the cases left out', async () => {
      await connectTestRail();
      const other = await createSuite('Search');
      const a = await createCase({ title: 'Alpha' });
      const b = await createCase({ title: 'Beta' });
      const c = await createCase({ title: 'Gamma', suiteId: other.id });
      const run = await createRun([a.id, b.id, c.id]);

      const synced = (await sync('test-runs', run.id)).json();

      expect(synced.reference.metadata).toMatchObject({ suiteId: '2', skippedCases: c.key });
      expect(store.listTests(workspace.organizationId, '2')).toHaveLength(2);
    });
  });

  describe('result → result', () => {
    it('adds the result to the run test and keeps it on re-sync', async () => {
      await connectTestRail();
      const testCase = await createCase();
      const run = await createRun([testCase.id]);
      const runCase = await firstRunCaseOf(run.id);
      const result = await recordResult(run.id, runCase.id, { elapsedSeconds: 42 });

      const first = await sync('test-results', result.id);

      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        entityType: 'test_result',
        action: 'created',
        reference: {
          externalId: '2',
          externalKey: null,
          externalUrl: 'https://acme.testrail.io/index.php?/tests/view/3',
          metadata: { runId: '2', caseId: '3', status: 'Failed' },
        },
      });
      const dependencyTypes = first
        .json()
        .dependencies.map((reference: { entityType: string }) => reference.entityType)
        .sort();
      expect(dependencyTypes).toEqual(['test_case', 'test_run', 'test_suite']);

      const stored = store.findResult(workspace.organizationId, '2');
      expect(stored).toMatchObject({ comment: 'Card declined', elapsedSeconds: 42 });

      const second = await sync('test-results', result.id);
      expect(second.json()).toMatchObject({
        action: 'unchanged',
        reference: { id: first.json().reference.id, externalId: '2' },
      });
      expect(store.listResults(workspace.organizationId, '3')).toHaveLength(1);
      expect(await prisma.externalReference.count()).toBe(4);
    });

    it('lists the result references of a run', async () => {
      await connectTestRail();
      const testCase = await createCase();
      const run = await createRun([testCase.id]);
      const runCase = await firstRunCaseOf(run.id);
      const synced = await recordResult(run.id, runCase.id);
      await recordResult(run.id, runCase.id, { status: 'passed' });
      await sync('test-results', synced.id);

      const references = await request(
        'GET',
        `/api/v1/integrations/testrail/references?testRunId=${run.id}&entityType=test_result`,
        asOwner(),
      );

      expect(references.statusCode).toBe(200);
      expect(references.json()).toEqual([expect.objectContaining({ entityId: synced.id })]);
    });
  });

  describe('permissions and isolation', () => {
    it('never shows one organization the suites of another', async () => {
      await connectTestRail();
      await sync('test-suites', suiteId);

      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });
      await request('PUT', '/api/v1/integrations/testrail', {
        payload: { mode: 'mock' },
        ...as(stranger.owner, stranger.organizationId),
      });
      await request(
        'POST',
        '/api/v1/integrations/testrail/connect',
        as(stranger.owner, stranger.organizationId),
      );

      const theirSuites = await request(
        'GET',
        '/api/v1/integrations/testrail/suites',
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirSuites.json().map((suite: { externalId: string }) => suite.externalId)).toEqual([
        '1',
      ]);

      const theirSync = await sync(
        'test-suites',
        suiteId,
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirSync.statusCode).toBe(404);

      const theirReferences = await request(
        'GET',
        `/api/v1/integrations/testrail/references?projectId=${workspace.projectId}&entityType=test_suite`,
        as(stranger.owner, stranger.organizationId),
      );
      expect(theirReferences.statusCode).toBe(404);
    });

    it('lets whoever may edit the entity sync it, and nobody else', async () => {
      await connectTestRail();
      const viewer = await workspace.addMember('viewer');
      const tester = await workspace.addMember('tester');
      const testCase = await createCase();
      const run = await createRun([testCase.id]);
      const runCase = await firstRunCaseOf(run.id);
      const result = await recordResult(run.id, runCase.id);

      expect((await sync('test-suites', suiteId, as(viewer))).statusCode).toBe(403);
      expect((await sync('test-cases', testCase.id, as(tester))).statusCode).toBe(403);
      expect((await sync('test-runs', run.id, as(tester))).statusCode).toBe(403);
      expect((await sync('test-results', result.id, as(viewer))).statusCode).toBe(403);
      expect((await sync('test-results', result.id, as(tester))).statusCode).toBe(200);
    });

    it('applies a project-level role narrowing to the sync', async () => {
      await connectTestRail();
      const lead = await workspace.addMember('qa_lead');

      await request(
        'POST',
        `/api/v1/projects/${workspace.projectId}/members`,
        asOwner({ userId: lead.userId, role: 'viewer' }),
      );

      expect((await sync('test-suites', suiteId, as(lead))).statusCode).toBe(403);
    });
  });

  describe('provider failures', () => {
    it('reports a simulated write failure and marks the connection', async () => {
      await connectTestRail({ simulateFailure: 'write_failure' });

      const synced = await sync('test-suites', suiteId);

      expect(synced.statusCode).toBe(502);
      expect(synced.json().error.code).toBe('INTEGRATION_ERROR');
      expect(synced.json().error.message).toContain('refused the write');

      const connection = (await request('GET', '/api/v1/integrations/testrail', asOwner())).json();
      expect(connection).toMatchObject({ status: 'error' });
      expect(connection.lastError).toContain('refused the write');
      expect(await prisma.externalReference.count()).toBe(0);
    });

    it('refuses to sync into a project the mock does not have', async () => {
      await connectTestRail({ projectId: '42' });

      const synced = await sync('test-suites', suiteId);

      expect(synced.statusCode).toBe(502);
      expect(synced.json().error.message).toContain('42');
    });

    it('clears the error once a sync succeeds again', async () => {
      await connectTestRail({ simulateFailure: 'unreachable' });
      expect((await sync('test-suites', suiteId)).statusCode).toBe(502);

      await request(
        'PUT',
        '/api/v1/integrations/testrail',
        asOwner({ mode: 'mock', settings: {} }),
      );
      const synced = await sync('test-suites', suiteId);

      expect(synced.statusCode).toBe(200);
      const connection = (await request('GET', '/api/v1/integrations/testrail', asOwner())).json();
      expect(connection).toMatchObject({ status: 'connected', lastError: null });
      expect(connection.lastSyncAt).not.toBeNull();
    });
  });
});
