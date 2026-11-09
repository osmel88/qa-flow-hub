import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Parameterized test cases (S7-F3), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Parameterized test cases', () => {
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
  const record = async (runId: string, runCaseId: string, status: string) =>
    ok(await post(`/api/v1/test-runs/${runId}/cases/${runCaseId}/results`, { status }), 201);

  interface RunCase {
    id: string;
    testCaseId: string;
    latestStatus: string;
    caseVersion: number;
    snapshot: { parameters?: Array<{ name: string }> };
    iteration: {
      rowId: string;
      label: string;
      index: number;
      values: Record<string, unknown>;
    } | null;
  }
  interface CaseDetail {
    id: string;
    version: number;
    parameters: Array<{ name: string; type: string }>;
    dataset: Array<{ id: string; label: string; values: Record<string, unknown> }>;
  }
  const PARAMETERS = [
    { name: 'user', type: 'string', required: true },
    { name: 'amount', type: 'number', defaultValue: 10 },
    { name: 'vip', type: 'boolean' },
    { name: 'day', type: 'date' },
  ];
  const ROWS = [
    { label: 'Regular', values: { user: 'ann', amount: 5, vip: false, day: '2027-01-31' } },
    { label: 'VIP', values: { user: 'bob', vip: true } },
    { values: { user: 'cid', amount: 99.5 } },
  ];
  const put = (id: string, body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request('PUT', `/api/v1/test-cases/${id}/parameters`, as(account, body, workspace));
  const detail = async (id: string) =>
    ok<CaseDetail>(await request('GET', `/api/v1/test-cases/${id}`, as(acme.owner)));
  const runCases = async (runId: string, filter = '') =>
    ok<{ data: RunCase[] }>(
      await request(
        'GET',
        `/api/v1/test-runs/${runId}/cases?pageSize=100${filter}`,
        as(acme.owner),
      ),
    ).data;
  const newRun = async (name: string, testCaseIds: string[]) =>
    ok<{ id: string }>(
      await post('/api/v1/test-runs', {
        projectId: acme.projectId,
        name,
        selection: { testCaseIds },
      }),
      201,
    ).id;

  it('rejects invalid datasets, wrong types and missing values', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const bad = [
      { parameters: PARAMETERS, rows: [{ values: { amount: 1 } }] },
      { parameters: PARAMETERS, rows: [{ values: { user: 'a', amount: 'ten' } }] },
      { parameters: PARAMETERS, rows: [{ values: { user: 'a', vip: 'yes' } }] },
      { parameters: PARAMETERS, rows: [{ values: { user: 'a', day: '2027-02-30' } }] },
      { parameters: PARAMETERS, rows: [{ values: { user: 'a', ghost: 1 } }] },
      { parameters: [...PARAMETERS, { name: 'USER', type: 'string' }], rows: [] },
      { parameters: [{ name: 'n', type: 'number', defaultValue: 'x' }], rows: [] },
      { parameters: [{ name: '_x', type: 'string' }], rows: [] },
      { parameters: [], rows: [{ values: {} }] },
    ];
    for (const body of bad) {
      expect((await put(id, body)).statusCode).toBe(400);
    }
    const missing = await put(id, { parameters: PARAMETERS, rows: [{ label: 'L', values: {} }] });
    expect([missing.statusCode, missing.body.includes('user is required')]).toEqual([400, true]);
    expect((await detail(id)).version).toBe(1);
  });

  it('expands one execution per row with frozen values, independent results and filters', async () => {
    const checkout = await suite('Checkout');
    const pay = await testCase(checkout, 'Pay');
    const plain = await testCase(checkout, 'Browse');
    const saved = ok<CaseDetail>(
      await put(pay, { parameters: PARAMETERS, rows: ROWS, version: 1 }),
    );
    expect([saved.version, saved.dataset.length, saved.dataset[2]!.label]).toEqual([2, 3, 'Row 3']);
    const runId = await newRun('Param run', [pay, plain]);
    const cases = await runCases(runId);
    expect(cases).toHaveLength(4);
    const iterations = cases.filter((entry) => entry.iteration !== null);
    expect(iterations.map((entry) => entry.iteration!.label)).toEqual(['Regular', 'VIP', 'Row 3']);
    expect(iterations[1]!.iteration!.values).toEqual({
      user: 'bob',
      amount: 10,
      vip: true,
      day: null,
    });
    expect(iterations[0]!.snapshot.parameters?.map((entry) => entry.name)).toEqual([
      'user',
      'amount',
      'vip',
      'day',
    ]);
    await record(runId, iterations[0]!.id, 'passed');
    await record(runId, iterations[1]!.id, 'failed');
    const after = await runCases(runId, '&parameterized=true');
    expect(after.map((entry) => entry.latestStatus)).toEqual(['passed', 'failed', 'untested']);
    const vip = await runCases(runId, `&datasetRowId=${saved.dataset[1]!.id}`);
    expect(vip.map((entry) => entry.iteration!.label)).toEqual(['VIP']);
    expect(
      (await runCases(runId, '&parameterized=false')).map((entry) => entry.testCaseId),
    ).toEqual([plain]);
    // Plans count a parameterized case once, with its worst row.
    const planId = ok<{ id: string }>(
      await post('/api/v1/test-plans', {
        projectId: acme.projectId,
        name: 'Param plan',
        testCaseIds: [pay],
      }),
      201,
    ).id;
    ok(await post(`/api/v1/test-plans/${planId}/runs`, { testRunId: runId }));
    const planProgress = ok<{ counts: { failed: number; total: number } }>(
      await request('GET', `/api/v1/test-plans/${planId}/progress`, as(acme.owner)),
    );
    expect([planProgress.counts.failed, planProgress.counts.total]).toEqual([1, 1]);
  });

  it('keeps executed values when the dataset changes and the database refuses rewrites', async () => {
    const pay = await testCase(await suite('Checkout'), 'Pay');
    ok(await put(pay, { parameters: PARAMETERS, rows: ROWS }));
    const first = await newRun('Before edit', [pay]);
    const before = await runCases(first);
    await record(first, before[0]!.id, 'passed');
    const current = await detail(pay);
    ok(
      await put(pay, {
        parameters: PARAMETERS,
        rows: [{ id: current.dataset[0]!.id, label: 'Regular', values: { user: 'zed' } }],
        version: current.version,
      }),
    );
    const history = await runCases(first);
    expect(history.map((entry) => entry.iteration!.values['user'])).toEqual(['ann', 'bob', 'cid']);
    expect(history[0]!.latestStatus).toBe('passed');
    const second = await runCases(await newRun('After edit', [pay]));
    expect(second.map((entry) => entry.iteration!.values['user'])).toEqual(['zed']);
    expect(second[0]!.caseVersion).toBe(current.version + 1);
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE "test_run_cases" SET "parameterValues" = '{"user":"evil"}' WHERE "id" = $1`,
        history[0]!.id,
      ),
    ).rejects.toThrow(/immutable/);
    // A stale editor cannot overwrite a newer definition.
    expect(
      (await put(pay, { parameters: PARAMETERS, rows: ROWS, version: current.version })).statusCode,
    ).toBe(409);
  });

  it('serializes concurrent edits and records concurrent results per row', async () => {
    const pay = await testCase(await suite('Checkout'), 'Pay');
    ok(await put(pay, { parameters: PARAMETERS, rows: ROWS }));
    const version = (await detail(pay)).version;
    const edits = await Promise.all([
      put(pay, { parameters: PARAMETERS, rows: ROWS.slice(0, 1), version }),
      put(pay, { parameters: PARAMETERS, rows: ROWS.slice(0, 2), version }),
    ]);
    expect(edits.map((entry) => entry.statusCode).sort()).toEqual([200, 409]);
    expect((await detail(pay)).version).toBe(version + 1);
    const runId = await newRun('Concurrent', [pay]);
    const cases = await runCases(runId);
    const results = await Promise.all(
      cases.map((entry, index) =>
        post(`/api/v1/test-runs/${runId}/cases/${entry.id}/results`, {
          status: index === 0 ? 'failed' : 'passed',
        }),
      ),
    );
    expect(results.map((entry) => entry.statusCode)).toEqual(cases.map(() => 201));
    expect((await runCases(runId)).map((entry) => entry.latestStatus)).toEqual(
      cases.map((_, index) => (index === 0 ? 'failed' : 'passed')),
    );
  });

  it('hides other tenants and hidden projects, and honours revoked permissions', async () => {
    const pay = await testCase(await suite('Checkout'), 'Pay');
    ok(await put(pay, { parameters: PARAMETERS, rows: ROWS }));
    const body = { parameters: PARAMETERS, rows: ROWS };
    expect((await put(pay, body, globex.owner, globex)).statusCode).toBe(404);
    expect(
      (
        await request(
          'GET',
          `/api/v1/test-cases/${pay}/dataset/export.csv`,
          as(globex.owner, undefined, globex),
        )
      ).statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('qa_lead', 'hidden', { projectAccess: false });
    expect((await put(pay, body, hidden)).statusCode).toBe(404);
    const lead = await acme.addMember('qa_lead', 'lead');
    ok(await put(pay, body, lead));
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'test_design.write', effect: 'revoke' }] }),
      ),
    );
    expect((await put(pay, body, lead)).statusCode).toBe(403);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await put(pay, body, viewer)).statusCode).toBe(403);
    const audit = await owner.auditLog.count({ where: { entityType: 'TestCase', entityId: pay } });
    expect(audit).toBeGreaterThanOrEqual(3);
  });

  it('round-trips the dataset through CSV and rejects bad files', async () => {
    const pay = await testCase(await suite('Checkout'), 'Pay');
    const empty = await request(
      'POST',
      `/api/v1/test-cases/${pay}/dataset/import`,
      as(acme.owner, { csv: 'user\nann\n' }),
    );
    expect(empty.statusCode).toBe(400);
    ok(await put(pay, { parameters: PARAMETERS, rows: ROWS }));
    const before = await detail(pay);
    const exported = await request(
      'GET',
      `/api/v1/test-cases/${pay}/dataset/export.csv`,
      as(acme.owner),
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      '_id,_label,user,amount,vip,day',
    );
    const imported = ok<CaseDetail>(
      await request(
        'POST',
        `/api/v1/test-cases/${pay}/dataset/import`,
        as(acme.owner, { csv: exported.body, version: before.version }),
      ),
    );
    expect(imported.dataset).toEqual(before.dataset);
    expect(imported.version).toBe(before.version + 1);
    for (const csv of [
      '_label,user,amount\nA,ann,ten\n',
      '_label,user,ghost\nA,ann,1\n',
      '_label,user,vip\nA,ann,maybe\n',
      '_label,amount\nA,3\n',
      '_label,user\n"A,ann\n',
    ]) {
      const response = await request(
        'POST',
        `/api/v1/test-cases/${pay}/dataset/import`,
        as(acme.owner, { csv }),
      );
      expect(response.statusCode, csv).toBe(400);
    }
    expect((await detail(pay)).dataset).toEqual(before.dataset);
  });
});
