import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * QA metrics dashboard (S7-F7), with the API connected as `qaflow_app` so every
 * aggregate runs under Row Level Security. The owner connection only
 * truncates and asserts state.
 */
describe('QA metrics dashboard', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  const ownerUrl = (): string =>
    process.env['TEST_DATABASE_URL'] ??
    'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public';

  const appRoleUrl = (): string => {
    const url = new URL(ownerUrl());
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const truncate = async (): Promise<void> => {
    const tables = await owner.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER USER`);
    }
  };

  const as = (account: TestAccount, payload?: object, workspace: TestWorkspace = acme) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: workspace.organizationId,
  });

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({
      databaseUrl: appRoleUrl(),
      ingestion: { rateLimitMax: 10_000, maxBytes: 64 * 1024, maxTests: 50 },
    });
  });

  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
    globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLX',
    });
  });

  const ok = <T>(
    response: { statusCode: number; body: string; json: () => unknown },
    status = 200,
  ): T => {
    expect(response.statusCode, response.body).toBe(status);
    return response.json() as T;
  };
  const post = (path: string, body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request('POST', path, as(account, body, workspace));
  const get = (path: string, account: TestAccount = acme.owner, workspace = acme) =>
    request('GET', path, as(account, undefined, workspace));

  interface Metrics {
    projectId: string;
    runs: number;
    execution: {
      planned: number;
      executed: number;
      pending: number;
      verdicts: number;
      passRate: number | null;
    };
    rates: {
      passRate: number | null;
      failedRate: number | null;
      blockedRate: number | null;
      insufficientData: boolean;
    };
    trend: Array<{ passed: number; failed: number; blocked: number; passRate: number | null }>;
    plans: Array<{ id: string; name: string }>;
    cycles: Array<{ id: string }>;
    defects: {
      open: number;
      openBySeverity: Record<string, number>;
      raisedInPeriod: number;
      density: number | null;
      densityInsufficientData: boolean;
    };
    flaky: {
      counts: Record<string, number>;
      evolution: Array<{ flaky: number; suspect: number; failing: number }>;
    };
    exploratory: {
      sessions: number;
      byStatus: Record<string, number>;
      findings: number;
      findingsBySeverity: Record<string, number>;
      defectsCreated: number;
    };
  }
  const path = (filter = '', workspace = acme) =>
    `/api/v1/projects/${workspace.projectId}/qa-metrics${filter === '' ? '' : `?${filter}`}`;
  const metrics = async (filter = '', account = acme.owner) =>
    ok<Metrics>(await get(path(filter), account));

  let suiteId = '';
  beforeEach(() => {
    suiteId = '';
  });
  const testCase = async (title: string): Promise<string> => {
    if (suiteId === '') {
      suiteId = ok<{ id: string }>(
        await post('/api/v1/test-suites', { projectId: acme.projectId, name: 'Checkout' }),
        201,
      ).id;
    }
    return ok<{ id: string }>(await post('/api/v1/test-cases', { suiteId, title }), 201).id;
  };
  const STATUS: Record<string, string> = { P: 'passed', F: 'failed', B: 'blocked', S: 'skipped' };
  /** One run over `statuses` (one case each; `U` stays untested); returns result ids by case. */
  const run = async (
    cases: Record<string, string>,
    extra: { environment?: string; releaseId?: string } = {},
  ): Promise<{ runId: string; results: Record<string, string> }> => {
    const runId = ok<{ id: string }>(
      await post('/api/v1/test-runs', {
        projectId: acme.projectId,
        name: 'Regression',
        selection: { testCaseIds: Object.keys(cases) },
        ...extra,
      }),
      201,
    ).id;
    const rows = ok<{ data: Array<{ id: string; testCaseId: string }> }>(
      await get(`/api/v1/test-runs/${runId}/cases?pageSize=100`),
    ).data;
    const results: Record<string, string> = {};
    for (const row of rows) {
      const status = STATUS[cases[row.testCaseId] ?? 'U'];
      if (status !== undefined) {
        results[row.testCaseId] = ok<{ id: string }>(
          await post(`/api/v1/test-runs/${runId}/cases/${row.id}/results`, { status }),
          201,
        ).id;
      }
    }
    return { runId, results };
  };

  it('reports zeros and no percentages for a project without data', async () => {
    const view = await metrics();
    expect(view.projectId).toBe(acme.projectId);
    expect(view.runs).toBe(0);
    expect(view.execution).toMatchObject({ planned: 0, executed: 0, pending: 0, passRate: null });
    expect(view.rates).toEqual({
      passRate: null,
      failedRate: null,
      blockedRate: null,
      insufficientData: false,
    });
    expect(view.trend.length).toBeGreaterThan(0);
    expect(view.trend.every((point) => point.passRate === null && point.passed === 0)).toBe(true);
    expect(view.plans).toEqual([]);
    expect(view.cycles).toEqual([]);
    expect(view.defects).toMatchObject({ open: 0, density: null, densityInsufficientData: false });
    expect(Object.values(view.flaky.counts).every((count) => count === 0)).toBe(true);
    expect(view.flaky.evolution.every((point) => point.flaky === 0)).toBe(true);
    expect(view.exploratory).toMatchObject({ sessions: 0, findings: 0, defectsCreated: 0 });
  });

  it('computes execution, defects, flaky and exploratory KPIs and narrows them by filter', async () => {
    const ids: string[] = [];
    for (const title of ['Case A', 'Case B', 'Case C', 'Case D', 'Case E', 'Case F', 'Case G']) {
      ids.push(await testCase(title));
    }
    const [a, b, c, d, e, f, g] = ids as [string, string, string, string, string, string, string];
    const environment = ok<{ id: string; name: string }>(
      await post('/api/v1/environments', {
        projectId: acme.projectId,
        name: 'Staging',
        kind: 'staging',
      }),
      201,
    );
    const release = ok<{ id: string }>(
      await post('/api/v1/releases', {
        projectId: acme.projectId,
        name: 'Release 1',
        version: '1.0.0',
      }),
      201,
    );
    // Staging run: 3 passed, 1 failed, 1 blocked, 1 skipped, 1 untested.
    const staging = await run(
      { [a]: 'P', [b]: 'P', [c]: 'P', [d]: 'F', [e]: 'B', [f]: 'S', [g]: 'U' },
      { environment: 'staging', releaseId: release.id },
    );
    // Another run without environment or release: a flaky pattern on case A.
    for (const status of ['F', 'P', 'F', 'P', 'F']) {
      await run({ [a]: status });
    }
    ok(
      await post('/api/v1/defects', {
        projectId: acme.projectId,
        title: 'Refund fails',
        severity: 'critical',
        testResultId: staging.results[d],
      }),
      201,
    );
    ok(
      await post('/api/v1/defects', {
        projectId: acme.projectId,
        title: 'Typo',
        severity: 'minor',
      }),
      201,
    );
    const plan = ok<{ id: string }>(
      await post('/api/v1/test-plans', {
        projectId: acme.projectId,
        name: 'Release plan',
        releaseId: release.id,
      }),
      201,
    );
    ok(await post(`/api/v1/test-plans/${plan.id}/runs`, { testRunId: staging.runId }));
    const session = ok<{ id: string }>(
      await post('/api/v1/exploratory-sessions', {
        projectId: acme.projectId,
        title: 'Payments tour',
        charter: 'Explore refunds',
        environmentId: environment.id,
      }),
      201,
    );
    ok(await post(`/api/v1/exploratory-sessions/${session.id}/start`, {}));
    ok(
      await post(`/api/v1/exploratory-sessions/${session.id}/findings`, {
        title: 'Rounding',
        severity: 'major',
      }),
      201,
    );

    const all = await metrics();
    expect(all.runs).toBe(6);
    // 7 staging cases + 5 single-case runs; latest status per run case.
    expect(all.execution).toMatchObject({ planned: 12, executed: 11, pending: 1, verdicts: 10 });
    expect(all.rates).toMatchObject({ passRate: 50, failedRate: 40, blockedRate: 10 });
    expect(all.trend.reduce((sum, point) => sum + point.passed + point.failed, 0)).toBe(9);
    expect(all.defects).toMatchObject({
      open: 2,
      raisedInPeriod: 1,
      density: null,
      densityInsufficientData: true,
    });
    expect(all.defects.openBySeverity).toMatchObject({ critical: 1, minor: 1 });
    expect(all.flaky.counts['flaky']).toBe(1);
    expect(all.flaky.evolution.at(-1)?.flaky).toBe(1);
    expect(all.plans.map((row) => row.id)).toEqual([plan.id]);
    expect(all.exploratory).toMatchObject({ sessions: 1, findings: 1, defectsCreated: 0 });
    expect(all.exploratory.byStatus).toMatchObject({ active: 1 });
    expect(all.exploratory.findingsBySeverity).toMatchObject({ major: 1 });

    for (const filter of [
      `environmentId=${environment.id}`,
      `releaseId=${release.id}`,
      `testPlanId=${plan.id}`,
    ]) {
      const view = await metrics(filter);
      expect(view.runs, filter).toBe(1);
      expect(view.execution, filter).toMatchObject({
        planned: 7,
        executed: 6,
        pending: 1,
        verdicts: 5,
      });
      expect(view.rates, filter).toMatchObject({ passRate: 60, failedRate: 20, blockedRate: 20 });
      // With a filter only defects raised from runs in scope count.
      expect(view.defects, filter).toMatchObject({ open: 1, raisedInPeriod: 1 });
      expect(view.defects.openBySeverity, filter).toMatchObject({ critical: 1, minor: 0 });
    }
    expect((await metrics(`environmentId=${environment.id}`)).exploratory.sessions).toBe(1);
    expect((await metrics(`releaseId=${release.id}`)).exploratory.sessions).toBe(0);
    expect((await metrics(`releaseId=${release.id}`)).plans.map((row) => row.id)).toEqual([
      plan.id,
    ]);
    expect((await metrics(`environmentId=${environment.id}`)).plans).toEqual([]);

    // A window that ends before anything happened: no runs, no trend, no rates.
    const past = await metrics('from=2020-01-01T00:00:00.000Z&to=2020-01-31T00:00:00.000Z');
    expect(past).toMatchObject({ runs: 0, rates: { passRate: null }, plans: [] });
    expect(past.exploratory.sessions).toBe(0);
    expect((await get(path('from=2027-02-01&to=2027-01-01'))).statusCode).toBe(400);
  });

  it('hides a too-small sample behind insufficientData', async () => {
    const one = await testCase('Only case');
    await run({ [one]: 'P' });
    const view = await metrics();
    expect(view.execution.passRate).toBe(100);
    expect(view.rates).toEqual({
      passRate: null,
      failedRate: null,
      blockedRate: null,
      insufficientData: true,
    });
  });

  it('isolates projects and tenants and honours analytics.read', async () => {
    const mine = await testCase('Mine');
    await run({ [mine]: 'F' });
    // The other tenant sees nothing of acme and cannot reach the project.
    const theirs = ok<Metrics>(await get(path('', globex), globex.owner, globex));
    expect(theirs).toMatchObject({ runs: 0, execution: { planned: 0 } });
    expect((await get(path(), globex.owner, globex)).statusCode).toBe(404);
    expect((await get(path(), globex.owner, acme)).statusCode).toBe(403);
    // A filter naming a resource of another tenant or project is a 404.
    const foreignPlan = ok<{ id: string }>(
      await post(
        '/api/v1/test-plans',
        { projectId: globex.projectId, name: 'Theirs' },
        globex.owner,
        globex,
      ),
      201,
    );
    expect((await get(path(`testPlanId=${foreignPlan.id}`))).statusCode).toBe(404);
    expect((await get(path('environmentId=missing'))).statusCode).toBe(404);

    const hidden = await acme.addMember('qa_lead', 'hidden', { projectAccess: false });
    expect((await get(path(), hidden)).statusCode).toBe(404);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await metrics('', viewer)).runs).toBe(1);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${viewer.userId}`,
        as(acme.owner, { overrides: [{ permission: 'analytics.read', effect: 'revoke' }] }),
      ),
    );
    expect((await get(path(), viewer)).statusCode).toBe(403);
    // Under qaflow_app RLS hides acme rows from a globex transaction, so the
    // owner connection is the only way to see both tenants' rows exist.
    expect(await owner.testRun.count()).toBe(1);
  });
});
