import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { GitHubMockStore } from '../src/integrations';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Repository → workflow → workflow run → automated results → TestRun/TestResult,
 * over HTTP and against the mock.
 *
 * What these tests protect: browsing is deterministic and tenant-scoped, a
 * test run gets exactly one reference to a workflow run that moves when the
 * run is re-linked and refreshes when CI finishes, Playwright results reach the
 * run's cases through their `@C-n` tags and nowhere else, every unmatched
 * result is reported rather than dropped, importing twice adds nothing, and a
 * provider failure is written on the connection.
 */
describe('github synchronisation', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let store: GitHubMockStore;
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

  const connectGitHub = async (settings: Record<string, string> = {}) => {
    await request('PUT', '/api/v1/integrations/github', asOwner({ mode: 'mock', settings }));
    return request('POST', '/api/v1/integrations/github/connect', asOwner());
  };

  /** Three cases whose keys are WEB-C-1, WEB-C-2 and WEB-C-3: the tags in the mock's Playwright titles. */
  const createTaggedCases = async (count = 3): Promise<string[]> => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await request(
        'POST',
        '/api/v1/test-cases',
        asOwner({
          title: `Automated case ${index + 1}`,
          priority: 'high',
          type: 'regression',
          steps: [{ action: 'Run it', expectedResult: 'Green' }],
          suiteId,
        }),
      );
      expect(response.statusCode, response.body).toBe(201);
      ids.push(response.json().id);
    }
    return ids;
  };

  const createRun = async (testCaseIds: string[]) => {
    const response = await request(
      'POST',
      '/api/v1/test-runs',
      asOwner({
        projectId: workspace.projectId,
        name: 'Nightly automation',
        environment: 'ci',
        ...(testCaseIds.length === 0 ? {} : { selection: { testCaseIds } }),
      }),
    );
    expect(response.statusCode).toBe(201);
    return response.json();
  };

  const link = (runId: string, target: object | null = null, options = asOwner()) =>
    request('POST', `/api/v1/integrations/github/sync/test-runs/${runId}`, {
      ...options,
      ...(target === null ? {} : { payload: target }),
    });

  const importResults = (runId: string, options = asOwner()) =>
    request('POST', `/api/v1/integrations/github/sync/test-runs/${runId}/results`, options);

  const runCasesOf = async (runId: string) =>
    (await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())).json().data as Array<{
      id: string;
      latestStatus: string;
      snapshot: { key: string };
    }>;

  const WEB_CHECKOUT = { repositoryExternalId: '1', runExternalId: '1001' };
  const FAILED_RUN = { repositoryExternalId: '1', runExternalId: '1002' };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    store = app.get(GitHubMockStore);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    store.reset();
    workspace = await createWorkspace(app);
    const suite = await request(
      'POST',
      '/api/v1/test-suites',
      asOwner({ projectId: workspace.projectId, name: 'E2E' }),
    );
    suiteId = suite.json().id;
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('browsing the mock', () => {
    it('lists deterministic repositories, branches, workflows, runs, jobs, artifacts and results', async () => {
      await connectGitHub();

      const repositories = (
        await request('GET', '/api/v1/integrations/github/repositories', asOwner())
      ).json();
      expect(repositories.map((repository: { fullName: string }) => repository.fullName)).toEqual([
        'acme/web-checkout',
        'acme/api-gateway',
      ]);

      const branches = (
        await request(
          'GET',
          '/api/v1/integrations/github/branches?repositoryExternalId=1',
          asOwner(),
        )
      ).json();
      expect(branches.map((branch: { name: string }) => branch.name)).toEqual([
        'main',
        'feature/checkout-retry',
      ]);

      const workflows = (
        await request(
          'GET',
          '/api/v1/integrations/github/workflows?repositoryExternalId=1',
          asOwner(),
        )
      ).json();
      expect(workflows.map((workflow: { name: string }) => workflow.name)).toEqual([
        'Playwright E2E',
        'CI',
      ]);

      const runs = (
        await request(
          'GET',
          '/api/v1/integrations/github/runs?repositoryExternalId=1&workflowExternalId=1',
          asOwner(),
        )
      ).json();
      expect(
        runs.map((run: { externalId: string; status: string; conclusion: string | null }) => [
          run.externalId,
          run.status,
          run.conclusion,
        ]),
      ).toEqual([
        ['1003', 'in_progress', null],
        ['1002', 'completed', 'failure'],
        ['1001', 'completed', 'success'],
      ]);
      expect(runs[2]).toMatchObject({
        headBranch: 'main',
        headSha: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown,
        url: expect.stringContaining('/actions/runs/1001') as unknown,
      });

      const jobs = (
        await request(
          'GET',
          '/api/v1/integrations/github/jobs?repositoryExternalId=1&runExternalId=1001',
          asOwner(),
        )
      ).json();
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs[0].steps.length).toBeGreaterThan(0);

      const artifacts = (
        await request(
          'GET',
          '/api/v1/integrations/github/artifacts?repositoryExternalId=1&runExternalId=1001',
          asOwner(),
        )
      ).json();
      expect(artifacts.map((artifact: { name: string }) => artifact.name)).toContain(
        'playwright-report',
      );

      const results = (
        await request(
          'GET',
          '/api/v1/integrations/github/results?repositoryExternalId=1&runExternalId=1002',
          asOwner(),
        )
      ).json();
      expect(
        results.map((result: { caseTags: string[]; status: string }) => [
          result.caseTags,
          result.status,
        ]),
      ).toEqual([
        [['C-1'], 'passed'],
        [['C-2'], 'failed'],
        [['C-3'], 'passed'],
        [[], 'failed'],
      ]);
      expect(results[0].framework).toBe('playwright');
    });

    it('refuses to browse until the integration is connected', async () => {
      const response = await request('GET', '/api/v1/integrations/github/repositories', asOwner());

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    });

    it('keeps one organization’s repositories out of another’s view', async () => {
      await connectGitHub();
      const other = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'GLX',
      });
      await request('PUT', '/api/v1/integrations/github', {
        ...as(other.owner, other.organizationId),
        payload: { mode: 'mock' },
      });
      await request(
        'POST',
        '/api/v1/integrations/github/connect',
        as(other.owner, other.organizationId),
      );

      const mine = (await createRun(await createTaggedCases(1))).id;
      await link(mine, WEB_CHECKOUT);

      const theirs = await request(
        'GET',
        `/api/v1/integrations/github/references?entityType=test_run&projectId=${other.projectId}`,
        as(other.owner, other.organizationId),
      );
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json()).toEqual([]);

      const crossTenant = await request(
        'GET',
        `/api/v1/integrations/github/references?entityType=test_run&projectId=${workspace.projectId}`,
        as(other.owner, other.organizationId),
      );
      expect(crossTenant.statusCode).toBe(404);
    });
  });

  describe('linking a test run to a workflow run', () => {
    it('creates one reference carrying the run’s status, conclusion and commit', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));

      const linked = await link(run.id, WEB_CHECKOUT);

      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({
        entityType: 'test_run',
        entityId: run.id,
        action: 'created',
        reference: {
          provider: 'github',
          externalId: '1001',
          externalKey: 'acme/web-checkout#41',
          externalUrl: expect.stringContaining('/actions/runs/1001') as unknown,
          metadata: {
            repositoryExternalId: '1',
            repositoryFullName: 'acme/web-checkout',
            workflowName: 'Playwright E2E',
            status: 'completed',
            conclusion: 'success',
            headBranch: 'main',
          },
        },
      });

      const testRun = await prisma.testRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(Object.keys(testRun)).not.toContain('workflowRunId');

      const connection = await prisma.integrationConnection.findFirstOrThrow({
        where: { organizationId: workspace.organizationId, provider: 'github' },
      });
      expect(connection.lastSyncAt).not.toBeNull();
      expect(connection.status).toBe('connected');
    });

    it('re-links by moving the same reference and remembering where it pointed', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));
      await link(run.id, WEB_CHECKOUT);

      const relinked = await link(run.id, FAILED_RUN);

      expect(relinked.json()).toMatchObject({
        action: 'updated',
        reference: {
          externalId: '1002',
          metadata: { conclusion: 'failure', previousExternalId: '1001' },
        },
      });
      const references = await prisma.externalReference.findMany({
        where: { entityType: 'test_run', entityId: run.id },
      });
      expect(references).toHaveLength(1);
    });

    it('refreshes a linked run without a body and reports it unchanged when nothing moved', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));
      await link(run.id, WEB_CHECKOUT);

      const refreshed = await link(run.id);

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().action).toBe('unchanged');
    });

    it('refuses to refresh a run that was never linked', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));

      const response = await link(run.id);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain('not linked');
    });

    it('reports a workflow run the provider does not know', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));

      const response = await link(run.id, { repositoryExternalId: '1', runExternalId: '9999' });

      expect(response.statusCode).toBe(404);
    });

    it('lists the project’s run references in one call', async () => {
      await connectGitHub();
      const first = await createRun(await createTaggedCases(1));
      const second = await createRun([]);
      await link(first.id, WEB_CHECKOUT);

      const references = await request(
        'GET',
        `/api/v1/integrations/github/references?entityType=test_run&projectId=${workspace.projectId}`,
        asOwner(),
      );

      expect(references.statusCode).toBe(200);
      expect(
        references.json().map((reference: { entityId: string }) => reference.entityId),
      ).toEqual([first.id]);
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('importing automated results', () => {
    it('records one TestResult per tagged Playwright result and reports the rest', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(2));
      await link(run.id, FAILED_RUN);

      const imported = await importResults(run.id);

      expect(imported.statusCode, imported.body).toBe(200);
      const body = imported.json();
      expect(body.imported).toHaveLength(2);
      expect(body.skipped).toEqual([
        expect.objectContaining({ caseTags: ['C-3'], reason: 'case_not_in_run' }),
        expect.objectContaining({ caseTags: [], reason: 'no_case_tag' }),
      ]);

      const cases = await runCasesOf(run.id);
      expect(cases.map((runCase) => [runCase.snapshot.key, runCase.latestStatus])).toEqual([
        ['WEB-C-1', 'passed'],
        ['WEB-C-2', 'failed'],
      ]);

      const results = await prisma.testResult.findMany({
        where: { testRunId: run.id },
        orderBy: { executedAt: 'asc' },
      });
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.status)).toEqual(['passed', 'failed']);
      expect(results[1]?.comment).toContain('Card expired');
      expect(results[1]?.elapsedSeconds).toBe(5);
      expect(results.every((result) => result.executedById === workspace.owner.userId)).toBe(true);

      const references = await prisma.externalReference.findMany({
        where: { entityType: 'test_result', provider: 'github' },
      });
      expect(references.map((reference) => reference.externalId).sort()).toEqual([
        '1002-1',
        '1002-2',
      ]);
      expect(references[0]?.metadata).toMatchObject({ framework: 'playwright' });

      const testRun = await prisma.testRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(testRun.status).toBe('in_progress');
    });

    it('imports nothing the second time and says so', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(2));
      await link(run.id, FAILED_RUN);
      await importResults(run.id);

      const again = await importResults(run.id);

      expect(again.json().imported).toEqual([]);
      expect(
        again
          .json()
          .skipped.filter((skip: { reason: string }) => skip.reason === 'already_imported'),
      ).toHaveLength(2);
      expect(await prisma.testResult.count({ where: { testRunId: run.id } })).toBe(2);
    });

    it('waits for a workflow run that is still in progress', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));
      await link(run.id, { repositoryExternalId: '1', runExternalId: '1003' });

      const imported = await importResults(run.id);

      expect(imported.statusCode).toBe(200);
      expect(imported.json().imported).toEqual([]);
      expect(
        imported
          .json()
          .skipped.every((skip: { reason: string }) => skip.reason === 'run_not_completed'),
      ).toBe(true);
      expect(imported.json().workflowRun.metadata.status).toBe('in_progress');
      expect(await prisma.testResult.count({ where: { testRunId: run.id } })).toBe(0);
    });

    it('refuses to import before the run is linked', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(1));

      const response = await importResults(run.id);

      expect(response.statusCode).toBe(400);
    });

    it('lists the run’s result references for the execution screen', async () => {
      await connectGitHub();
      const run = await createRun(await createTaggedCases(2));
      await link(run.id, WEB_CHECKOUT);
      await importResults(run.id);

      const references = await request(
        'GET',
        `/api/v1/integrations/github/references?entityType=test_result&testRunId=${run.id}`,
        asOwner(),
      );

      expect(references.statusCode).toBe(200);
      expect(references.json()).toHaveLength(2);
      expect(references.json()[0].metadata.workflowRunExternalId).toBe('1001');
    });
  });

  describe('permissions', () => {
    it('lets a tester import but not link', async () => {
      await connectGitHub();
      const tester = await workspace.addMember('tester');
      const run = await createRun(await createTaggedCases(1));

      const denied = await link(run.id, WEB_CHECKOUT, as(tester));
      expect(denied.statusCode).toBe(403);

      await link(run.id, WEB_CHECKOUT);
      const allowed = await importResults(run.id, as(tester));
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it('refuses a viewer both ways', async () => {
      await connectGitHub();
      const viewer = await workspace.addMember('viewer');
      const run = await createRun(await createTaggedCases(1));
      await link(run.id, WEB_CHECKOUT);

      expect((await link(run.id, WEB_CHECKOUT, as(viewer))).statusCode).toBe(403);
      expect((await importResults(run.id, as(viewer))).statusCode).toBe(403);
    });
  });

  describe('provider failures', () => {
    it('paints the connection red when the provider is unreachable', async () => {
      await connectGitHub({ simulateFailure: 'unreachable' });
      const run = await createRun(await createTaggedCases(1));

      const response = await link(run.id, WEB_CHECKOUT);

      expect(response.statusCode).toBe(502);
      expect(response.json().error.code).toBe('INTEGRATION_ERROR');
      const connection = await prisma.integrationConnection.findFirstOrThrow({
        where: { organizationId: workspace.organizationId, provider: 'github' },
      });
      expect(connection.status).toBe('error');
      expect(connection.lastError).toContain('simulated');
    });

    it('lets browsing succeed but fails the report download on fetch_failure, then recovers', async () => {
      await connectGitHub({ simulateFailure: 'fetch_failure' });
      const run = await createRun(await createTaggedCases(1));
      expect((await link(run.id, WEB_CHECKOUT)).statusCode).toBe(200);

      const failed = await importResults(run.id);
      expect(failed.statusCode).toBe(502);
      expect(await prisma.testResult.count({ where: { testRunId: run.id } })).toBe(0);

      await request('PUT', '/api/v1/integrations/github', asOwner({ mode: 'mock', settings: {} }));
      const recovered = await importResults(run.id);
      expect(recovered.statusCode, recovered.body).toBe(200);
      const connection = await prisma.integrationConnection.findFirstOrThrow({
        where: { organizationId: workspace.organizationId, provider: 'github' },
      });
      expect(connection.status).toBe('connected');
      expect(connection.lastError).toBeNull();
    });
  });
});
