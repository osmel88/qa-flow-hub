import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Kanban board (S4-F7) of a project, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Kanban board', () => {
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

  interface Kanban {
    columns: Array<{ id: string; cardIds: string[]; count: number; wipLimit: number | null }>;
    cards: Array<{
      id: string;
      version: number;
      startedAt: string | null;
      ageDays: number | null;
      inStatusDays: number;
    }>;
    swimlanes: Array<{ id: string | null; title: string; cardIds: string[] }>;
    metrics: {
      throughput: { total: number };
      cycleTime: { count: number; averageDays: number | null; medianDays: number | null };
      aging: { count: number; oldest: Array<{ id: string; ageDays: number }> };
    };
    total: number;
    shown: number;
  }

  const item = async (title: string, workspace: TestWorkspace = acme, extra: object = {}) =>
    ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(workspace.owner, { projectId: workspace.projectId, title, ...extra }, workspace),
      ),
      201,
    );
  const items = async (...titles: string[]) => {
    const created = [];
    for (const title of titles) {
      created.push(await item(title));
    }
    return created as unknown as Array<{ id: string; key: string }> &
      [{ id: string }, { id: string }, { id: string }];
  };
  const kanban = async (params = '', account: TestAccount = acme.owner) =>
    ok<Kanban>(
      await request('GET', `/api/v1/kanban?projectId=${acme.projectId}${params}`, as(account)),
    );
  const column = (view: Kanban, id: string) => view.columns.find((entry) => entry.id === id)!;
  const move = (body: object, account: TestAccount = acme.owner) =>
    request('POST', '/api/v1/kanban/move', as(account, { projectId: acme.projectId, ...body }));
  const limits = (body: object[], account: TestAccount = acme.owner) =>
    request(
      'PUT',
      '/api/v1/kanban/wip-limits',
      as(account, { projectId: acme.projectId, limits: body }),
    );
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);

  it('moves cards without any sprint, persists order and status and audits it', async () => {
    const [a, b, c] = await items('Saved cards', 'Coupon codes', 'Gift cards');
    expect(column(await kanban(), 'backlog').cardIds).toEqual([a.id, b.id, c.id]);
    ok(await move({ workItemId: c.id, column: 'in_progress' }));
    ok(await move({ workItemId: a.id, column: 'in_progress', afterId: c.id }));
    ok(await move({ workItemId: c.id, column: 'in_progress', afterId: a.id }));
    ok(await move({ workItemId: b.id, column: 'done' }));
    expect((await move({ workItemId: b.id, column: 'ready', beforeId: c.id })).statusCode).toBe(
      409,
    );

    const view = await kanban();
    expect(column(view, 'backlog').cardIds).toEqual([]);
    expect(column(view, 'in_progress').cardIds).toEqual([a.id, c.id]);
    expect(column(view, 'done').cardIds).toEqual([b.id]);
    const row = await owner.workItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.sprintId).toBeNull();
    expect(row.startedAt).not.toBeNull();
    expect(
      (await owner.workItem.findUniqueOrThrow({ where: { id: b.id } })).completedAt,
    ).not.toBeNull();
    // Back to ready clears the start.
    ok(await move({ workItemId: c.id, column: 'ready' }));
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: c.id } })).startedAt).toBeNull();
    const logs = await owner.auditLog.findMany({
      where: { entityId: { in: [a.id, b.id, c.id] }, summary: { contains: 'Kanban board' } },
    });
    expect(logs).toHaveLength(5);
  });

  it('enforces WIP limits, also under concurrent moves', async () => {
    const [a, b, c] = await items('Saved cards', 'Coupon codes', 'Gift cards');
    const tester = await acme.addMember('tester', 'tester');
    expect((await limits([{ column: 'in_progress', wipLimit: 1 }], tester)).statusCode).toBe(403);
    expect((await limits([{ column: 'done', wipLimit: 1 }])).statusCode).toBe(400);
    ok(await limits([{ column: 'in_progress', wipLimit: 1 }]));
    expect(column(await kanban(), 'in_progress').wipLimit).toBe(1);

    const results = await Promise.all(
      [a.id, b.id].map((id) => move({ workItemId: id, column: 'in_progress' })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const refused = await move({ workItemId: c.id, column: 'in_progress' });
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).message).toContain('WIP limit (1/1)');
    expect(
      await owner.workItem.count({ where: { projectId: acme.projectId, status: 'in_progress' } }),
    ).toBe(1);
    // Reordering inside a full column and leaving it stay allowed.
    ok(
      await move({
        workItemId: c.id,
        column: 'backlog',
        beforeId: a.id === results[0]!.json<{ id: string }>().id ? b.id : a.id,
      }),
    );
    ok(await limits([{ column: 'in_progress', wipLimit: null }]));
    ok(await move({ workItemId: c.id, column: 'in_progress' }));
    expect(
      await owner.auditLog.count({ where: { summary: 'Changed the Kanban WIP limits' } }),
    ).toBe(2);
  });

  it('lets one of two moves of the same card win and keeps distinct positions', async () => {
    const [anchor, first, second] = await items('Anchor', 'First', 'Second');
    const version = (await kanban()).cards.find((card) => card.id === first.id)!.version;
    const statuses = (
      await Promise.all([
        move({ workItemId: first.id, column: 'in_progress', version }),
        move({ workItemId: first.id, column: 'blocked', version }),
      ])
    )
      .map((response) => response.statusCode)
      .sort();
    expect(statuses).toEqual([200, 409]);
    ok(await move({ workItemId: anchor.id, column: 'ready' }));
    const third = await item('Third');
    const results = await Promise.all(
      [second.id, third.id].map((id) =>
        move({ workItemId: id, column: 'ready', beforeId: anchor.id }),
      ),
    );
    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
    const rows = await owner.workItem.findMany({
      where: { status: 'ready' },
      orderBy: { rank: 'asc' },
    });
    expect(new Set(rows.map((row) => row.rank)).size).toBe(3);
    expect(rows.at(-1)?.id).toBe(anchor.id);
    expect(column(await kanban(), 'ready').cardIds).toEqual(rows.map((row) => row.id));
  });

  it('refuses cards, anchors and projects of other projects or tenants like missing ones', async () => {
    const [mine] = await items('Saved cards');
    const theirs = await item('Their item', globex);
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const other = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(acme.owner, { projectId: project.id, title: 'Mobile item' }),
      ),
      201,
    );
    const missing = errorOf(await move({ workItemId: 'does-not-exist', column: 'done' }));
    for (const id of [theirs.id, other.id]) {
      const asCard = await move({ workItemId: id, column: 'done' });
      expect([asCard.statusCode, errorOf(asCard)]).toEqual([404, missing]);
      const asAnchor = await move({ workItemId: mine.id, column: 'backlog', beforeId: id });
      expect([asAnchor.statusCode, errorOf(asAnchor)]).toEqual([404, missing]);
    }
    const foreign = await move({
      projectId: globex.projectId,
      workItemId: theirs.id,
      column: 'done',
    });
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, missing]);
    expect(
      ok<Kanban>(
        await request('GET', `/api/v1/kanban?projectId=${globex.projectId}`, as(acme.owner)),
      ).total,
    ).toBe(0);
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe(
      'backlog',
    );
  });

  it('follows permission changes while the board is open', async () => {
    const [a] = await items('Saved cards');
    const tester = await acme.addMember('tester', 'tester');
    const viewer = await acme.addMember('viewer', 'viewer');
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await kanban('', viewer)).shown).toBe(1);
    expect((await move({ workItemId: a.id, column: 'done' }, viewer)).statusCode).toBe(403);
    expect((await kanban('', hidden)).total).toBe(0);
    expect((await move({ workItemId: a.id, column: 'done' }, hidden)).statusCode).toBe(404);
    ok(await move({ workItemId: a.id, column: 'in_progress' }, tester));
    await owner.projectMember.deleteMany({
      where: { projectId: acme.projectId, userId: tester.userId },
    });
    expect((await move({ workItemId: a.id, column: 'done' }, tester)).statusCode).toBe(404);
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      'in_progress',
    );
  });

  it('filters by release and the rest, and groups into swimlanes', async () => {
    const [a, b, c] = await items('Saved cards', 'Coupon codes', 'Gift cards');
    const epic = await item('Payments epic', acme, { type: 'epic' });
    const release = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: acme.projectId, name: 'Spring', version: '1.0.0' }),
      ),
      201,
    );
    ok(
      await request(
        'PATCH',
        `/api/v1/work-items/${a.id}`,
        as(acme.owner, {
          parentId: epic.id,
          priority: 'high',
          assigneeId: acme.owner.userId,
          releaseId: release.id,
        }),
      ),
    );
    expect((await kanban()).total).toBe(4);
    expect((await kanban(`&releaseId=${release.id}`)).cards.map((card) => card.id)).toEqual([a.id]);
    expect((await kanban('&releaseId=none')).shown).toBe(3);
    expect((await kanban('&assigneeId=me')).shown).toBe(1);
    expect((await kanban('&priority=high&type=story')).shown).toBe(1);
    expect((await kanban(`&epicId=${epic.id}`)).shown).toBe(2);
    expect((await kanban('&search=coupon')).cards.map((card) => card.id)).toEqual([b.id]);
    const filtered = await kanban('&search=coupon');
    expect(column(filtered, 'backlog').count).toBe(4);
    const lanes = await kanban('&swimlane=assignee&type=story');
    expect(lanes.swimlanes.map((lane) => lane.cardIds)).toEqual([[a.id], [b.id, c.id]]);
    expect((await kanban('&swimlane=epic')).swimlanes.map((lane) => lane.id)).toEqual([
      epic.id,
      null,
    ]);
  });

  it('reports cycle time, throughput, aging and time in status', async () => {
    const [a, b, c] = await items('Saved cards', 'Coupon codes', 'Gift cards');
    const old = await item('Old one');
    for (const id of [a.id, b.id, old.id]) {
      ok(await move({ workItemId: id, column: 'done' }));
    }
    ok(await move({ workItemId: c.id, column: 'in_progress' }));
    const set = (id: string, data: object) => owner.workItem.update({ where: { id }, data });
    await set(a.id, { startedAt: days(5), completedAt: days(1) });
    await set(b.id, { startedAt: days(3), completedAt: days(1) });
    await set(old.id, { startedAt: days(40), completedAt: days(30) });
    await set(c.id, { startedAt: days(6), statusChangedAt: days(2) });

    const view = await kanban();
    expect(view.metrics.throughput.total).toBe(2);
    expect(view.metrics.cycleTime).toMatchObject({ count: 2, averageDays: 3, medianDays: 2 });
    expect(view.metrics.aging.count).toBe(1);
    expect(view.metrics.aging.oldest[0]).toMatchObject({ id: c.id, ageDays: 6 });
    const card = view.cards.find((entry) => entry.id === c.id)!;
    expect([card.ageDays, card.inStatusDays]).toEqual([6, 2]);
    expect(column(view, 'done').cardIds).toEqual([a.id, b.id]);
    expect((await kanban('&windowDays=90')).metrics.throughput.total).toBe(3);
  });
});
