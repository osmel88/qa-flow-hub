import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Test case versioning (S7-F4), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Test case versioning', () => {
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
      await post(
        '/api/v1/test-cases',
        { suiteId, title, steps: [{ action: 'Open the cart' }] },
        workspace.owner,
        workspace,
      ),
      201,
    ).id;
  interface Version {
    id: string;
    version: number;
    current: boolean;
    changeReason: string | null;
    restoredFromVersion: number | null;
    author: { id: string; fullName: string } | null;
  }
  interface VersionContent extends Version {
    content: {
      title: string;
      steps: Array<{ action: string }>;
      parameters: Array<{ name: string }>;
      dataset: unknown[];
    };
  }
  interface RunCase {
    id: string;
    caseVersion: number;
    caseVersionId: string | null;
    snapshot: { title: string };
  }
  const patch = (id: string, body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request('PATCH', `/api/v1/test-cases/${id}`, as(account, body, workspace));
  const get = (path: string, account: TestAccount = acme.owner, workspace = acme) =>
    request('GET', path, as(account, undefined, workspace));
  const versions = async (id: string) =>
    ok<Version[]>(await get(`/api/v1/test-cases/${id}/versions`));
  const restore = (id: string, version: number, body: object = {}, account = acme.owner) =>
    post(`/api/v1/test-cases/${id}/versions/${version}/restore`, body, account);
  const newRun = async (name: string, testCaseIds: string[]) =>
    ok<{ id: string }>(
      await post('/api/v1/test-runs', {
        projectId: acme.projectId,
        name,
        selection: { testCaseIds },
      }),
      201,
    ).id;
  const runCases = async (runId: string) =>
    ok<{ data: RunCase[] }>(await get(`/api/v1/test-runs/${runId}/cases?pageSize=100`)).data;
  const versionRow = (testCaseId: string, version: number) =>
    owner.testCaseVersion.findUniqueOrThrow({
      where: { testCaseId_version: { testCaseId, version } },
    });

  it('versions content edits only, with author, reason, history, diff and restore', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay with a card');
    const v1 = await versions(id);
    expect(v1).toMatchObject([{ version: 1, current: true, author: { id: acme.owner.userId } }]);

    expect(
      ok<{ version: number }>(
        await patch(id, {
          title: 'Pay with a saved card',
          changeReason: 'Saved cards',
          version: 1,
        }),
      ).version,
    ).toBe(2);
    // Bookkeeping fields do not create a version.
    expect(
      ok<{ version: number }>(await patch(id, { status: 'active', tags: ['smoke'] })).version,
    ).toBe(2);
    expect(
      ok<{ version: number }>(
        await post(`/api/v1/test-cases/${id}/steps`, {
          steps: [{ action: 'Open the cart' }, { action: 'Pay' }],
          version: 2,
        }),
      ).version,
    ).toBe(3);
    // Saving the same steps again is not a new version either.
    expect(
      ok<{ version: number }>(
        await post(`/api/v1/test-cases/${id}/steps`, {
          steps: [{ action: 'Open the cart' }, { action: 'Pay' }],
        }),
      ).version,
    ).toBe(3);

    const history = await versions(id);
    expect(history.map((row) => [row.version, row.current, row.changeReason])).toEqual([
      [3, true, null],
      [2, false, 'Saved cards'],
      [1, false, null],
    ]);
    const first = ok<VersionContent>(await get(`/api/v1/test-cases/${id}/versions/1`));
    expect(first.content.title).toBe('Pay with a card');
    expect(first.content.steps.map((step) => step.action)).toEqual(['Open the cart']);

    const diff = ok<{
      fields: Array<{ field: string; before: string; after: string }>;
      steps: Array<{ position: number; change: string }>;
      identical: boolean;
    }>(await get(`/api/v1/test-cases/${id}/versions/diff?from=1&to=3`));
    expect(diff.fields).toEqual([
      { field: 'title', before: 'Pay with a card', after: 'Pay with a saved card' },
    ]);
    expect(diff.steps).toEqual([expect.objectContaining({ position: 2, change: 'added' })]);

    const restored = ok<{ version: number; title: string; steps: unknown[] }>(
      await restore(id, 1, { version: 3, reason: 'Saved cards were dropped' }),
    );
    expect([restored.version, restored.title, restored.steps.length]).toEqual([
      4,
      'Pay with a card',
      1,
    ]);
    expect((await versions(id))[0]).toMatchObject({
      version: 4,
      restoredFromVersion: 1,
      changeReason: 'Saved cards were dropped',
    });
    // The older versions are untouched by the restore.
    expect((await versionRow(id, 2)).title).toBe('Pay with a saved card');
    expect((await restore(id, 4)).statusCode).toBe(409);
    expect((await restore(id, 1, { version: 3 })).statusCode).toBe(409);
    expect((await restore(id, 99)).statusCode).toBe(404);
    expect((await get(`/api/v1/test-cases/${id}/versions/abc`)).statusCode).toBe(404);
    expect((await get(`/api/v1/test-cases/${id}/versions/diff?from=1&to=99`)).statusCode).toBe(404);
    const audits = await owner.auditLog.findMany({
      where: { entityType: 'TestCase', entityId: id, action: 'restore' },
    });
    expect(audits.map((row) => row.summary)).toEqual([
      expect.stringContaining('version 1 as version 4'),
    ]);
  });

  it('lets one of two concurrent edits win and rejects stale editors', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const [a, b] = await Promise.all([
      patch(id, { title: 'First editor', version: 1 }),
      patch(id, { title: 'Second editor', version: 1 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await versions(id)).map((row) => row.version)).toEqual([2, 1]);
    // Unversioned concurrent edits serialize into consecutive versions.
    const results = await Promise.all(
      ['One', 'Two', 'Three'].map((title) => patch(id, { title: `Edit ${title}` })),
    );
    expect(results.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect((await versions(id)).map((row) => row.version)).toEqual([5, 4, 3, 2, 1]);
    const concurrentRestores = await Promise.all([
      restore(id, 1, { version: 5 }),
      restore(id, 2, { version: 5 }),
    ]);
    expect(concurrentRestores.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('points runs and results at the exact version, before and after an edit', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const before = await newRun('Before', [id]);
    ok(
      await patch(id, { title: 'Pay twice', steps: [{ action: 'Pay' }, { action: 'Pay again' }] }),
    );
    const after = await newRun('After', [id]);

    const [old] = await runCases(before);
    const [fresh] = await runCases(after);
    expect([old!.caseVersion, old!.caseVersionId]).toEqual([1, (await versionRow(id, 1)).id]);
    expect([fresh!.caseVersion, fresh!.caseVersionId]).toEqual([2, (await versionRow(id, 2)).id]);
    expect(old!.snapshot.title).toBe('Pay');

    // A result recorded on the old run after the edit still cites version 1.
    const result = ok<{ id: string; caseVersion: number }>(
      await post(`/api/v1/test-runs/${before}/cases/${old!.id}/results`, { status: 'failed' }),
      201,
    );
    expect(result.caseVersion).toBe(1);
    expect(
      (await owner.testResult.findUniqueOrThrow({ where: { id: result.id } })).testCaseVersionId,
    ).toBe((await versionRow(id, 1)).id);
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE "test_run_cases" SET "testCaseVersionId" = $1 WHERE "id" = $2`,
        (await versionRow(id, 2)).id,
        old!.id,
      ),
    ).rejects.toThrow(/immutable/);

    // Traceability links the logical case and shows which version ran.
    const requirement = ok<{ id: string }>(
      await post('/api/v1/requirements', { projectId: acme.projectId, title: 'Card payments' }),
      201,
    ).id;
    ok(
      await post('/api/v1/traceability/links', {
        sourceType: 'requirement',
        sourceId: requirement,
        targetType: 'test_case',
        targetId: id,
        linkType: 'verifies',
      }),
      201,
    );
    const matrix = ok<{
      rows: Array<{
        requirementId: string;
        cases: Array<{ id: string; lastExecutedVersion: number }>;
      }>;
    }>(await get(`/api/v1/traceability/matrix?projectId=${acme.projectId}`));
    expect(matrix.rows.find((row) => row.requirementId === requirement)!.cases).toEqual([
      expect.objectContaining({ id, lastExecutedVersion: 1 }),
    ]);
  });

  it('keeps the version frozen in plan and cycle scope', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const planId = ok<{ id: string }>(
      await post('/api/v1/test-plans', {
        projectId: acme.projectId,
        name: 'Release plan',
        testCaseIds: [id],
      }),
      201,
    ).id;
    ok(await post(`/api/v1/test-plans/${planId}/start`, {}));
    const cycleId = ok<{ id: string }>(
      await post('/api/v1/test-cycles', { testPlanId: planId, name: 'Cycle one' }),
      201,
    ).id;
    ok(await post(`/api/v1/test-cycles/${cycleId}/start`, {}));
    ok(await patch(id, { title: 'Pay with a voucher' }));
    expect((await versions(id))[0]!.version).toBe(2);

    const plan = ok<{ cases: Array<{ caseVersion: number }> }>(
      await get(`/api/v1/test-plans/${planId}/progress`),
    );
    const cycle = ok<{ cases: Array<{ caseVersion: number }> }>(
      await get(`/api/v1/test-cycles/${cycleId}/progress`),
    );
    expect([plan.cases[0]!.caseVersion, cycle.cases[0]!.caseVersion]).toEqual([1, 1]);
    const v1 = (await versionRow(id, 1)).id;
    expect(
      (await owner.testPlanScopeItem.findFirstOrThrow({ where: { planId } })).testCaseVersionId,
    ).toBe(v1);
    expect(
      (await owner.testCycleScopeItem.findFirstOrThrow({ where: { cycleId } })).testCaseVersionId,
    ).toBe(v1);
  });

  it('versions parameters and datasets, diffs and restores them', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const put = (body: object) =>
      request('PUT', `/api/v1/test-cases/${id}/parameters`, as(acme.owner, body));
    ok(
      await put({
        parameters: [{ name: 'user', type: 'string', required: true }],
        rows: [{ values: { user: 'ann' } }],
        changeReason: 'First dataset',
      }),
    );
    ok(
      await put({
        parameters: [
          { name: 'user', type: 'string', required: false },
          { name: 'amount', type: 'number' },
        ],
        rows: [{ values: { user: 'bob', amount: 3 } }, { values: { user: 'cid' } }],
      }),
    );
    const diff = ok<{
      parameters: Array<{ name: string; change: string }>;
      dataset: { before: number; after: number; changed: boolean };
    }>(await get(`/api/v1/test-cases/${id}/versions/diff?from=2&to=3`));
    expect(diff.parameters.map((change) => [change.name, change.change])).toEqual([
      ['user', 'changed'],
      ['amount', 'added'],
    ]);
    expect(diff.dataset).toEqual({ before: 1, after: 2, changed: true });
    const v2 = ok<VersionContent>(await get(`/api/v1/test-cases/${id}/versions/2`));
    expect([v2.changeReason, v2.content.parameters.length, v2.content.dataset.length]).toEqual([
      'First dataset',
      1,
      1,
    ]);
    const restored = ok<{ version: number; parameters: unknown[]; dataset: unknown[] }>(
      await restore(id, 2),
    );
    expect([restored.version, restored.parameters.length, restored.dataset.length]).toEqual([
      4, 1, 1,
    ]);
  });

  it('hides other tenants and hidden projects, and honours revoked permissions', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    ok(await patch(id, { title: 'Pay again' }));
    const theirs = await testCase(await suite('Theirs', globex), 'Their case', globex);
    for (const path of [
      `/api/v1/test-cases/${id}/versions`,
      `/api/v1/test-cases/${id}/versions/1`,
      `/api/v1/test-cases/${id}/versions/diff?from=1&to=2`,
    ]) {
      expect((await get(path, globex.owner, globex)).statusCode).toBe(404);
    }
    expect((await get(`/api/v1/test-cases/${theirs}/versions`)).statusCode).toBe(404);
    expect(
      (await post(`/api/v1/test-cases/${id}/versions/1/restore`, {}, globex.owner, globex))
        .statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('qa_lead', 'hidden', { projectAccess: false });
    expect((await get(`/api/v1/test-cases/${id}/versions`, hidden)).statusCode).toBe(404);
    expect((await restore(id, 1, {}, hidden)).statusCode).toBe(404);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await get(`/api/v1/test-cases/${id}/versions`, viewer)).statusCode).toBe(200);
    expect((await restore(id, 1, {}, viewer)).statusCode).toBe(403);
    const lead = await acme.addMember('qa_lead', 'lead');
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'test_design.write', effect: 'revoke' }] }),
      ),
    );
    expect((await restore(id, 1, {}, lead)).statusCode).toBe(403);
    expect((await patch(id, { title: 'Lead edit' }, lead)).statusCode).toBe(403);
    expect((await versions(id)).map((row) => row.version)).toEqual([2, 1]);
  });

  it('keeps history intact through soft delete and refuses rewrites by the app role', async () => {
    const id = await testCase(await suite('Checkout'), 'Pay');
    const runId = await newRun('Executed', [id]);
    ok(await patch(id, { title: 'Pay later' }));
    expect((await request('DELETE', `/api/v1/test-cases/${id}`, as(acme.owner))).statusCode).toBe(
      204,
    );
    expect((await get(`/api/v1/test-cases/${id}/versions`)).statusCode).toBe(404);
    expect((await restore(id, 1)).statusCode).toBe(404);
    // The run keeps its execution and the version rows stay in the database.
    expect(
      (await runCases(runId)).map((entry) => [entry.caseVersion, entry.snapshot.title]),
    ).toEqual([[1, 'Pay']]);
    expect(await owner.testCaseVersion.count({ where: { testCaseId: id } })).toBe(2);

    const runtime = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
    try {
      for (const statement of [
        `UPDATE "test_case_versions" SET "title" = 'Rewritten' WHERE "testCaseId" = '${id}'`,
        `DELETE FROM "test_case_versions" WHERE "testCaseId" = '${id}'`,
      ]) {
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_organization', ${acme.organizationId}, TRUE)`;
            await tx.$executeRawUnsafe(statement);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await runtime.$disconnect();
    }
    expect((await versionRow(id, 1)).title).toBe('Pay');
  });
});
