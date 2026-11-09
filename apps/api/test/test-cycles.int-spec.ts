import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Test cycles (S7-F2), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Test cycles', () => {
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
    counts: { passed: number; failed: number; blocked: number; untested: number; total: number };
    completion: number;
    passRate: number | null;
    coverage: { planned: number; total: number; percent: number };
    cases: Array<{ key: string; status: string; source: string }>;
    defects: { open: number; total: number };
    scope: { frozen: boolean; version?: number; planVersion?: number | null };
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
  const get = async (id: string) =>
    ok<Plan>(await request('GET', `/api/v1/test-plans/${id}`, as(acme.owner)));
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

  interface Cycle {
    id: string;
    status: string;
    version: number;
    release: { id: string } | null;
    runs: Array<{ id: string }>;
    scope: { frozen: boolean; planVersion: number | null; caseCount: number };
  }
  const cycle = async (body: object, account: TestAccount = acme.owner) =>
    post('/api/v1/test-cycles', body, account);
  const cyclePatch = (id: string, body: object, account: TestAccount = acme.owner) =>
    request('PATCH', `/api/v1/test-cycles/${id}`, as(account, body));
  const cycleAction = (
    id: string,
    name: string,
    body: object = {},
    account: TestAccount = acme.owner,
  ) => post(`/api/v1/test-cycles/${id}/${name}`, body, account);
  const getCycle = async (id: string) =>
    ok<Cycle>(await request('GET', `/api/v1/test-cycles/${id}`, as(acme.owner)));
  const cycleProgress = async (id: string) =>
    ok<Progress>(await request('GET', `/api/v1/test-cycles/${id}/progress`, as(acme.owner)));
  const attachToCycle = (id: string, testRunId: string, account: TestAccount = acme.owner) =>
    post(`/api/v1/test-cycles/${id}/runs`, { testRunId }, account);

  it('runs several cycles in one plan, each freezing its own scope and deriving its progress', async () => {
    const checkout = await suite('Checkout');
    const [c1, c2] = [
      await testCase(checkout, 'Pay with card'),
      await testCase(checkout, 'Pay with voucher'),
    ];
    const [staging, prod, qa] = [await env('staging'), await env('prod'), await env('qa')];
    const r1 = await release('1.0.0');
    const p = await plan({
      name: 'Checkout plan',
      suiteIds: [checkout],
      environmentIds: [staging, prod],
      releaseId: r1,
    });
    const early = ok<Cycle>(await cycle({ testPlanId: p.id, name: 'Smoke' }), 201);
    expect([early.status, early.scope, early.release?.id]).toEqual([
      'planned',
      { frozen: false, frozenAt: null, planVersion: null, caseCount: 2 },
      r1,
    ]);
    expect(errorOf(await cycleAction(early.id, 'start')).code).toBe('CONFLICT');
    ok(await action(p.id, 'start'));

    const first = ok<Cycle>(
      await cycle({ testPlanId: p.id, name: 'Cycle 1', environmentId: staging }),
      201,
    );
    const second = ok<Cycle>(
      await cycle({ testPlanId: p.id, name: 'Cycle 2', environmentId: prod }),
      201,
    );
    expect(errorOf(await cycle({ testPlanId: p.id, name: 'cycle 1' })).code).toBe(
      'DUPLICATE_RESOURCE',
    );
    expect(
      errorOf(await cycle({ testPlanId: p.id, name: 'Cycle QA', environmentId: qa })).code,
    ).toBe('VALIDATION_ERROR');
    const started = ok<Cycle>(await cycleAction(first.id, 'start'));
    expect([
      started.status,
      started.scope.frozen,
      started.scope.planVersion,
      started.scope.caseCount,
    ]).toEqual(['active', true, 1, 2]);

    const c3 = await testCase(checkout, 'Pay with wallet');
    ok(await action(p.id, 'scope/refresh'));
    expect((await getCycle(first.id)).scope.caseCount).toBe(2);
    expect((await getCycle(second.id)).scope.caseCount).toBe(3);
    const secondStarted = ok<Cycle>(await cycleAction(second.id, 'start'));
    expect([secondStarted.scope.planVersion, secondStarted.scope.caseCount]).toEqual([2, 3]);
    expect(errorOf(await cyclePatch(first.id, { environmentId: prod })).code).toBe('CONFLICT');
    ok(await cyclePatch(first.id, { description: 'Staging pass' }));

    const a = await run('Run A', [c1, c2]);
    const b = await run('Run B', [c1, c2, c3]);
    expect(ok<Cycle>(await attachToCycle(first.id, a.id)).runs.map((entry) => entry.id)).toEqual([
      a.id,
    ]);
    ok(await attachToCycle(second.id, b.id));
    expect((await get(p.id)).runs.map((entry) => entry.id).sort()).toEqual([a.id, b.id].sort());
    expect(errorOf(await attachToCycle(second.id, a.id)).code).toBe('CONFLICT');
    expect(
      errorOf(await request('DELETE', `/api/v1/test-plans/${p.id}/runs/${a.id}`, as(acme.owner)))
        .code,
    ).toBe('CONFLICT');
    await record(a.id, a.runCase(c1), 'passed');
    await record(a.id, a.runCase(c2), 'failed');
    await record(b.id, b.runCase(c1), 'blocked');
    await owner.defect.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'D-1',
        title: 'Voucher fails',
        testRunId: a.id,
      },
    });
    const one = await cycleProgress(first.id);
    expect([one.counts.passed, one.counts.failed, one.counts.untested, one.counts.total]).toEqual([
      1, 1, 0, 2,
    ]);
    expect([one.completion, one.passRate, one.coverage.percent, one.defects.total]).toEqual([
      100, 50, 100, 1,
    ]);
    const two = await cycleProgress(second.id);
    expect([
      two.counts.blocked,
      two.counts.untested,
      two.counts.total,
      two.coverage.planned,
      two.defects.total,
    ]).toEqual([1, 2, 3, 3, 0]);

    ok(await cycleAction(first.id, 'complete'));
    expect(errorOf(await cyclePatch(first.id, { description: 'Late' })).code).toBe('CONFLICT');
    expect(errorOf(await cycleAction(first.id, 'cancel')).code).toBe('INVALID_STATE_TRANSITION');
    ok(await cycleAction(second.id, 'cancel'));
    expect(errorOf(await attachToCycle(second.id, (await run('Run C', [c1])).id)).code).toBe(
      'CONFLICT',
    );
    ok(await cycleAction(first.id, 'archive'));
    ok(await cycleAction(second.id, 'archive'));
    const archived = await cycleProgress(first.id);
    expect([archived.counts.passed, archived.counts.failed, archived.scope.planVersion]).toEqual([
      1, 1, 1,
    ]);
    const listed = (filter: string) =>
      request('GET', `/api/v1/test-cycles?testPlanId=${p.id}${filter}`, as(acme.owner));
    expect(ok<{ data: Cycle[] }>(await listed('')).data).toHaveLength(3);
    expect(ok<{ data: Cycle[] }>(await listed('&status=archived')).data).toHaveLength(2);
    expect(
      ok<{ data: Cycle[] }>(await listed(`&environmentId=${staging}`)).data.map(
        (entry) => entry.id,
      ),
    ).toEqual([first.id]);
    expect(await owner.testCycleScopeItem.count({ where: { cycleId: first.id } })).toBe(2);
    expect(await owner.auditLog.count({ where: { entityType: 'TestCycle' } })).toBe(12);
    await expect(
      owner.$executeRawUnsafe(
        `SET ROLE qaflow_app; UPDATE test_cycle_scope_items SET "caseTitle" = 'x'`,
      ),
    ).rejects.toThrow();
  });

  it('hides cycles, plans, runs, releases and environments of other projects and tenants', async () => {
    const checkout = await suite('Checkout');
    const c1 = await testCase(checkout, 'Pay with card');
    const ours = await plan({ name: 'Ours', suiteIds: [checkout] });
    const elsewhere = await plan({ name: 'Elsewhere', suiteIds: [checkout] });
    const project = ok<{ id: string }>(
      await post('/api/v1/projects', { name: 'Mobile', key: 'MOB' }),
      201,
    ).id;
    const mobileEnv = await env('m-qa', acme, project);
    const mobileSuite = await suite('Mobile suite', acme, project);
    const mobileRun = await run(
      'Mobile run',
      [await testCase(mobileSuite, 'Mobile login')],
      acme,
      project,
    );
    const globexCase = await testCase(await suite('Globex suite', globex), 'Globex login', globex);
    const globexRun = await run('Globex run', [globexCase], globex);
    const globexRelease = await release('9.0.0', globex);
    const theirPlan = ok<Plan>(
      await post(
        '/api/v1/test-plans',
        { projectId: globex.projectId, name: 'Theirs' },
        globex.owner,
        globex,
      ),
      201,
    );
    const theirs = ok<Cycle>(
      await post(
        '/api/v1/test-cycles',
        { testPlanId: theirPlan.id, name: 'Their cycle' },
        globex.owner,
        globex,
      ),
      201,
    );

    expect((await cycle({ testPlanId: theirPlan.id, name: 'Hijack' })).statusCode).toBe(404);
    expect(
      (await cycle({ testPlanId: ours.id, name: 'Mobile env', environmentId: mobileEnv }))
        .statusCode,
    ).toBe(404);
    expect(
      (await cycle({ testPlanId: ours.id, name: 'Globex release', releaseId: globexRelease }))
        .statusCode,
    ).toBe(404);
    expect(
      (await request('GET', `/api/v1/test-cycles/${theirs.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect((await cyclePatch(theirs.id, { name: 'Hijacked' })).statusCode).toBe(404);
    expect(
      (await request('GET', `/api/v1/test-cycles?testPlanId=${theirPlan.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(404);
    const mine = ok<Cycle>(await cycle({ testPlanId: ours.id, name: 'Mine' }), 201);
    expect((await attachToCycle(mine.id, globexRun.id)).statusCode).toBe(404);
    expect((await attachToCycle(mine.id, mobileRun.id)).statusCode).toBe(404);
    const foreign = await run('Other plan run', [c1]);
    ok(await post(`/api/v1/test-plans/${elsewhere.id}/runs`, { testRunId: foreign.id }));
    expect(errorOf(await attachToCycle(mine.id, foreign.id)).code).toBe('CONFLICT');
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await request('GET', `/api/v1/test-cycles/${mine.id}`, as(hidden))).statusCode).toBe(
      404,
    );
    expect(
      (await request('GET', `/api/v1/test-cycles?testPlanId=${ours.id}`, as(hidden))).statusCode,
    ).toBe(404);
    expect(await owner.testCycle.count({ where: { projectId: acme.projectId } })).toBe(1);
  });

  it('serialises concurrent edits, starts and runs, and enforces permissions', async () => {
    const checkout = await suite('Checkout');
    const c1 = await testCase(checkout, 'Pay with card');
    const p = await plan({ name: 'Concurrent plan', suiteIds: [checkout] });
    ok(await action(p.id, 'start'));
    const first = ok<Cycle>(await cycle({ testPlanId: p.id, name: 'First' }), 201);
    const second = ok<Cycle>(await cycle({ testPlanId: p.id, name: 'Second' }), 201);

    const edits = await Promise.all(
      ['Renamed A', 'Renamed B'].map((name) =>
        cyclePatch(first.id, { name, version: first.version }),
      ),
    );
    expect(edits.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const starts = await Promise.all([
      cycleAction(first.id, 'start'),
      cycleAction(first.id, 'start'),
    ]);
    expect(starts.map((result) => result.statusCode).sort()).toEqual([200, 422]);
    expect(await owner.testCycleScopeItem.count({ where: { cycleId: first.id } })).toBe(1);
    const shared = await run('Shared run', [c1]);
    const attaches = await Promise.all(
      [first.id, second.id].map((id) => attachToCycle(id, shared.id)),
    );
    expect(attaches.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await owner.testPlanRun.count({ where: { testRunId: shared.id } })).toBe(1);

    const [tester, lead] = await Promise.all([
      acme.addMember('tester', 'tester'),
      acme.addMember('qa_lead', 'lead'),
    ]);
    expect((await request('GET', `/api/v1/test-cycles/${second.id}`, as(tester))).statusCode).toBe(
      200,
    );
    expect((await cycle({ testPlanId: p.id, name: 'By tester' }, tester)).statusCode).toBe(403);
    expect((await cyclePatch(second.id, { description: 'nope' }, tester)).statusCode).toBe(403);
    const leads = ok<Cycle>(await cycle({ testPlanId: p.id, name: 'By lead' }, lead), 201);
    expect((await cycleAction(leads.id, 'start', {}, lead)).statusCode).toBe(403);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'testruns.create', effect: 'revoke' }] }),
      ),
    );
    expect((await cyclePatch(leads.id, { description: 'revoked' }, lead)).statusCode).toBe(403);
    expect((await attachToCycle(leads.id, (await run('Lead run', [c1])).id, lead)).statusCode).toBe(
      403,
    );
    expect((await getCycle(leads.id)).status).toBe('planned');
  });
});
