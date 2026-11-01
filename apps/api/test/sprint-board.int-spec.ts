import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Scrum board (S4-F6) of a sprint, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Sprint board', () => {
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

  interface Board {
    sprint: { id: string; status: string } | null;
    metrics: { completedEstimate: number; progress: number | null } | null;
    velocity: { velocity: number | null };
    columns: Array<{ id: string; cardIds: string[]; estimate: number }>;
    cards: Array<{
      id: string;
      key: string;
      status: string;
      version: number;
      epic: { id: string } | null;
      assignee: { id: string; fullName: string } | null;
      requirements: { count: number; keys: string[] };
    }>;
    swimlanes: Array<{ id: string | null; title: string; cardIds: string[] }>;
    total: number;
    shown: number;
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

  const board = async (params = '', account: TestAccount = acme.owner) =>
    ok<Board>(
      await request(
        'GET',
        `/api/v1/sprints/board?projectId=${acme.projectId}${params}`,
        as(account),
      ),
    );

  const column = (view: Board, id: string) => view.columns.find((entry) => entry.id === id)!;

  const move = (sprintId: string, body: object, account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/sprints/${sprintId}/board/move`, as(account, body));

  /** An active sprint with the given items planned into it. */
  const activeSprint = async (titles: string[]) => {
    const s = await sprint('Sprint 1', { capacity: 20 });
    const items = [];
    for (const title of titles) {
      items.push(await item(title, 2));
    }
    ok(
      await add(
        s.id,
        items.map((entry) => entry.id),
      ),
    );
    ok(await request('POST', `/api/v1/sprints/${s.id}/start`, as(acme.owner)));
    return { sprint: s, items };
  };

  it('moves cards between columns and inside a column, persists and audits it', async () => {
    const { sprint: s, items } = await activeSprint(['Saved cards', 'Coupon codes', 'Gift cards']);
    const [a, b, c] = items as unknown as [{ id: string }, { id: string }, { id: string }];
    let view = await board();
    expect(view.sprint?.id).toBe(s.id);
    expect(column(view, 'todo').cardIds).toEqual([a.id, b.id, c.id]);

    ok(await move(s.id, { workItemId: c.id, column: 'in_progress' }));
    ok(await move(s.id, { workItemId: a.id, column: 'in_progress', afterId: c.id }));
    ok(await move(s.id, { workItemId: c.id, column: 'in_progress', afterId: a.id }));
    expect(
      (await move(s.id, { workItemId: b.id, column: 'todo', beforeId: c.id })).statusCode,
    ).toBe(409);
    ok(await move(s.id, { workItemId: c.id, column: 'done' }));

    view = await board();
    expect(column(view, 'todo').cardIds).toEqual([b.id]);
    expect(column(view, 'in_progress').cardIds).toEqual([a.id]);
    expect(column(view, 'done').cardIds).toEqual([c.id]);
    expect(column(view, 'done').estimate).toBe(2);
    expect(view.metrics?.completedEstimate).toBe(2);
    expect(view.metrics?.progress).toBe(33.3);

    const row = await owner.workItem.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.status).toBe('backlog');
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: c.id } })).completedAt).not.toBe(
      null,
    );
    const logs = await owner.auditLog.findMany({
      where: { entityId: { in: [a.id, b.id, c.id] }, summary: { contains: 'on the board' } },
    });
    expect(logs).toHaveLength(4);
  });

  it('lets one of two concurrent moves of the same card win and keeps distinct positions', async () => {
    const { sprint: s, items } = await activeSprint(['Anchor', 'First', 'Second', 'Third']);
    const [anchor, first, second] = items as unknown as [
      { id: string },
      { id: string },
      { id: string },
    ];
    const cards = (await board()).cards;
    const version = cards.find((card) => card.id === first.id)!.version;
    const statuses = (
      await Promise.all([
        move(s.id, { workItemId: first.id, column: 'in_progress', version }),
        move(s.id, { workItemId: first.id, column: 'blocked', version }),
      ])
    )
      .map((response) => response.statusCode)
      .sort();
    expect(statuses).toEqual([200, 409]);
    const status = (await owner.workItem.findUniqueOrThrow({ where: { id: first.id } })).status;
    expect(['in_progress', 'blocked']).toContain(status);

    // Two cards dropped right before the same anchor at once both land above it.
    const results = await Promise.all(
      [second.id, items[3]!.id].map((id) =>
        move(s.id, { workItemId: id, column: 'todo', beforeId: anchor.id }),
      ),
    );
    expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
    const rows = await owner.workItem.findMany({
      where: { sprintId: s.id, status: { in: ['backlog', 'ready'] } },
      orderBy: { rank: 'asc' },
    });
    expect(new Set(rows.map((entry) => entry.rank)).size).toBe(rows.length);
    expect(rows.at(-1)?.id).toBe(anchor.id);
  });

  it('refuses cards and anchors of other projects or tenants like missing ones', async () => {
    const { sprint: s, items } = await activeSprint(['Saved cards']);
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
    const missing = errorOf(await move(s.id, { workItemId: 'does-not-exist', column: 'done' }));
    for (const id of [theirs.id, otherProject.id]) {
      const asCard = await move(s.id, { workItemId: id, column: 'done' });
      expect(asCard.statusCode).toBe(404);
      expect(errorOf(asCard)).toEqual(missing);
      const asAnchor = await move(s.id, { workItemId: items[0]!.id, column: 'todo', beforeId: id });
      expect(asAnchor.statusCode).toBe(404);
      expect(errorOf(asAnchor)).toEqual(missing);
    }
    // A sprint of another tenant is unknown, and so is its board.
    const foreign = await sprint('Their sprint', {}, globex);
    expect((await move(foreign.id, { workItemId: items[0]!.id, column: 'done' })).statusCode).toBe(
      404,
    );
    expect(
      (
        await request(
          'GET',
          `/api/v1/sprints/board?projectId=${acme.projectId}&sprintId=${foreign.id}`,
          as(acme.owner),
        )
      ).statusCode,
    ).toBe(404);
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe(
      'backlog',
    );
  });

  it('follows permission changes while the board is open', async () => {
    const { sprint: s, items } = await activeSprint(['Saved cards']);
    const tester = await acme.addMember('tester', 'tester');
    const viewer = await acme.addMember('viewer', 'viewer');
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });

    expect((await board('', viewer)).shown).toBe(1);
    expect(
      (await move(s.id, { workItemId: items[0]!.id, column: 'done' }, viewer)).statusCode,
    ).toBe(403);
    expect((await board('', hidden)).sprint).toBeNull();
    expect(
      (await move(s.id, { workItemId: items[0]!.id, column: 'done' }, hidden)).statusCode,
    ).toBe(404);

    ok(await move(s.id, { workItemId: items[0]!.id, column: 'in_progress' }, tester));
    await owner.projectMember.deleteMany({
      where: { projectId: acme.projectId, userId: tester.userId },
    });
    expect(
      (await move(s.id, { workItemId: items[0]!.id, column: 'done' }, tester)).statusCode,
    ).toBe(404);
    expect((await owner.workItem.findUniqueOrThrow({ where: { id: items[0]!.id } })).status).toBe(
      'in_progress',
    );
  });

  it('freezes the board of completed or cancelled sprints and of items that left the sprint', async () => {
    const { sprint: s, items } = await activeSprint(['Saved cards', 'Coupon codes']);
    const [a, b] = items as unknown as [{ id: string }, { id: string }];
    // Removed from the sprint while the board is open.
    ok(
      await request(
        'POST',
        `/api/v1/sprints/${s.id}/items/remove`,
        as(acme.owner, { workItemIds: [b.id] }),
      ),
    );
    expect((await move(s.id, { workItemId: b.id, column: 'done' })).statusCode).toBe(409);
    expect(
      (await move(s.id, { workItemId: a.id, column: 'todo', beforeId: b.id })).statusCode,
    ).toBe(409);
    // Added while the board is open: it shows up on the next read.
    ok(await add(s.id, [b.id]));
    expect(column(await board(), 'todo').cardIds).toContain(b.id);

    ok(await move(s.id, { workItemId: a.id, column: 'done' }));
    ok(
      await request(
        'POST',
        `/api/v1/sprints/${s.id}/complete`,
        as(acme.owner, { carryOverTo: 'backlog' }),
      ),
    );
    const response = await move(s.id, { workItemId: a.id, column: 'in_progress' });
    expect(response.statusCode).toBe(409);
    const closed = await board(`&sprintId=${s.id}`);
    expect(closed.sprint?.status).toBe('completed');
    expect(column(closed, 'done').cardIds).toEqual([a.id]);
    expect((await board()).sprint).toBeNull();
    expect((await board()).velocity.velocity).toBe(2);

    const s2 = await sprint('Sprint 2');
    ok(await add(s2.id, [b.id]));
    expect((await move(s2.id, { workItemId: b.id, column: 'done' })).statusCode).toBe(409);
    ok(
      await request(
        'POST',
        `/api/v1/sprints/${s2.id}/cancel`,
        as(acme.owner, { carryOverTo: 'backlog' }),
      ),
    );
    expect((await move(s2.id, { workItemId: b.id, column: 'done' })).statusCode).toBe(409);
  });

  it('filters the board and groups it into swimlanes by assignee or epic', async () => {
    const { items } = await activeSprint(['Saved cards', 'Coupon codes', 'Gift cards']);
    const [a, b, c] = items as unknown as [
      { id: string; key: string },
      { id: string },
      { id: string },
    ];
    const epic = await item('Payments epic');
    const feature = await item('Cards feature');
    ok(await request('PATCH', `/api/v1/work-items/${epic.id}`, as(acme.owner, { type: 'epic' })));
    ok(
      await request(
        'PATCH',
        `/api/v1/work-items/${feature.id}`,
        as(acme.owner, { type: 'feature', parentId: epic.id }),
      ),
    );
    ok(
      await request(
        'PATCH',
        `/api/v1/work-items/${a.id}`,
        as(acme.owner, { parentId: feature.id, priority: 'high', assigneeId: acme.owner.userId }),
      ),
    );
    const requirement = ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/requirements',
        as(acme.owner, { projectId: acme.projectId, title: 'Pay with saved cards' }),
      ),
      201,
    );
    ok(
      await request(
        'POST',
        `/api/v1/requirements/${requirement.id}/work-items`,
        as(acme.owner, { workItemId: a.id }),
      ),
    );

    const all = await board();
    const card = all.cards.find((entry) => entry.id === a.id)!;
    expect(card.epic?.id).toBe(epic.id);
    expect(card.assignee?.id).toBe(acme.owner.userId);
    expect(card.requirements).toEqual({ count: 1, keys: [requirement.key] });
    expect(all.total).toBe(3);

    expect((await board('&assigneeId=me')).cards.map((entry) => entry.id)).toEqual([a.id]);
    expect((await board('&assigneeId=none')).shown).toBe(2);
    expect((await board('&priority=high')).shown).toBe(1);
    expect((await board(`&epicId=${epic.id}`)).cards.map((entry) => entry.id)).toEqual([a.id]);
    expect((await board(`&featureId=none`)).shown).toBe(2);
    expect((await board(`&search=${encodeURIComponent(a.key)}`)).shown).toBe(1);
    expect((await board('&search=coupon')).cards.map((entry) => entry.id)).toEqual([b.id]);

    const byAssignee = await board('&swimlane=assignee');
    expect(byAssignee.swimlanes.map((lane) => lane.cardIds)).toEqual([[a.id], [b.id, c.id]]);
    expect(byAssignee.swimlanes.at(-1)?.title).toBe('Unassigned');
    const byEpic = await board('&swimlane=epic');
    expect(byEpic.swimlanes.map((lane) => lane.id)).toEqual([epic.id, null]);
  });
});
