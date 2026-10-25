import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Work items (S4-F1), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Work items', () => {
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

  const patch = (id: string, payload: object, account: TestAccount = acme.owner) =>
    request('PATCH', `/api/v1/work-items/${id}`, as(account, payload));

  const list = async (
    query: string,
    account: TestAccount = acme.owner,
  ): Promise<{ data: Item[]; meta: { total: number } }> => {
    const response = await request(
      'GET',
      `/api/v1/work-items?projectId=${acme.projectId}${query}`,
      as(account),
    );
    expect(response.statusCode, response.body).toBe(200);
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

  const createProject = async (key: string, workspace: TestWorkspace = acme): Promise<string> => {
    const response = await request(
      'POST',
      '/api/v1/projects',
      as(workspace.owner, { name: `Project ${key}`, key }, workspace),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id;
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

  describe('CRUD', () => {
    it('creates, reads, edits, audits and soft deletes a work item', async () => {
      const tester = await acme.addMember('tester');
      const created = await create(
        {
          title: '  Pay with saved cards ',
          description: 'As a buyer…',
          type: 'story',
          priority: 'high',
          estimate: 5,
          labels: ['Payments', 'payments', 'UX'],
          assigneeId: tester.userId,
        },
        tester,
      );
      expect(created.statusCode, created.body).toBe(201);
      const item = created.json();
      expect(item).toMatchObject({
        key: 'WEB-W-1',
        title: 'Pay with saved cards',
        type: 'story',
        status: 'backlog',
        priority: 'high',
        estimate: 5,
        labels: ['payments', 'ux'],
        assigneeId: tester.userId,
        reporterId: tester.userId,
        version: 1,
        completedAt: null,
      });

      const done = await patch(item.id, { status: 'done', version: 1, estimate: null });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ status: 'done', estimate: null, version: 2 });
      expect(done.json().completedAt).not.toBeNull();
      const reopened = await patch(item.id, { status: 'in_progress' });
      expect(reopened.json()).toMatchObject({ completedAt: null, version: 3 });

      const read = await request('GET', `/api/v1/work-items/${item.id}`, as(acme.owner));
      expect(read.json()).toMatchObject({ key: 'WEB-W-1', ancestors: [], children: [] });

      const audit = await owner.auditLog.findMany({
        where: { entityType: 'WorkItem', entityId: item.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual(['create', 'update', 'update']);
      expect(audit[1]?.changes).toMatchObject({
        status: { from: 'backlog', to: 'done' },
        estimate: { from: 5, to: null },
      });

      const removed = await request('DELETE', `/api/v1/work-items/${item.id}`, as(acme.owner));
      expect(removed.statusCode).toBe(204);
      expect(
        (await request('GET', `/api/v1/work-items/${item.id}`, as(acme.owner))).statusCode,
      ).toBe(404);
      expect(await owner.workItem.count({ where: { id: item.id, deletedAt: { not: null } } })).toBe(
        1,
      );
    });

    it('filters and searches without leaking other projects', async () => {
      const release = await createRelease();
      const epic = await createItem({ type: 'epic', title: 'Checkout revamp' });
      await createItem({
        type: 'story',
        parentId: epic.id,
        labels: ['payments'],
        releaseId: release.id,
      });
      await createItem({
        type: 'bug',
        title: 'Coupon ignored',
        status: 'blocked',
        priority: 'critical',
      });
      await createItem({ type: 'task', title: 'Write docs', status: 'done' });
      await createItem({ title: 'Other project story' }, globex);

      expect((await list('&type=bug')).meta.total).toBe(1);
      expect((await list('&status=blocked')).data[0]?.type).toBe('bug');
      expect((await list('&priority=critical')).meta.total).toBe(1);
      expect((await list(`&parentId=${epic.id}`)).meta.total).toBe(1);
      expect((await list('&parentId=none')).meta.total).toBe(3);
      expect((await list(`&releaseId=${release.id}`)).meta.total).toBe(1);
      expect((await list('&releaseId=none')).meta.total).toBe(3);
      expect((await list('&label=Payments')).meta.total).toBe(1);
      expect((await list('&open=false')).meta.total).toBe(1);
      expect((await list('&open=true')).meta.total).toBe(3);
      expect((await list('&search=coupon')).meta.total).toBe(1);
      expect((await list('&search=web-w-1')).data.map((item) => item.key)).toEqual(['WEB-W-1']);
      expect((await list('&search=other')).meta.total).toBe(0);
      expect((await list('&assigneeId=none')).meta.total).toBe(4);
    });

    it('rejects invalid input with clear errors', async () => {
      for (const payload of [
        { title: 'ab' },
        { type: 'saga' },
        { status: 'closed' },
        { estimate: -1 },
        { estimate: 1.234 },
        { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      ]) {
        const response = await create(payload);
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const item = await createItem();
      expect((await patch(item.id, {})).statusCode).toBe(400);
      expect((await patch(item.id, { version: 1 })).statusCode).toBe(400);
      expect(await owner.workItem.count()).toBe(1);
    });

    it('refuses work items in an archived project', async () => {
      await request('POST', `/api/v1/projects/${acme.projectId}/archive`, as(acme.owner));
      const project = await owner.project.findUniqueOrThrow({ where: { id: acme.projectId } });
      if (project.archivedAt === null) {
        await owner.project.update({
          where: { id: acme.projectId },
          data: { status: 'archived', archivedAt: new Date() },
        });
      }
      const response = await create({});
      expect(response.statusCode).toBe(409);
    });
  });

  describe('hierarchy', () => {
    it('enforces the ranked hierarchy on create, move and type change', async () => {
      const epic = await createItem({ type: 'epic' });
      const feature = await createItem({ type: 'feature', parentId: epic.id });
      const story = await createItem({ type: 'story', parentId: feature.id });
      const task = await createItem({ type: 'task', parentId: story.id });

      expect((await create({ type: 'epic', parentId: feature.id })).statusCode).toBe(400);
      expect((await create({ type: 'story', parentId: task.id })).statusCode).toBe(400);
      // Moving the epic under its own grandchild would be a cycle: the rank refuses it.
      expect((await patch(epic.id, { parentId: story.id })).statusCode).toBe(400);
      expect((await patch(story.id, { parentId: story.id })).statusCode).toBe(400);
      // A story with a task cannot become a task; a feature with a story cannot become a story.
      expect((await patch(story.id, { type: 'task' })).statusCode).toBe(400);
      expect((await patch(feature.id, { type: 'story' })).statusCode).toBe(400);
      // ...and a child cannot be retyped above its parent.
      expect((await patch(story.id, { type: 'epic' })).statusCode).toBe(400);
      expect((await patch(story.id, { type: 'bug' })).statusCode).toBe(200);

      const detail = await request('GET', `/api/v1/work-items/${story.id}`, as(acme.owner));
      expect(detail.json().ancestors.map((item: Item) => item.id)).toEqual([epic.id, feature.id]);
      expect(detail.json().children.map((item: Item) => item.id)).toEqual([task.id]);

      const blocked = await request('DELETE', `/api/v1/work-items/${story.id}`, as(acme.owner));
      expect(blocked.statusCode).toBe(409);
      expect((await patch(task.id, { parentId: null })).statusCode).toBe(200);
      expect(
        (await request('DELETE', `/api/v1/work-items/${story.id}`, as(acme.owner))).statusCode,
      ).toBe(204);
      expect((await create({ type: 'task', parentId: story.id })).statusCode).toBe(404);
    });

    it('refuses a parent of another project or tenant like a missing one', async () => {
      const otherProject = await createProject('OTH');
      const foreignProject = await request(
        'POST',
        '/api/v1/work-items',
        as(acme.owner, { projectId: otherProject, title: 'Other epic', type: 'epic' }),
      );
      const foreignTenant = await createItem({ type: 'epic' }, globex);
      const missing = await create({ parentId: 'cl_missing_item' });
      expect(missing.statusCode).toBe(404);
      for (const parentId of [foreignProject.json().id, foreignTenant.id]) {
        const response = await create({ parentId });
        expect(response.statusCode).toBe(404);
        expect(errorOf(response)).toEqual(errorOf(missing));
        const item = await createItem();
        const moved = await patch(item.id, { parentId });
        expect(moved.statusCode).toBe(404);
        expect(errorOf(moved)).toEqual(errorOf(missing));
      }
      // The composite foreign key refuses a cross-project parent even if the service did not.
      const item = await createItem();
      await expect(
        owner.workItem.update({
          where: { id: item.id },
          data: { parentId: foreignProject.json().id },
        }),
      ).rejects.toThrow();
    });

    it('serialises concurrent moves so the tree stays valid', async () => {
      const epic = await createItem({ type: 'epic' });
      const feature = await createItem({ type: 'feature' });
      // Each change is valid alone; together they would put an epic under a feature
      // that the epic contains. Exactly one must win.
      const [toEpic, retype] = await Promise.all([
        patch(feature.id, { parentId: epic.id }),
        patch(epic.id, { type: 'story' }),
      ]);
      expect([toEpic.statusCode, retype.statusCode].sort()).toEqual([200, 400]);
      const rows = await owner.workItem.findMany({ where: { id: { in: [epic.id, feature.id] } } });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const child = byId.get(feature.id);
      if (child?.parentId === epic.id) {
        expect(byId.get(epic.id)?.type).toBe('epic');
      }
    });

    it('never leaves a child under a parent deleted concurrently', async () => {
      const epic = await createItem({ type: 'epic' });
      const [child, removed] = await Promise.all([
        create({ type: 'feature', parentId: epic.id }),
        request('DELETE', `/api/v1/work-items/${epic.id}`, as(acme.owner)),
      ]);
      const outcome = [child.statusCode, removed.statusCode].sort();
      expect([
        [201, 409],
        [204, 404],
      ]).toContainEqual(outcome);
      const orphans = await owner.workItem.count({
        where: { deletedAt: null, parent: { deletedAt: { not: null } } },
      });
      expect(orphans).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('lets one of two edits of the same version win', async () => {
      const item = await createItem();
      const responses = await Promise.all([
        patch(item.id, { title: 'First editor', version: 1 }),
        patch(item.id, { title: 'Second editor', version: 1 }),
        patch(item.id, { title: 'Third editor', version: 1 }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409]);
      const stored = await owner.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(stored.version).toBe(2);
      expect(await owner.auditLog.count({ where: { entityId: item.id, action: 'update' } })).toBe(
        1,
      );
    });

    it('never hands out the same key twice', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) => create({ title: `Parallel ${index}` })),
      );
      expect(responses.every((response) => response.statusCode === 201)).toBe(true);
      const keys = responses.map((response) => response.json().key as string);
      expect(new Set(keys).size).toBe(10);
    });
  });

  describe('releases', () => {
    it('plans items in open releases of the same project only', async () => {
      const release = await createRelease();
      const otherProject = await createProject('OTH');
      const otherRelease = await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: otherProject, name: 'Other', version: '9.0.0' }),
      );
      const foreignRelease = await createRelease(globex);

      const item = await createItem({ releaseId: release.id });
      expect(item.releaseId).toBe(release.id);
      for (const releaseId of [otherRelease.json().id, foreignRelease.id, 'cl_missing']) {
        expect((await create({ releaseId })).statusCode).toBe(404);
      }

      await request('POST', `/api/v1/releases/${release.id}/start`, as(acme.owner));
      await request('POST', `/api/v1/releases/${release.id}/release`, as(acme.owner));
      expect((await create({ releaseId: release.id })).statusCode).toBe(409);
      // Moving an item out of a shipped release would rewrite its history.
      expect((await patch(item.id, { releaseId: null })).statusCode).toBe(409);
      const stored = await owner.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(stored.releaseId).toBe(release.id);
      // Editing anything else keeps working.
      expect((await patch(item.id, { status: 'done' })).statusCode).toBe(200);
    });

    it('does not attach an item to a release archived at the same moment', async () => {
      const release = await createRelease();
      const [attached, archived] = await Promise.all([
        create({ releaseId: release.id }),
        request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner)),
      ]);
      expect(archived.statusCode).toBe(200);
      expect([201, 409]).toContain(attached.statusCode);
      const items = await owner.workItem.count({ where: { releaseId: release.id } });
      expect(items).toBe(attached.statusCode === 201 ? 1 : 0);
    });
  });

  describe('permissions and isolation', () => {
    it('lets viewers read, testers write and only managers delete', async () => {
      const viewer = await acme.addMember('viewer');
      const tester = await acme.addMember('tester');
      const item = await createItem();
      expect((await create({}, viewer)).statusCode).toBe(403);
      expect((await patch(item.id, { title: 'Viewer edit' }, viewer)).statusCode).toBe(403);
      expect((await list('', viewer)).meta.total).toBe(1);
      expect((await patch(item.id, { title: 'Tester edit' }, tester)).statusCode).toBe(200);
      expect(
        (await request('DELETE', `/api/v1/work-items/${item.id}`, as(tester))).statusCode,
      ).toBe(403);
    });

    it('hides items of another tenant or a hidden project, also from counts', async () => {
      const item = await createItem({ title: 'Secret roadmap' });
      const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
      const missing = await request('GET', '/api/v1/work-items/cl_missing', as(acme.owner));
      expect(missing.statusCode).toBe(404);

      for (const [account, workspace] of [
        [globex.owner, globex],
        [outsider, acme],
      ] as const) {
        const read = await request(
          'GET',
          `/api/v1/work-items/${item.id}`,
          as(account, undefined, workspace),
        );
        expect(read.statusCode).toBe(404);
        expect(errorOf(read)).toEqual(errorOf(missing));
        const edit = await request(
          'PATCH',
          `/api/v1/work-items/${item.id}`,
          as(account, { title: 'Hijacked' }, workspace),
        );
        expect([403, 404]).toContain(edit.statusCode);
        const listed = await request(
          'GET',
          `/api/v1/work-items?projectId=${acme.projectId}&search=secret`,
          as(account, undefined, workspace),
        );
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({ data: [], meta: { total: 0 } });
        const created = await request(
          'POST',
          '/api/v1/work-items',
          as(account, { projectId: acme.projectId, title: 'Planted item' }, workspace),
        );
        expect(created.statusCode).toBe(404);
      }
      const stored = await owner.workItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(stored.title).toBe('Secret roadmap');
      expect(await owner.workItem.count()).toBe(1);
    });

    it('stops access as soon as the project grant is revoked', async () => {
      const tester = await acme.addMember('tester');
      const item = await createItem();
      expect((await request('GET', `/api/v1/work-items/${item.id}`, as(tester))).statusCode).toBe(
        200,
      );
      const revoke = await request(
        'DELETE',
        `/api/v1/projects/${acme.projectId}/members/${tester.userId}`,
        as(acme.owner),
      );
      expect([200, 204]).toContain(revoke.statusCode);
      expect((await request('GET', `/api/v1/work-items/${item.id}`, as(tester))).statusCode).toBe(
        404,
      );
      expect((await list('', tester)).meta.total).toBe(0);
    });

    it('only assigns members who can see the project', async () => {
      const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
      expect((await create({ assigneeId: outsider.userId })).statusCode).toBe(400);
      expect((await create({ assigneeId: globex.owner.userId })).statusCode).toBe(400);
      const item = await createItem();
      expect((await patch(item.id, { assigneeId: globex.owner.userId })).statusCode).toBe(400);
    });

    it('keeps the row invisible to another tenant at the database level', async () => {
      await createItem();
      const appRole = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
      try {
        const rows = await appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization', ${globex.organizationId}, true)`;
          return tx.workItem.count();
        });
        expect(rows).toBe(0);
        await expect(appRole.$executeRaw`DELETE FROM "work_items"`).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await appRole.$disconnect();
      }
    });
  });
});
