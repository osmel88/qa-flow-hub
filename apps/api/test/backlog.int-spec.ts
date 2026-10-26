import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Backlog (S4-F2) over work items, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Backlog', () => {
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

  interface Item {
    id: string;
    key: string;
    type: string;
    status: string;
    version: number;
    parentId: string | null;
    releaseId: string | null;
  }

  const create = (
    payload: object,
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ) =>
    request(
      'POST',
      '/api/v1/work-items',
      as(account, { projectId: workspace.projectId, title: 'Saved cards', ...payload }, workspace),
    );

  const createItem = async (
    payload: object = {},
    workspace: TestWorkspace = acme,
  ): Promise<Item> => {
    const response = await create(payload, workspace.owner, workspace);
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

  const createRelease = async (workspace: TestWorkspace = acme, version = '1.0.0') => {
    const response = await request(
      'POST',
      '/api/v1/releases',
      as(
        workspace.owner,
        { projectId: workspace.projectId, name: `Release ${version}`, version },
        workspace,
      ),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };

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

  const backlog = async (
    query = '',
    account: TestAccount = acme.owner,
    workspace = acme,
  ): Promise<{
    items: Item[];
    groups: Array<{
      id: string | null;
      title: string;
      itemIds: string[];
      totals: { count: number; estimate: number; unestimated: number };
    }>;
    totals: { count: number; estimate: number; unestimated: number };
    truncated: boolean;
  }> => {
    const response = await request(
      'GET',
      `/api/v1/backlog?projectId=${workspace.projectId}${query}`,
      as(account, undefined, workspace),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const order = async (): Promise<string[]> => (await backlog()).items.map((item) => item.id);
  const move = (id: string, payload: object, account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/work-items/${id}/move`, as(account, payload));
  const bulk = (
    ids: string[],
    changes: object,
    account: TestAccount = acme.owner,
    workspace = acme,
  ) =>
    request(
      'POST',
      '/api/v1/work-items/bulk',
      as(account, { projectId: workspace.projectId, ids, changes }, workspace),
    );

  describe('order', () => {
    it('appends new items, reorders them persistently and audits the move', async () => {
      const [a, b, c] = [
        await createItem({ title: 'Item A' }),
        await createItem({ title: 'Item B' }),
        await createItem({ title: 'Item C' }),
      ];
      expect(await order()).toEqual([a.id, b.id, c.id]);
      const moved = await move(c.id, { beforeId: a.id });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().version).toBe(c.version);
      expect(await order()).toEqual([c.id, a.id, b.id]);
      expect((await move(c.id, { afterId: b.id })).statusCode).toBe(200);
      expect(await order()).toEqual([a.id, b.id, c.id]);
      expect((await move(a.id, { afterId: b.id })).statusCode).toBe(200);
      expect(await order()).toEqual([b.id, a.id, c.id]);
      const audit = await owner.auditLog.count({
        where: { entityType: 'WorkItem', summary: { contains: 'in the backlog' } },
      });
      expect(audit).toBe(3);
      expect((await move(a.id, { beforeId: a.id })).statusCode).toBe(400);
      expect((await move(a.id, {})).statusCode).toBe(400);
      expect((await move(a.id, { beforeId: b.id, afterId: c.id })).statusCode).toBe(400);
    });

    it('renumbers when a gap runs out without losing the order', async () => {
      const a = await createItem({ title: 'Item A' });
      const b = await createItem({ title: 'Item B' });
      const others = [];
      for (let index = 0; index < 12; index += 1) {
        others.push(await createItem({ title: `Item ${index}` }));
      }
      // Repeatedly squeeze items between a and b: the 1024 gap halves each time.
      for (const item of others) {
        expect((await move(item.id, { afterId: a.id })).statusCode).toBe(200);
      }
      const ids = await order();
      expect(ids[0]).toBe(a.id);
      expect(ids[ids.length - 1]).toBe(b.id);
      expect(ids.slice(1, -1)).toEqual([...others].reverse().map((item) => item.id));
      const ranks = (await owner.workItem.findMany({ select: { rank: true } })).map(
        (row) => row.rank,
      );
      expect(new Set(ranks).size).toBe(ranks.length);
    });

    it('keeps a consistent order under concurrent moves', async () => {
      const items = [];
      for (let index = 0; index < 6; index += 1) {
        items.push(await createItem({ title: `Item ${index}` }));
      }
      const first = items[0]!;
      const responses = await Promise.all(
        items.slice(1).map((item) => move(item.id, { beforeId: first.id })),
      );
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      const ids = await order();
      expect(new Set(ids).size).toBe(6);
      expect(ids[ids.length - 1]).toBe(first.id);
      const ranks = (await owner.workItem.findMany({ select: { rank: true } })).map(
        (row) => row.rank,
      );
      expect(new Set(ranks).size).toBe(6);
    });

    it('refuses anchors of another project or tenant like missing ones', async () => {
      const item = await createItem();
      const foreign = await createItem({}, globex);
      const missing = await move(item.id, { beforeId: 'cl_missing' });
      expect(missing.statusCode).toBe(404);
      const cross = await move(item.id, { beforeId: foreign.id });
      expect(cross.statusCode).toBe(404);
      expect(errorOf(cross)).toEqual(errorOf(missing));
      const hijack = await request(
        'POST',
        `/api/v1/work-items/${item.id}/move`,
        as(globex.owner, { beforeId: foreign.id }, globex),
      );
      expect(hijack.statusCode).toBe(404);
      const viewer = await acme.addMember('viewer');
      const other = await createItem();
      expect((await move(item.id, { afterId: other.id }, viewer)).statusCode).toBe(403);
    });
  });

  describe('views', () => {
    it('groups by epic and feature with estimate totals', async () => {
      const epic = await createItem({ type: 'epic', title: 'Checkout' });
      const feature = await createItem({ type: 'feature', title: 'Cards', parentId: epic.id });
      const story = await createItem({
        type: 'story',
        title: 'Saved cards',
        parentId: feature.id,
        estimate: 5,
      });
      const loose = await createItem({ type: 'bug', title: 'Loose bug', estimate: 2.5 });
      const byEpic = await backlog('&groupBy=epic');
      expect(byEpic.groups.map((group) => group.title)).toEqual(['Checkout', 'No epic']);
      expect(byEpic.groups[0]?.itemIds).toEqual([epic.id, feature.id, story.id]);
      expect(byEpic.groups[0]?.totals).toEqual({ count: 3, estimate: 5, unestimated: 2 });
      expect(byEpic.groups[1]?.itemIds).toEqual([loose.id]);
      const byFeature = await backlog('&groupBy=feature');
      expect(byFeature.groups.map((group) => group.title)).toEqual(['No feature', 'Cards']);
      expect(byFeature.groups[0]?.itemIds).toEqual([epic.id, loose.id]);
      expect(byFeature.groups.find((group) => group.title === 'Cards')?.itemIds).toEqual([
        feature.id,
        story.id,
      ]);
      expect(byEpic.totals).toEqual({ count: 4, estimate: 7.5, unestimated: 2 });
    });

    it('filters the backlog by release, assignee (personal), closed and search', async () => {
      const tester = await acme.addMember('tester');
      const release = await createRelease();
      const planned = await createItem({ title: 'Planned', releaseId: release.id });
      const mine = await createItem({ title: 'Mine', assigneeId: tester.userId });
      const done = await createItem({ title: 'Finished', status: 'done' });
      expect((await backlog(`&releaseId=${release.id}`)).items.map((i) => i.id)).toEqual([
        planned.id,
      ]);
      expect((await backlog('&releaseId=none')).items.map((i) => i.id)).toEqual([mine.id]);
      expect((await backlog('&assigneeId=me', tester)).items.map((i) => i.id)).toEqual([mine.id]);
      expect((await backlog('&assigneeId=me')).items).toEqual([]);
      expect((await backlog()).items.map((i) => i.id)).not.toContain(done.id);
      expect((await backlog('&includeClosed=true')).items.map((i) => i.id)).toContain(done.id);
      expect((await backlog('&search=plan')).items.map((i) => i.id)).toEqual([planned.id]);
    });

    it('returns an empty backlog for a hidden project or another tenant', async () => {
      await createItem({ title: 'Secret' });
      const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
      expect(await backlog('', outsider)).toMatchObject({
        items: [],
        groups: [],
        totals: { count: 0 },
      });
      const cross = await request(
        'GET',
        `/api/v1/backlog?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex),
      );
      expect(cross.json()).toMatchObject({ items: [], totals: { count: 0 } });
    });
  });

  describe('bulk actions', () => {
    it('applies changes to every item atomically and audits each', async () => {
      const tester = await acme.addMember('tester');
      const release = await createRelease();
      const a = await createItem({ title: 'Item A', labels: ['old'] });
      const b = await createItem({ title: 'Item B' });
      const response = await bulk([a.id, b.id], {
        status: 'ready',
        priority: 'high',
        assigneeId: tester.userId,
        releaseId: release.id,
        estimate: 3,
        addLabels: ['Sprint 1'],
        removeLabels: ['old'],
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().updated).toHaveLength(2);
      const rows = await owner.workItem.findMany({ orderBy: { rank: 'asc' } });
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'ready',
          priority: 'high',
          assigneeId: tester.userId,
          releaseId: release.id,
          estimate: 3,
          labels: ['sprint 1'],
        });
      }
      expect(
        await owner.auditLog.count({ where: { summary: { startsWith: 'Bulk updated' } } }),
      ).toBe(2);
    });

    it('changes nothing when one id is missing, foreign or invalid', async () => {
      const a = await createItem({ title: 'Item A' });
      const foreign = await createItem({}, globex);
      for (const ids of [
        [a.id, 'cl_missing'],
        [a.id, foreign.id],
      ]) {
        const response = await bulk(ids, { status: 'done' });
        expect(response.statusCode).toBe(404);
      }
      const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
      expect((await bulk([a.id], { assigneeId: outsider.userId })).statusCode).toBe(400);
      expect((await bulk([a.id, a.id], { status: 'done' })).statusCode).toBe(400);
      expect((await bulk([a.id], {})).statusCode).toBe(400);
      const release = await createRelease();
      await request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner));
      expect((await bulk([a.id], { releaseId: release.id })).statusCode).toBe(409);
      expect((await bulk([a.id], { status: 'done' }, globex.owner, globex)).statusCode).toBe(404);
      const viewer = await acme.addMember('viewer');
      expect((await bulk([a.id], { status: 'done' }, viewer)).statusCode).toBe(403);
      const stored = await owner.workItem.findUniqueOrThrow({ where: { id: a.id } });
      expect(stored).toMatchObject({
        status: 'backlog',
        assigneeId: null,
        releaseId: null,
        version: 1,
      });
    });

    it('serialises overlapping bulk edits without deadlock or lost updates', async () => {
      const items = [];
      for (let index = 0; index < 5; index += 1) {
        items.push(await createItem({ title: `Item ${index}` }));
      }
      const ids = items.map((item) => item.id);
      const responses = await Promise.all([
        bulk(ids, { addLabels: ['alpha'] }),
        bulk([...ids].reverse(), { addLabels: ['beta'] }),
        bulk(ids.slice(1, 3), { priority: 'low' }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
      const rows = await owner.workItem.findMany();
      for (const row of rows) {
        expect([...row.labels].sort()).toEqual(['alpha', 'beta']);
        expect(row.version).toBe(ids.slice(1, 3).includes(row.id) ? 4 : 3);
      }
    });
  });
});
