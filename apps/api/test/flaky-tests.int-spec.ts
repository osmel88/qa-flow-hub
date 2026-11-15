import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Flaky test detection (S7-F6), with the API connected as `qaflow_app` so the
 * window query and the marks run under Row Level Security. The owner
 * connection only asserts state.
 */
describe('Flaky test detection', () => {
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

  interface Row {
    testCase: { id: string; key: string };
    status: string;
    detectedStatus: string;
    executions: number;
    passRate: number | null;
    failRate: number | null;
    flips: number;
    flipRate: number | null;
    confirmed: boolean;
    dismissed: boolean;
    automatedExecutions: number;
    manualExecutions: number;
    mark: { state: string } | null;
  }
  interface Detail extends Row {
    rules: { window: number; minExecutions: number };
    history: Array<{
      resultId: string;
      status: string;
      source: string;
      run: { id: string };
      runCaseId: string;
      flip: boolean;
      iterationKey: string;
      caseVersion: number;
    }>;
    marks: Array<{ state: string; reason: string }>;
  }
  const BASE = '/api/v1/flaky-tests';
  const list = async (filter = '', account = acme.owner) =>
    ok<{ data: Row[]; meta: { total: number } }>(
      await get(`${BASE}?projectId=${acme.projectId}${filter}`, account),
    );
  const detail = async (id: string, filter = '') => ok<Detail>(await get(`${BASE}/${id}${filter}`));
  const mark = (id: string, state: string, account = acme.owner, reason = 'Reviewed by QA') =>
    post(`${BASE}/${id}/marks`, { state, reason }, account);

  let suiteId = '';
  const testCase = async (title: string): Promise<{ id: string; key: string }> => {
    if (suiteId === '') {
      suiteId = ok<{ id: string }>(
        await post('/api/v1/test-suites', { projectId: acme.projectId, name: 'Checkout' }),
        201,
      ).id;
    }
    return ok(await post('/api/v1/test-cases', { suiteId, title }), 201);
  };
  beforeEach(() => {
    suiteId = '';
  });

  const STATUS: Record<string, string> = { P: 'passed', F: 'failed', B: 'blocked', S: 'skipped' };
  /** One manual run per step, recording `pattern[i]` for every case. */
  const execute = async (patterns: Record<string, string>) => {
    const ids = Object.keys(patterns);
    const length = Math.max(...Object.values(patterns).map((pattern) => pattern.length));
    const runs: string[] = [];
    for (let step = 0; step < length; step += 1) {
      const runId = ok<{ id: string }>(
        await post('/api/v1/test-runs', {
          projectId: acme.projectId,
          name: `Manual run ${step}`,
          selection: { testCaseIds: ids.filter((id) => patterns[id]?.[step] !== undefined) },
        }),
        201,
      ).id;
      runs.push(runId);
      const cases = ok<{
        data: Array<{ id: string; testCaseId: string; iteration: { rowId: string } | null }>;
      }>(await get(`/api/v1/test-runs/${runId}/cases?pageSize=100`)).data;
      for (const runCase of cases) {
        const char = patterns[runCase.testCaseId]?.[step];
        if (char !== undefined) {
          ok(
            await post(`/api/v1/test-runs/${runId}/cases/${runCase.id}/results`, {
              status: STATUS[char],
            }),
            201,
          );
        }
      }
    }
    return runs;
  };

  it('classifies cases with the documented window, threshold and flip rules', async () => {
    const flaky = await testCase('Pay with card');
    const failing = await testCase('Refund');
    const stable = await testCase('Login');
    const few = await testCase('Logout');
    const noisy = await testCase('Search');
    await execute({
      [flaky.id]: 'PFPFPF',
      [failing.id]: 'PPFFF',
      [stable.id]: 'PPPPP',
      [few.id]: 'PF',
      [noisy.id]: 'PBPSF',
    });

    const all = await list();
    const byId = new Map(all.data.map((row) => [row.testCase.id, row]));
    expect(byId.get(flaky.id)).toMatchObject({
      status: 'flaky',
      executions: 6,
      flips: 5,
      flipRate: 1,
      passRate: 0.5,
    });
    expect(byId.get(failing.id)).toMatchObject({ status: 'failing', flips: 1, failRate: 0.6 });
    expect(byId.get(stable.id)).toMatchObject({ status: 'stable', failRate: 0, flips: 0 });
    // Too few signal results never reads flaky; blocked and skipped are not signal.
    expect(byId.get(few.id)).toMatchObject({ status: 'insufficient_data', executions: 2 });
    expect(byId.get(noisy.id)).toMatchObject({ status: 'insufficient_data', executions: 3 });
    expect(all.data[0]?.testCase.id).toBe(flaky.id);
    expect((await list('&status=flaky')).data.map((row) => row.testCase.id)).toEqual([flaky.id]);
    expect((await list('&sort=failRate&order=desc')).data[0]?.testCase.id).toBe(failing.id);
    expect((await list('&q=refund')).data.map((row) => row.testCase.id)).toEqual([failing.id]);
    expect((await list('&pageSize=2')).meta.total).toBe(5);

    // Traceability: every history entry points to its real run, run case and result.
    const trace = await detail(flaky.id);
    expect(trace.rules).toMatchObject({ window: 20, minExecutions: 5 });
    expect(trace.history).toHaveLength(6);
    expect(trace.history.filter((entry) => entry.flip)).toHaveLength(5);
    for (const entry of trace.history) {
      const result = await owner.testResult.findUniqueOrThrow({ where: { id: entry.resultId } });
      expect(result).toMatchObject({
        testRunId: entry.run.id,
        testRunCaseId: entry.runCaseId,
        status: entry.status,
      });
    }

    // Recalculated on read: two more results turn the stable failure flaky.
    await execute({ [failing.id]: 'PF' });
    expect((await detail(failing.id)).status).toBe('flaky');

    // A deleted case leaves the list and reads as nonexistent.
    expect(
      (await request('DELETE', `/api/v1/test-cases/${stable.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect((await list()).data.some((row) => row.testCase.id === stable.id)).toBe(false);
    expect((await get(`${BASE}/${stable.id}`)).statusCode).toBe(404);
  });

  it('ignores outcome changes across case versions and keeps dataset rows apart', async () => {
    const edited = await testCase('Checkout total');
    await execute({ [edited.id]: 'FFF' });
    ok(
      await request(
        'PATCH',
        `/api/v1/test-cases/${edited.id}`,
        as(acme.owner, { title: 'Checkout total v2' }),
      ),
    );
    await execute({ [edited.id]: 'PPP' });
    const versions = await detail(edited.id);
    expect(versions).toMatchObject({ status: 'stable', executions: 6, flips: 0 });
    expect(new Set(versions.history.map((entry) => entry.caseVersion)).size).toBe(2);

    const rows = await testCase('Currency');
    ok(
      await request(
        'PUT',
        `/api/v1/test-cases/${rows.id}/parameters`,
        as(acme.owner, {
          parameters: [{ name: 'currency', type: 'string', required: true }],
          rows: [
            { label: 'EUR', values: { currency: 'EUR' } },
            { label: 'USD', values: { currency: 'USD' } },
          ],
        }),
      ),
    );
    // Each run expands into two executions; the first gets P, the second F.
    for (let step = 0; step < 3; step += 1) {
      const runId = ok<{ id: string }>(
        await post('/api/v1/test-runs', {
          projectId: acme.projectId,
          name: `Rows ${step}`,
          selection: { testCaseIds: [rows.id] },
        }),
        201,
      ).id;
      const cases = ok<{ data: Array<{ id: string; iteration: { index: number } }> }>(
        await get(`/api/v1/test-runs/${runId}/cases?pageSize=100`),
      ).data.sort((a, b) => a.iteration.index - b.iteration.index);
      for (const [index, runCase] of cases.entries()) {
        ok(
          await post(`/api/v1/test-runs/${runId}/cases/${runCase.id}/results`, {
            status: index === 0 ? 'passed' : 'failed',
          }),
          201,
        );
      }
    }
    const perRow = await detail(rows.id);
    expect(perRow).toMatchObject({ executions: 6, flips: 0, status: 'failing' });
    expect(new Set(perRow.history.map((entry) => entry.iterationKey)).size).toBe(2);
  });

  it('combines manual and automated results and filters by source', async () => {
    const shared = await testCase('Pay with wallet');
    const createKey = ok<{ token: string }>(
      await post(`/api/v1/projects/${acme.projectId}/api-keys`, { name: 'CI' }),
      201,
    );
    const boundary = 'qa-flow-hub-flaky';
    for (const [index, failed] of [false, true, false].entries()) {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><testsuites name="ci-${index}"><testsuite name="pay">` +
        `<testcase classname="pay.spec" name="${shared.key} pays" time="1">${failed ? '<failure message="boom"/>' : ''}</testcase>` +
        `</testsuite></testsuites>`;
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/ingest/junit?runName=CI%20${index}`,
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="junit.xml"\r\nContent-Type: application/xml\r\n\r\n`,
          ),
          Buffer.from(xml),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: {
          authorization: `Bearer ${createKey.token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await execute({ [shared.id]: 'FPF' });

    const all = await detail(shared.id);
    expect(all).toMatchObject({
      status: 'flaky',
      executions: 6,
      automatedExecutions: 3,
      manualExecutions: 3,
      flips: 5,
    });
    expect(all.history.slice(3).every((entry) => entry.source === 'automation')).toBe(true);
    expect(all.history.slice(0, 3).every((entry) => entry.source === 'manual')).toBe(true);
    expect(await detail(shared.id, '?source=automation')).toMatchObject({
      executions: 3,
      status: 'insufficient_data',
    });
    const manual = (await list('&source=manual')).data[0];
    expect(manual).toMatchObject({ executions: 3, automatedExecutions: 0 });
  });

  it('records append-only marks: confirm, dismiss until a newer flip, clear', async () => {
    const flaky = await testCase('Upload');
    const stable = await testCase('Download');
    await execute({ [flaky.id]: 'PFPFP', [stable.id]: 'PPPPP' });

    expect((await mark(flaky.id, 'not_flaky', acme.owner, 'no')).statusCode).toBe(400);
    expect((await mark(flaky.id, 'wrong')).statusCode).toBe(400);
    const dismissed = ok<Detail>(await mark(flaky.id, 'not_flaky'), 201);
    expect(dismissed).toMatchObject({ status: 'stable', detectedStatus: 'flaky', dismissed: true });
    const confirmed = ok<Detail>(
      await mark(stable.id, 'flaky', acme.owner, 'Known race in CI'),
      201,
    );
    expect(confirmed).toMatchObject({ status: 'flaky', detectedStatus: 'stable', confirmed: true });
    expect((await list('&marked=true')).data).toHaveLength(2);
    expect((await list('&status=flaky')).data.map((row) => row.testCase.id)).toEqual([stable.id]);

    // A flip after the dismissal brings the detection back.
    await execute({ [flaky.id]: 'F' });
    expect(await detail(flaky.id)).toMatchObject({ status: 'flaky', dismissed: false });

    ok(await mark(stable.id, 'cleared'), 201);
    const cleared = await detail(stable.id);
    expect(cleared).toMatchObject({ status: 'stable', confirmed: false });
    expect(cleared.marks.map((entry) => entry.state)).toEqual(['cleared', 'flaky']);
    expect((await list('&marked=true')).data.map((row) => row.testCase.id)).toEqual([flaky.id]);
    expect(
      await owner.auditLog.count({
        where: { entityType: 'TestCase', entityId: stable.id, summary: { contains: 'flaky mark' } },
      }),
    ).toBe(2);

    // The app role can add marks but never rewrite or delete them.
    const appRole = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
    try {
      await expect(
        appRole.$executeRawUnsafe(`UPDATE "test_case_flaky_marks" SET "reason" = 'x'`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        appRole.$executeRawUnsafe(`DELETE FROM "test_case_flaky_marks"`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await appRole.$disconnect();
    }
  });

  it('isolates projects and tenants and honours permissions', async () => {
    const flaky = await testCase('Profile');
    await execute({ [flaky.id]: 'PFPFP' });

    // Another tenant sees nothing and the case does not exist for it.
    expect((await get(`${BASE}/${flaky.id}`, globex.owner, globex)).statusCode).toBe(404);
    expect(
      (
        await post(
          `${BASE}/${flaky.id}/marks`,
          { state: 'flaky', reason: 'Globex says' },
          globex.owner,
          globex,
        )
      ).statusCode,
    ).toBe(404);
    const foreign = await get(`${BASE}?projectId=${acme.projectId}`, globex.owner, globex);
    expect(foreign.statusCode === 404 || foreign.json().data.length === 0).toBe(true);
    // A mark cannot point at a case of another project.
    await expect(
      owner.testCaseFlakyMark.create({
        data: {
          organizationId: globex.organizationId,
          projectId: globex.projectId,
          testCaseId: flaky.id,
          state: 'flaky',
          reason: 'x',
        },
      }),
    ).rejects.toThrow();

    const hidden = await acme.addMember('qa_lead', 'hidden', { projectAccess: false });
    expect((await get(`${BASE}/${flaky.id}`, hidden)).statusCode).toBe(404);
    expect((await mark(flaky.id, 'flaky', hidden)).statusCode).toBe(404);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await list('', viewer)).data).toHaveLength(1);
    expect((await mark(flaky.id, 'flaky', viewer)).statusCode).toBe(403);
    const tester = await acme.addMember('tester', 'tester');
    expect((await mark(flaky.id, 'flaky', tester)).statusCode).toBe(403);
    const lead = await acme.addMember('qa_lead', 'lead');
    ok(await mark(flaky.id, 'flaky', lead), 201);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'test_design.write', effect: 'revoke' }] }),
      ),
    );
    expect((await mark(flaky.id, 'cleared', lead)).statusCode).toBe(403);

    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${viewer.userId}`,
        as(acme.owner, { overrides: [{ permission: 'testruns.read', effect: 'revoke' }] }),
      ),
    );
    expect((await get(`${BASE}/${flaky.id}`, viewer)).statusCode).toBe(403);
    expect((await get(`${BASE}?projectId=${acme.projectId}`, viewer)).statusCode).toBe(403);
  });
});
