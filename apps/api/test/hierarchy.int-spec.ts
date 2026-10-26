import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Hierarchy (S4-F3) over work items, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Hierarchy', () => {
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

  type Node = {
    item: Item & { title: string };
    matched: boolean;
    rollup: {
      count: number;
      estimate: number;
      progress: number | null;
      byStatus: Record<string, number>;
    };
    children: Node[];
  };
  const tree = async (
    query = '',
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ): Promise<{ roots: Node[]; totals: Node['rollup']; filtered: boolean }> => {
    const response = await request(
      'GET',
      `/api/v1/work-items/tree?projectId=${workspace.projectId}${query}`,
      as(account, undefined, workspace),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const reparent = (
    id: string,
    parentId: string | null,
    account: TestAccount = acme.owner,
    extra: object = {},
  ) => request('POST', `/api/v1/work-items/${id}/reparent`, as(account, { parentId, ...extra }));

  const seed = async () => {
    const epic = await createItem({ type: 'epic', title: 'Checkout' });
    const feature = await createItem({ type: 'feature', title: 'Cards', parentId: epic.id });
    const story = await createItem({
      type: 'story',
      title: 'Saved cards',
      parentId: feature.id,
      estimate: 5,
      status: 'done',
    });
    const bug = await createItem({
      type: 'bug',
      title: 'Expired card',
      parentId: feature.id,
      estimate: 2,
      status: 'in_progress',
    });
    const task = await createItem({
      type: 'task',
      title: 'Write tests',
      parentId: story.id,
      estimate: 1,
      status: 'cancelled',
    });
    const loose = await createItem({ type: 'story', title: 'Loose story' });
    return { epic, feature, story, bug, task, loose };
  };

  it('returns the tree in backlog order with rollups and progress', async () => {
    const { epic, feature, story, bug, task, loose } = await seed();
    const view = await tree();
    expect(view.roots.map((node) => node.item.id)).toEqual([epic.id, loose.id]);
    const [epicNode] = view.roots;
    expect(epicNode?.children.map((node) => node.item.id)).toEqual([feature.id]);
    expect(epicNode?.children[0]?.children.map((node) => node.item.id)).toEqual([story.id, bug.id]);
    expect(epicNode?.children[0]?.children[0]?.children[0]?.item.id).toBe(task.id);
    expect(epicNode?.rollup).toMatchObject({ count: 4, estimate: 8, progress: 33.3 });
    expect(epicNode?.rollup.byStatus).toMatchObject({
      done: 1,
      in_progress: 1,
      cancelled: 1,
      backlog: 1,
    });
    expect(view.totals.count).toBe(6);
    const detail = await request('GET', `/api/v1/work-items/${feature.id}`, as(acme.owner));
    expect(detail.json().rollup).toMatchObject({ count: 3, estimate: 8, progress: 50 });
    expect(detail.json().ancestors.map((node: Item) => node.id)).toEqual([epic.id]);
  });

  it('filters and searches inside the tree keeping ancestors for context', async () => {
    const { epic, feature, bug } = await seed();
    const view = await tree('&search=expired');
    expect(view.filtered).toBe(true);
    expect(view.roots.map((node) => node.item.id)).toEqual([epic.id]);
    expect(view.roots[0]?.matched).toBe(false);
    expect(view.roots[0]?.children[0]?.item.id).toBe(feature.id);
    expect(
      view.roots[0]?.children[0]?.children.map((node) => [node.item.id, node.matched]),
    ).toEqual([[bug.id, true]]);
    expect((await tree('&type=task')).roots).toHaveLength(1);
    expect((await tree('&status=blocked')).roots).toEqual([]);
    const subtree = await tree(`&rootId=${feature.id}`);
    expect(subtree.roots.map((node) => node.item.id)).toEqual([feature.id]);
    const foreign = await createItem({ type: 'epic' }, globex);
    const cross = await request(
      'GET',
      `/api/v1/work-items/tree?projectId=${acme.projectId}&rootId=${foreign.id}`,
      as(acme.owner),
    );
    expect(cross.statusCode).toBe(404);
  });

  it('moves items within the hierarchy, audited, refusing cycles and invalid ranks', async () => {
    const { epic, feature, story, loose } = await seed();
    const moved = await reparent(loose.id, feature.id);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().parentId).toBe(feature.id);
    const audit = await owner.auditLog.findFirst({
      where: { entityId: loose.id, summary: { startsWith: 'Reparented' } },
    });
    expect(audit?.summary).toContain(`under ${feature.key}`);
    expect((await reparent(loose.id, null)).json().parentId).toBeNull();
    // Cycles: an epic under its own descendant, an item under itself.
    expect((await reparent(epic.id, story.id)).statusCode).toBe(400);
    expect((await reparent(story.id, story.id)).statusCode).toBe(400);
    // Rank / depth: a feature under a story would exceed the hierarchy.
    expect((await reparent(feature.id, story.id)).statusCode).toBe(400);
    expect((await reparent(story.id, epic.id)).statusCode).toBe(200);
    expect((await reparent(story.id, feature.id, acme.owner, { version: 1 })).statusCode).toBe(409);
  });

  it('refuses parents of another project or tenant like missing ones', async () => {
    const { loose } = await seed();
    const foreign = await createItem({ type: 'epic' }, globex);
    const missing = await reparent(loose.id, 'cl_missing');
    const cross = await reparent(loose.id, foreign.id);
    expect(cross.statusCode).toBe(404);
    expect(errorOf(cross)).toEqual(errorOf(missing));
    const hijack = await request(
      'POST',
      `/api/v1/work-items/${loose.id}/reparent`,
      as(globex.owner, { parentId: foreign.id }, globex),
    );
    expect(hijack.statusCode).toBe(404);
    const viewer = await acme.addMember('viewer');
    expect((await reparent(loose.id, null, viewer)).statusCode).toBe(403);
    const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
    expect((await tree('', outsider)).roots).toEqual([]);
    expect((await tree('', globex.owner, globex)).roots.map((node) => node.item.id)).toEqual([
      foreign.id,
    ]);
  });

  it('keeps the tree valid when two reparents race', async () => {
    const epicA = await createItem({ type: 'epic', title: 'Epic A' });
    const featureB = await createItem({ type: 'feature', title: 'Feature B' });
    const storyC = await createItem({ type: 'story', title: 'Story C' });
    const results = await Promise.all([
      reparent(storyC.id, featureB.id),
      reparent(featureB.id, epicA.id),
      request('PATCH', `/api/v1/work-items/${featureB.id}`, as(acme.owner, { type: 'task' })),
    ]);
    expect(results.every((response) => [200, 400].includes(response.statusCode))).toBe(true);
    const rows = await owner.workItem.findMany();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const rankOf = {
      epic: 0,
      feature: 1,
      story: 2,
      bug: 2,
      improvement: 2,
      spike: 2,
      task: 3,
    } as const;
    for (const row of rows) {
      if (row.parentId !== null) {
        const parent = byId.get(row.parentId);
        expect(parent).toBeDefined();
        expect(rankOf[parent!.type]).toBeLessThan(rankOf[row.type]);
      }
    }
  });
});
