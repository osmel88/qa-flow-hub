import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Exploratory sessions (S7-F5), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Exploratory sessions', () => {
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

  interface Session {
    id: string;
    status: string;
    version: number;
    durationSeconds: number | null;
    findings: Array<{
      id: string;
      defect: { id: string; key: string } | null;
      defectCreated: boolean;
    }>;
    timeline: Array<{ type: string }>;
    defects: Array<{ id: string; source: string }>;
    workItems: Array<{ id: string }>;
    metrics: {
      findings: number;
      defectsCreated: number;
      defectsLinked: number;
      bySeverity: Record<string, number>;
      notes: number;
    };
  }
  const BASE = '/api/v1/exploratory-sessions';
  const get = (path: string, account: TestAccount = acme.owner, workspace = acme) =>
    request('GET', path, as(account, undefined, workspace));
  const session = async (title = 'Checkout tour', extra: object = {}, account = acme.owner) =>
    ok<Session>(
      await post(
        BASE,
        { projectId: acme.projectId, title, charter: 'Explore payments', ...extra },
        account,
      ),
      201,
    );
  const act = (id: string, action: string, body: object = {}, account = acme.owner) =>
    post(`${BASE}/${id}/${action}`, body, account);
  const finding = (id: string, title = 'Total is wrong', account = acme.owner) =>
    post(`${BASE}/${id}/findings`, { title, severity: 'critical' }, account);
  const detail = async (id: string) => ok<Session>(await get(`${BASE}/${id}`));
  const defect = async (workspace = acme) =>
    ok<{ id: string }>(
      await post(
        '/api/v1/defects',
        { projectId: workspace.projectId, title: 'Existing defect' },
        workspace.owner,
        workspace,
      ),
      201,
    ).id;

  it('runs a session through pause and resume and measures active time', async () => {
    const s = await session();
    expect((await finding(s.id)).statusCode).toBe(409);
    ok(await act(s.id, 'start'));
    ok(await post(`${BASE}/${s.id}/notes`, { body: 'Card form loads slowly' }), 201);
    ok(await act(s.id, 'pause'));
    expect((await act(s.id, 'pause')).statusCode).toBe(422);
    expect((await act(s.id, 'start')).statusCode).toBe(422);
    // Pretend the pause lasted ten minutes: only active time counts.
    await owner.exploratorySession.update({
      where: { id: s.id },
      data: { pausedAt: new Date(Date.now() - 600_000), startedAt: new Date(Date.now() - 900_000) },
    });
    ok(await act(s.id, 'resume'));
    ok(await finding(s.id), 201);
    const done = ok<Session>(await act(s.id, 'complete'));
    expect(done.status).toBe('completed');
    expect(done.durationSeconds).toBeGreaterThanOrEqual(295);
    expect(done.durationSeconds).toBeLessThan(330);
    expect(done.timeline.map((event) => event.type)).toEqual([
      'created',
      'started',
      'note',
      'paused',
      'resumed',
      'finding',
      'completed',
    ]);
    expect(done.metrics).toMatchObject({ findings: 1, notes: 1, defectsCreated: 0 });
  });

  it('freezes a completed session and keeps its history through archive', async () => {
    const s = await session();
    ok(await act(s.id, 'start'));
    ok(await finding(s.id), 201);
    const [f] = (await detail(s.id)).findings;
    ok(await act(s.id, 'complete'));
    expect(
      (await request('PATCH', `${BASE}/${s.id}`, as(acme.owner, { notes: 'late edit' })))
        .statusCode,
    ).toBe(409);
    expect((await post(`${BASE}/${s.id}/notes`, { body: 'late' })).statusCode).toBe(409);
    expect((await finding(s.id)).statusCode).toBe(409);
    expect((await post(`${BASE}/${s.id}/findings/${f!.id}/defect`, {})).statusCode).toBe(409);
    expect((await act(s.id, 'resume')).statusCode).toBe(422);
    // The database refuses rewrites from any path.
    await expect(
      owner.exploratorySession.update({ where: { id: s.id }, data: { notes: 'rewritten' } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      owner.exploratoryFinding.update({ where: { id: f!.id }, data: { title: 'rewritten' } }),
    ).rejects.toThrow(/session is completed/);
    const archived = ok<Session>(await act(s.id, 'archive'));
    expect(archived.status).toBe('archived');
    expect((await act(s.id, 'archive')).statusCode).toBe(422);
    expect(
      (await request('PATCH', `${BASE}/${s.id}`, as(acme.owner, { title: 'Renamed' }))).statusCode,
    ).toBe(409);
    expect(archived.findings).toHaveLength(1);
    expect(archived.timeline.map((event) => event.type).slice(-2)).toEqual([
      'completed',
      'archived',
    ]);
    const listed = ok<{ data: Session[] }>(await get(`${BASE}?projectId=${acme.projectId}`)).data;
    expect(listed.map((row) => row.id)).not.toContain(s.id);
    const archivedList = ok<{ data: Session[] }>(
      await get(`${BASE}?projectId=${acme.projectId}&status=archived`),
    ).data;
    expect(archivedList.map((row) => row.id)).toEqual([s.id]);
  });

  it('turns a finding into a defect once and relates others to existing defects', async () => {
    const s = await session();
    ok(await act(s.id, 'start'));
    ok(await finding(s.id, 'Total is wrong'), 201);
    ok(await finding(s.id, 'Coupon ignored'), 201);
    const [first, second] = (await detail(s.id)).findings;
    const [a, b] = await Promise.all([
      post(`${BASE}/${s.id}/findings/${first!.id}/defect`, { priority: 'high' }),
      post(`${BASE}/${s.id}/findings/${first!.id}/defect`, { priority: 'high' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await owner.defect.count({ where: { projectId: acme.projectId } })).toBe(1);
    const created = await owner.defect.findFirstOrThrow({ where: { projectId: acme.projectId } });
    expect([created.title, created.severity, created.priority]).toEqual([
      'Total is wrong',
      'critical',
      'high',
    ]);

    const existing = await defect();
    const theirs = await defect(globex);
    expect(
      (await post(`${BASE}/${s.id}/findings/${second!.id}/link-defect`, { defectId: theirs }))
        .statusCode,
    ).toBe(404);
    ok(await post(`${BASE}/${s.id}/findings/${second!.id}/link-defect`, { defectId: existing }));
    expect(
      (await post(`${BASE}/${s.id}/findings/${second!.id}/link-defect`, { defectId: existing }))
        .statusCode,
    ).toBe(409);
    expect((await post(`${BASE}/${s.id}/defects`, { defectId: theirs })).statusCode).toBe(404);
    ok(await post(`${BASE}/${s.id}/defects`, { defectId: existing }));
    const item = ok<{ id: string }>(
      await post('/api/v1/work-items', {
        projectId: acme.projectId,
        type: 'story',
        title: 'Checkout story',
      }),
      201,
    ).id;
    ok(await post(`${BASE}/${s.id}/work-items`, { workItemId: item }));
    const view = await detail(s.id);
    expect(view.findings.map((entry) => [entry.defect?.id ?? null, entry.defectCreated])).toEqual([
      [created.id, true],
      [existing, false],
    ]);
    expect(view.defects.map((entry) => entry.source)).toEqual(['finding', 'finding']);
    expect(view.workItems.map((entry) => entry.id)).toEqual([item]);
    expect(view.metrics).toMatchObject({
      findings: 2,
      defectsCreated: 1,
      defectsLinked: 2,
      bySeverity: { critical: 2 },
    });
    const audit = await owner.auditLog.count({
      where: { entityType: 'Defect', entityId: created.id },
    });
    expect(audit).toBe(1);
  });

  it('serializes concurrent starts and allows one active session per tester', async () => {
    const s = await session('First');
    const results = await Promise.all([act(s.id, 'start'), act(s.id, 'start')]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422]);
    const other = await session('Second');
    expect((await act(other.id, 'start')).statusCode).toBe(409);
    ok(await act(s.id, 'pause'));
    ok(await act(other.id, 'start'));
    expect((await act(s.id, 'resume')).statusCode).toBe(409);
    const stale = await detail(other.id);
    ok(
      await request(
        'PATCH',
        `${BASE}/${other.id}`,
        as(acme.owner, { notes: 'one', version: stale.version }),
      ),
    );
    expect(
      (
        await request(
          'PATCH',
          `${BASE}/${other.id}`,
          as(acme.owner, { notes: 'two', version: stale.version }),
        )
      ).statusCode,
    ).toBe(409);
    const findings = await Promise.all(
      ['A1', 'B2', 'C3'].map((title) => finding(other.id, `Finding ${title}`)),
    );
    expect(findings.map((response) => response.statusCode)).toEqual([201, 201, 201]);
    expect((await detail(other.id)).metrics.findings).toBe(3);
  });

  it('rejects cross-project targets, hides other tenants and honours revoked permissions', async () => {
    const theirEnv = ok<{ id: string }>(
      await post(
        '/api/v1/environments',
        { projectId: globex.projectId, name: 'Globex QA', kind: 'staging' },
        globex.owner,
        globex,
      ),
      201,
    ).id;
    expect(
      (
        await post(BASE, {
          projectId: acme.projectId,
          title: 'Hijack',
          charter: 'x',
          environmentId: theirEnv,
        })
      ).statusCode,
    ).toBe(404);
    const s = await session();
    expect((await get(`${BASE}/${s.id}`, globex.owner, globex)).statusCode).toBe(404);
    expect((await post(`${BASE}/${s.id}/start`, {}, globex.owner, globex)).statusCode).toBe(404);
    const hidden = await acme.addMember('qa_lead', 'hidden', { projectAccess: false });
    expect((await get(`${BASE}/${s.id}`, hidden)).statusCode).toBe(404);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await get(`${BASE}/${s.id}`, viewer)).statusCode).toBe(200);
    expect((await act(s.id, 'start', {}, viewer)).statusCode).toBe(403);
    const tester = await acme.addMember('tester', 'tester');
    const mine = await session('Tester tour', {}, tester);
    ok(await act(mine.id, 'start', {}, tester));
    expect((await act(mine.id, 'cancel', {}, tester)).statusCode).toBe(403);
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
        as(acme.owner, { overrides: [{ permission: 'testruns.execute', effect: 'revoke' }] }),
      ),
    );
    expect((await finding(mine.id, 'After revoke', tester)).statusCode).toBe(403);
    expect((await act(mine.id, 'pause', {}, tester)).statusCode).toBe(403);
  });
});
