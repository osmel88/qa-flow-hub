import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Test plans (S7-F1), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Test plans', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;

  const request = injector(() => app);

  const errorOf = (response: { json: () => { error: { code: string; message: string } } }) => ({
    code: response.json().error.code,
    message: response.json().error.message,
  });

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
    app = await createTestApp({ databaseUrl: appRoleUrl() });
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

  interface Plan {
    id: string;
    status: string;
    version: number;
    owner: { id: string } | null;
    runs: Array<{ id: string }>;
    scope: { frozen: boolean; version: number; caseCount: number };
  }
  interface Progress {
    counts: { passed: number; failed: number; untested: number; total: number };
    completion: number;
    passRate: number | null;
    coverage: { planned: number; total: number; percent: number };
    cases: Array<{ key: string; status: string; source: string }>;
    defects: { open: number; total: number };
    scope: { frozen: boolean; version: number };
  }

  const post = (path: string, body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request('POST', path, as(account, body, workspace));
  const suite = async (name: string, workspace = acme, projectId = workspace.projectId) =>
    ok<{ id: string }>(
      await post('/api/v1/test-suites', { projectId, name }, workspace.owner, workspace),
      201,
    ).id;
  const testCase = async (suiteId: string, title: string, workspace = acme) =>
    ok<{ id: string }>(
      await post('/api/v1/test-cases', { suiteId, title }, workspace.owner, workspace),
      201,
    ).id;
  const run = async (
    name: string,
    testCaseIds: string[],
    workspace = acme,
    projectId = workspace.projectId,
  ) => {
    const id = ok<{ id: string }>(
      await post(
        '/api/v1/test-runs',
        { projectId, name, selection: { testCaseIds } },
        workspace.owner,
        workspace,
      ),
      201,
    ).id;
    const cases = ok<{ data: Array<{ id: string; testCaseId: string }> }>(
      await request(
        'GET',
        `/api/v1/test-runs/${id}/cases?pageSize=100`,
        as(workspace.owner, undefined, workspace),
      ),
    ).data;
    return {
      id,
      runCase: (caseId: string) => cases.find((entry) => entry.testCaseId === caseId)!.id,
    };
  };
  const record = async (runId: string, runCaseId: string, status: string) =>
    ok(await post(`/api/v1/test-runs/${runId}/cases/${runCaseId}/results`, { status }), 201);
  const createPlan = (body: object, account: TestAccount = acme.owner) =>
    post('/api/v1/test-plans', { projectId: acme.projectId, ...body }, account);
  const plan = async (body: object) => ok<Plan>(await createPlan(body), 201);
  const action = (id: string, name: string, body: object = {}, account: TestAccount = acme.owner) =>
    post(`/api/v1/test-plans/${id}/${name}`, body, account);
  const patch = (id: string, body: object, account: TestAccount = acme.owner) =>
    request('PATCH', `/api/v1/test-plans/${id}`, as(account, body));
  const get = async (id: string) =>
    ok<Plan>(await request('GET', `/api/v1/test-plans/${id}`, as(acme.owner)));
  const progress = async (id: string) =>
    ok<Progress>(await request('GET', `/api/v1/test-plans/${id}/progress`, as(acme.owner)));
  const env = async (name: string, workspace = acme, projectId = workspace.projectId) =>
    ok<{ id: string }>(
      await post('/api/v1/environments', { projectId, name }, workspace.owner, workspace),
      201,
    ).id;
  const release = async (version: string, workspace = acme) =>
    ok<{ id: string }>(
      await post(
        '/api/v1/releases',
        { projectId: workspace.projectId, name: `R ${version}`, version },
        workspace.owner,
        workspace,
      ),
      201,
    ).id;

  it('plans, freezes the scope at start, keeps it when suites change and derives progress', async () => {
    const checkout = await suite('Checkout');
    const [c1, c2] = [
      await testCase(checkout, 'Pay with card'),
      await testCase(checkout, 'Pay with voucher'),
    ];
    const other = await suite('Accounts');
    const c3 = await testCase(other, 'Sign in');
    const staging = await env('staging');
    const r1 = await release('1.0.0');
    const created = await plan({
      name: 'Checkout plan',
      releaseId: r1,
      environmentIds: [staging],
      suiteIds: [checkout],
      testCaseIds: [c3],
      startDate: '2027-03-01',
      endDate: '2027-03-15',
    });
    expect([created.status, created.owner?.id, created.scope]).toEqual([
      'draft',
      acme.owner.userId,
      { frozen: false, version: 0, frozenAt: null, caseCount: 3 },
    ]);
    expect(errorOf(await createPlan({ name: 'checkout PLAN' })).code).toBe('DUPLICATE_RESOURCE');
    expect(errorOf(await action(created.id, 'complete')).code).toBe('INVALID_STATE_TRANSITION');

    const started = ok<Plan>(await action(created.id, 'start'));
    expect([
      started.status,
      started.scope.frozen,
      started.scope.version,
      started.scope.caseCount,
    ]).toEqual(['active', true, 1, 3]);
    const c4 = await testCase(checkout, 'Pay with wallet');
    expect((await get(created.id)).scope.caseCount).toBe(3);
    expect(errorOf(await patch(created.id, { suiteIds: [] })).code).toBe('CONFLICT');
    ok(await patch(created.id, { description: 'Still editable' }));

    const r = await run('Checkout run', [c1, c2, c3]);
    const attached = ok<Plan>(
      await post(`/api/v1/test-plans/${created.id}/runs`, { testRunId: r.id }),
    );
    expect(attached.runs.map((entry) => entry.id)).toEqual([r.id]);
    await record(r.id, r.runCase(c1), 'passed');
    await record(r.id, r.runCase(c2), 'failed');
    await owner.defect.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'D-1',
        title: 'Voucher fails',
        testRunId: r.id,
      },
    });
    const measured = await progress(created.id);
    expect([
      measured.counts.passed,
      measured.counts.failed,
      measured.counts.untested,
      measured.counts.total,
    ]).toEqual([1, 1, 1, 3]);
    expect([
      measured.completion,
      measured.passRate,
      measured.coverage.percent,
      measured.defects,
    ]).toEqual([66.7, 50, 100, { open: 1, total: 1, items: expect.any(Array) }]);
    expect(measured.cases.find((entry) => entry.key.endsWith('-3'))?.source).toBe('direct');

    const refreshed = ok<Plan>(await action(created.id, 'scope/refresh'));
    expect([refreshed.scope.version, refreshed.scope.caseCount]).toEqual([2, 4]);
    const after = await progress(created.id);
    expect([after.counts.total, after.counts.untested, after.coverage.planned]).toEqual([4, 2, 3]);
    expect(
      await owner.testPlanScopeItem.count({ where: { planId: created.id, scopeVersion: 1 } }),
    ).toBe(3);
    expect(c4).toBeTruthy();

    ok(await action(created.id, 'complete'));
    expect(errorOf(await patch(created.id, { description: 'Late' })).code).toBe('CONFLICT');
    expect(
      errorOf(await post(`/api/v1/test-plans/${created.id}/runs`, { testRunId: r.id })).code,
    ).toBe('CONFLICT');
    ok(await action(created.id, 'archive'));
    expect(errorOf(await action(created.id, 'start')).code).toBe('INVALID_STATE_TRANSITION');
    const listed = (filter: string) =>
      request('GET', `/api/v1/test-plans?projectId=${acme.projectId}${filter}`, as(acme.owner));
    expect(ok<{ data: Plan[] }>(await listed('')).data).toEqual([]);
    expect(ok<{ data: Plan[] }>(await listed('&status=archived')).data).toHaveLength(1);
    expect(
      ok<{ data: Plan[] }>(await listed(`&releaseId=${r1}&status=archived`)).data,
    ).toHaveLength(1);
    expect(
      ok<{ data: Plan[] }>(await listed(`&environmentId=${staging}&status=archived`)).data,
    ).toHaveLength(1);
    expect(
      ok<{ data: Plan[] }>(await listed(`&ownerId=${acme.owner.userId}&status=archived`)).data,
    ).toHaveLength(1);
    expect((await progress(created.id)).counts.total).toBe(4);
    expect(await owner.auditLog.count({ where: { entityType: 'TestPlan' } })).toBe(7);
    await expect(
      owner.$executeRawUnsafe(
        `SET ROLE qaflow_app; UPDATE test_plan_scope_items SET "caseTitle" = 'x'`,
      ),
    ).rejects.toThrow();
  });

  it('refuses suites, cases, runs, releases and environments of other projects and tenants', async () => {
    const project = ok<{ id: string }>(
      await post('/api/v1/projects', { name: 'Mobile', key: 'MOB' }),
      201,
    ).id;
    const mobileSuite = await suite('Mobile suite', acme, project);
    const mobileCase = await testCase(mobileSuite, 'Mobile login');
    const mobileEnv = await env('m-qa', acme, project);
    const globexSuite = await suite('Globex suite', globex);
    const globexCase = await testCase(globexSuite, 'Globex login', globex);
    const globexRun = await run('Globex run', [globexCase], globex);
    const mobileRun = await run('Mobile run', [mobileCase], acme, project);
    const globexRelease = await release('9.0.0', globex);
    const globexEnv = await env('g-qa', globex);

    expect((await createPlan({ name: 'Plan P1', suiteIds: [mobileSuite] })).statusCode).toBe(404);
    expect((await createPlan({ name: 'Plan P2', testCaseIds: [globexCase] })).statusCode).toBe(404);
    expect((await createPlan({ name: 'Plan P3', releaseId: globexRelease })).statusCode).toBe(404);
    expect((await createPlan({ name: 'Plan P4', environmentIds: [globexEnv] })).statusCode).toBe(
      404,
    );
    expect((await createPlan({ name: 'Plan P5', environmentIds: [mobileEnv] })).statusCode).toBe(
      404,
    );
    const ours = await plan({ name: 'Ours' });
    expect(
      (await post(`/api/v1/test-plans/${ours.id}/runs`, { testRunId: globexRun.id })).statusCode,
    ).toBe(404);
    expect(
      (await post(`/api/v1/test-plans/${ours.id}/runs`, { testRunId: mobileRun.id })).statusCode,
    ).toBe(404);
    expect((await patch(ours.id, { testCaseIds: [mobileCase] })).statusCode).toBe(404);

    const theirs = ok<Plan>(
      await post(
        '/api/v1/test-plans',
        { projectId: globex.projectId, name: 'Theirs' },
        globex.owner,
        globex,
      ),
      201,
    );
    expect(
      (await request('GET', `/api/v1/test-plans/${theirs.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect((await patch(theirs.id, { name: 'Hijacked' })).statusCode).toBe(404);
    expect(
      ok<{ data: Plan[] }>(
        await request('GET', `/api/v1/test-plans?projectId=${globex.projectId}`, as(acme.owner)),
      ).data,
    ).toEqual([]);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await request('GET', `/api/v1/test-plans/${ours.id}`, as(hidden))).statusCode).toBe(
      404,
    );
    expect(errorOf(await createPlan({ name: 'Plan P6', ownerId: hidden.userId })).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(await owner.testPlan.count({ where: { projectId: acme.projectId } })).toBe(1);
  });

  it('serialises concurrent edits, starts and run attachments, and enforces permissions', async () => {
    const checkout = await suite('Checkout');
    const c1 = await testCase(checkout, 'Pay with card');
    const first = await plan({ name: 'First', suiteIds: [checkout] });
    const second = await plan({ name: 'Second', suiteIds: [checkout] });

    const edits = await Promise.all(
      ['Renamed A', 'Renamed B'].map((name) => patch(first.id, { name, version: first.version })),
    );
    expect(edits.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const starts = await Promise.all([action(first.id, 'start'), action(first.id, 'start')]);
    expect(starts.map((result) => result.statusCode).sort()).toEqual([200, 422]);
    expect(await owner.testPlanScopeItem.count({ where: { planId: first.id } })).toBe(1);

    const r = await run('Shared run', [c1]);
    const attaches = await Promise.all(
      [first.id, second.id].map((id) => post(`/api/v1/test-plans/${id}/runs`, { testRunId: r.id })),
    );
    expect(attaches.map((result) => result.statusCode).sort()).toEqual([200, 409]);

    const [tester, lead] = await Promise.all([
      acme.addMember('tester', 'tester'),
      acme.addMember('qa_lead', 'lead'),
    ]);
    expect((await request('GET', `/api/v1/test-plans/${second.id}`, as(tester))).statusCode).toBe(
      200,
    );
    expect((await patch(second.id, { description: 'nope' }, tester)).statusCode).toBe(403);
    expect((await createPlan({ name: 'By tester' }, tester)).statusCode).toBe(403);
    const leads = ok<Plan>(await createPlan({ name: 'By lead', suiteIds: [checkout] }, lead), 201);
    expect((await action(leads.id, 'start', {}, lead)).statusCode).toBe(403);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'testruns.create', effect: 'revoke' }] }),
      ),
    );
    expect((await patch(leads.id, { description: 'revoked' }, lead)).statusCode).toBe(403);
    expect((await get(leads.id)).status).toBe('draft');
  });
});
