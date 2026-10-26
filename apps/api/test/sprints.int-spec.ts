import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Sprints (S4-F5) over work items, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Sprints', () => {
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

  interface Sprint {
    id: string;
    status: string;
    committedEstimate: number | null;
    completedEstimate: number | null;
    metrics: {
      count: number;
      scopeEstimate: number;
      completedEstimate: number;
      load: number | null;
      progress: number | null;
      byStatus: Record<string, number>;
    };
    items: Array<{ id: string; key: string; sprintId: string | null }>;
  }

  const item = async (
    title: string,
    estimate: number | null = null,
    workspace: TestWorkspace = acme,
  ) =>
    ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(workspace.owner, { projectId: workspace.projectId, title, estimate }, workspace),
      ),
      201,
    );

  const sprint = async (name = 'Sprint 1', extra: object = {}, workspace: TestWorkspace = acme) =>
    ok<{ id: string; status: string }>(
      await request(
        'POST',
        '/api/v1/sprints',
        as(workspace.owner, { projectId: workspace.projectId, name, ...extra }, workspace),
      ),
      201,
    );

  const add = (
    id: string,
    workItemIds: string[],
    account: TestAccount = acme.owner,
    workspace = acme,
  ) => request('POST', `/api/v1/sprints/${id}/items`, as(account, { workItemIds }, workspace));

  const get = async (id: string) =>
    ok<Sprint>(await request('GET', `/api/v1/sprints/${id}`, as(acme.owner)));

  const setStatus = async (id: string, status: string) =>
    ok(await request('PATCH', `/api/v1/work-items/${id}`, as(acme.owner, { status })));

  it('plans items, starts, completes with carry-over to the backlog and computes velocity', async () => {
    const s1 = await sprint('Sprint 1', { capacity: 10 });
    const a = await item('Saved cards', 5);
    const b = await item('Coupon codes', 3);
    const c = await item('Gift cards', null);
    ok(await add(s1.id, [a.id, b.id, c.id]));
    let view = await get(s1.id);
    expect(view.metrics).toMatchObject({ count: 3, scopeEstimate: 8, load: 80 });

    ok(await request('POST', `/api/v1/sprints/${s1.id}/start`, as(acme.owner)));
    await setStatus(a.id, 'done');
    view = await get(s1.id);
    expect(view.committedEstimate).toBe(8);
    expect(view.metrics.completedEstimate).toBe(5);

    const filtered = ok<{ data: Array<{ id: string }> }>(
      await request(
        'GET',
        `/api/v1/work-items?projectId=${acme.projectId}&sprintId=${s1.id}`,
        as(acme.owner),
      ),
    );
    expect(filtered.data.map((row) => row.id).sort()).toEqual([a.id, b.id, c.id].sort());

    const closed = ok<{
      carriedOver: number;
      carriedTo: string;
      sprint: { status: string; completedEstimate: number };
    }>(await request('POST', `/api/v1/sprints/${s1.id}/complete`, as(acme.owner, {})));
    expect(closed).toMatchObject({
      carriedOver: 2,
      carriedTo: 'backlog',
      sprint: { status: 'completed', completedEstimate: 5 },
    });
    view = await get(s1.id);
    expect(view.items.map((row) => row.id)).toEqual([a.id]);
    const backlog = ok<{ items: Array<{ id: string }> }>(
      await request(
        'GET',
        `/api/v1/backlog?projectId=${acme.projectId}&sprintId=none`,
        as(acme.owner),
      ),
    );
    expect(backlog.items.map((row) => row.id).sort()).toEqual([b.id, c.id].sort());

    const list = ok<{ data: unknown[]; velocity: { velocity: number | null } }>(
      await request('GET', `/api/v1/sprints?projectId=${acme.projectId}`, as(acme.owner)),
    );
    expect(list.velocity.velocity).toBe(5);

    // A completed sprint is frozen.
    expect(
      (await request('PATCH', `/api/v1/sprints/${s1.id}`, as(acme.owner, { name: 'Renamed' })))
        .statusCode,
    ).toBe(409);
    expect((await add(s1.id, [b.id])).statusCode).toBe(409);
    expect(
      (
        await request(
          'POST',
          `/api/v1/sprints/${s1.id}/items/remove`,
          as(acme.owner, { workItemIds: [a.id] }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await request('POST', `/api/v1/sprints/${s1.id}/start`, as(acme.owner))).statusCode,
    ).toBe(409);
    const audit = await owner.auditLog.findMany({
      where: { entityType: 'Sprint', entityId: s1.id },
    });
    expect(audit.length).toBeGreaterThanOrEqual(4);
  });

  it('carries unfinished items over to a planned sprint, never to an active or foreign one', async () => {
    const s1 = await sprint('Sprint 1');
    const s2 = await sprint('Sprint 2');
    const a = await item('Saved cards', 2);
    const b = await item('Coupon codes', 3);
    ok(await add(s1.id, [a.id, b.id]));
    ok(await request('POST', `/api/v1/sprints/${s1.id}/start`, as(acme.owner)));
    await setStatus(b.id, 'done');
    const foreign = await sprint('Foreign', {}, globex);
    expect(
      (
        await request(
          'POST',
          `/api/v1/sprints/${s1.id}/complete`,
          as(acme.owner, { carryOverTo: foreign.id }),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/sprints/${s1.id}/complete`,
          as(acme.owner, { carryOverTo: s1.id }),
        )
      ).statusCode,
    ).toBe(400);
    const closed = ok<{ carriedOver: number }>(
      await request(
        'POST',
        `/api/v1/sprints/${s1.id}/complete`,
        as(acme.owner, { carryOverTo: s2.id }),
      ),
    );
    expect(closed.carriedOver).toBe(1);
    expect((await get(s2.id)).items.map((row) => row.id)).toEqual([a.id]);
    expect((await get(s1.id)).items.map((row) => row.id)).toEqual([b.id]);

    // Cancelling sends the unfinished items back to the backlog.
    const cancelled = ok<{ carriedOver: number; sprint: { status: string } }>(
      await request('POST', `/api/v1/sprints/${s2.id}/cancel`, as(acme.owner, {})),
    );
    expect(cancelled).toMatchObject({ carriedOver: 1, sprint: { status: 'cancelled' } });
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: a.id } })).sprintId).toBeNull();
  });

  it('keeps one active sprint per project even when two start at once', async () => {
    const sprints = await Promise.all(['A', 'B', 'C', 'D'].map((name) => sprint(`Sprint ${name}`)));
    const responses = await Promise.all(
      sprints.map((row) => request('POST', `/api/v1/sprints/${row.id}/start`, as(acme.owner))),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409, 409]);
    expect(
      await owner.sprint.count({ where: { projectId: acme.projectId, status: 'active' } }),
    ).toBe(1);
    // Another project may have its own active sprint.
    const other = await sprint('Globex 1', {}, globex);
    ok(
      await request(
        'POST',
        `/api/v1/sprints/${other.id}/start`,
        as(globex.owner, undefined, globex),
      ),
    );
  });

  it('refuses items of other projects or tenants, deleted or closed items, like missing ones', async () => {
    const s1 = await sprint();
    const mine = await item('Saved cards');
    const theirs = await item('Their item', null, globex);
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const otherProject = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(acme.owner, { projectId: project.id, title: 'Mobile item' }),
      ),
      201,
    );
    const missing = errorOf(await add(s1.id, [mine.id, 'does-not-exist']));
    for (const id of [theirs.id, otherProject.id]) {
      const response = await add(s1.id, [mine.id, id]);
      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual(missing);
    }
    expect(
      (await owner.workItem.findUniqueOrThrow({ where: { id: mine.id } })).sprintId,
    ).toBeNull();

    // A sprint of another tenant is a missing sprint.
    const foreign = await sprint('Foreign', {}, globex);
    expect((await request('GET', `/api/v1/sprints/${foreign.id}`, as(acme.owner))).statusCode).toBe(
      404,
    );
    expect((await add(foreign.id, [mine.id])).statusCode).toBe(404);

    // The database refuses a cross-project sprint even from a raw writer.
    await expect(
      owner.workItem.update({ where: { id: otherProject.id }, data: { sprintId: s1.id } }),
    ).rejects.toThrow();

    await setStatus(mine.id, 'cancelled');
    expect((await add(s1.id, [mine.id])).statusCode).toBe(409);
    const gone = await item('Gone');
    expect(
      (await request('DELETE', `/api/v1/work-items/${gone.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect((await add(s1.id, [gone.id])).statusCode).toBe(404);
  });

  it('hides sprints of hidden projects and follows permission changes', async () => {
    const s1 = await sprint();
    const a = await item('Saved cards');
    const hidden = await acme.addMember('tester', 'hidden-tester', { projectAccess: false });
    expect((await request('GET', `/api/v1/sprints/${s1.id}`, as(hidden))).statusCode).toBe(404);
    const list = ok<{ data: unknown[] }>(
      await request('GET', `/api/v1/sprints?projectId=${acme.projectId}`, as(hidden)),
    );
    expect(list.data).toEqual([]);

    const tester = await acme.addMember('tester', 'tester');
    ok(await add(s1.id, [a.id], tester));
    expect((await request('POST', `/api/v1/sprints/${s1.id}/start`, as(tester))).statusCode).toBe(
      403,
    );
    expect(
      (
        await request(
          'POST',
          '/api/v1/sprints',
          as(tester, { projectId: acme.projectId, name: 'Mine' }),
        )
      ).statusCode,
    ).toBe(403);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await request('GET', `/api/v1/sprints/${s1.id}`, as(viewer))).statusCode).toBe(200);
    expect((await add(s1.id, [a.id], viewer)).statusCode).toBe(403);

    // Revoking the tester's project access makes the sprint vanish for them.
    await owner.projectMember.deleteMany({
      where: { projectId: acme.projectId, userId: tester.userId },
    });
    expect((await request('GET', `/api/v1/sprints/${s1.id}`, as(tester))).statusCode).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/sprints/${s1.id}/items/remove`,
          as(tester, { workItemIds: [a.id] }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('serialises concurrent planning and completion without losing or duplicating items', async () => {
    const s1 = await sprint('Sprint 1');
    const s2 = await sprint('Sprint 2');
    const items = await Promise.all(
      ['One', 'Two', 'Three', 'Four'].map((title) => item(`Item ${title}`, 1)),
    );
    ok(
      await add(
        s1.id,
        items.map((row) => row.id),
      ),
    );
    ok(await request('POST', `/api/v1/sprints/${s1.id}/start`, as(acme.owner)));
    const [moved, completed] = await Promise.all([
      add(s2.id, [items[0]!.id, items[1]!.id]),
      request('POST', `/api/v1/sprints/${s1.id}/complete`, as(acme.owner, {})),
    ]);
    expect(completed.statusCode, completed.body).toBe(200);
    expect([200, 409]).toContain(moved.statusCode);
    const rows = await owner.workItem.findMany({
      where: { id: { in: items.map((row) => row.id) } },
    });
    // Nothing stays in the completed sprint: open items either moved to s2 or went back to the backlog.
    expect(rows.every((row) => row.sprintId === null || row.sprintId === s2.id)).toBe(true);
    if (moved.statusCode === 200) {
      expect(rows.filter((row) => row.sprintId === s2.id)).toHaveLength(2);
    }

    // Concurrent edits with a stale version: one wins.
    const fresh = await get(s2.id);
    const version = (await owner.sprint.findUniqueOrThrow({ where: { id: fresh.id } })).version;
    const edits = await Promise.all(
      ['Alpha', 'Beta'].map((name) =>
        request('PATCH', `/api/v1/sprints/${s2.id}`, as(acme.owner, { name, version })),
      ),
    );
    expect(edits.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });
});
