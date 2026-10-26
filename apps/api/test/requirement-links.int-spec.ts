import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Requirement ↔ work item links (S4-F4), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Requirement ↔ work item links', () => {
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

  const createRequirement = async (
    workspace: TestWorkspace = acme,
    title = 'Customers pay by card',
    projectId = workspace.projectId,
  ): Promise<{ id: string; key: string }> => {
    const response = await request(
      'POST',
      '/api/v1/requirements',
      as(workspace.owner, { projectId, title }, workspace),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  };
  const link = (
    requirementId: string,
    workItemId: string,
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ) =>
    request(
      'POST',
      `/api/v1/requirements/${requirementId}/work-items`,
      as(account, { workItemId }, workspace),
    );
  const unlink = (requirementId: string, workItemId: string, account: TestAccount = acme.owner) =>
    request(
      'DELETE',
      `/api/v1/requirements/${requirementId}/work-items/${workItemId}`,
      as(account),
    );
  const implemented = async (requirementId: string, account: TestAccount = acme.owner) => {
    const response = await request(
      'GET',
      `/api/v1/requirements/${requirementId}/work-items`,
      as(account),
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      implementation: { state: string; workItems: number; progress: number | null };
      workItems: Array<{ workItemId: string; key: string; status: string }>;
    }>();
  };
  const setStatus = async (id: string, status: string) => {
    const response = await request('PATCH', `/api/v1/work-items/${id}`, as(acme.owner, { status }));
    expect(response.statusCode, response.body).toBe(200);
  };

  it('links, navigates both ways, dedupes, unlinks idempotently and audits', async () => {
    const requirement = await createRequirement();
    const item = await createItem({ title: 'Card form' });
    const first = await link(requirement.id, item.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ created: true, linkType: 'implements' });
    const again = await link(requirement.id, item.id);
    expect(again.json().created).toBe(false);
    expect(await owner.requirementWorkItemLink.count()).toBe(1);

    expect((await implemented(requirement.id)).workItems.map((row) => row.workItemId)).toEqual([
      item.id,
    ]);
    const reverse = await request(
      'GET',
      `/api/v1/work-items/${item.id}/requirements`,
      as(acme.owner),
    );
    expect(reverse.json().map((row: { requirementId: string }) => row.requirementId)).toEqual([
      requirement.id,
    ]);
    const detail = await request('GET', `/api/v1/work-items/${item.id}`, as(acme.owner));
    expect(detail.json().requirements[0]).toMatchObject({ key: requirement.key });

    // The work item side writes the same link.
    const second = await createItem({ title: 'Card storage' });
    const fromItem = await request(
      'POST',
      `/api/v1/work-items/${second.id}/requirements`,
      as(acme.owner, { requirementId: requirement.id }),
    );
    expect(fromItem.json().created).toBe(true);

    expect((await unlink(requirement.id, item.id)).statusCode).toBe(204);
    expect((await unlink(requirement.id, item.id)).statusCode).toBe(204);
    const audit = await owner.auditLog.findMany({
      where: { entityType: 'RequirementWorkItemLink' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((row) => row.action)).toEqual(['create', 'create', 'delete']);
  });

  it('derives the implementation state and filters requirements by it', async () => {
    const none = await createRequirement(acme, 'Nothing planned');
    const partial = await createRequirement(acme, 'Half done');
    const full = await createRequirement(acme, 'All done');
    const [a, b, c, d] = [
      await createItem({ title: 'Item A' }),
      await createItem({ title: 'Item B' }),
      await createItem({ title: 'Item C' }),
      await createItem({ title: 'Item D' }),
    ];
    await link(partial.id, a.id);
    await link(partial.id, b.id);
    await link(full.id, c.id);
    await link(full.id, d.id);
    await setStatus(a.id, 'done');
    await setStatus(c.id, 'done');
    await setStatus(d.id, 'cancelled');
    expect((await implemented(none.id)).implementation).toMatchObject({ state: 'not_implemented' });
    expect((await implemented(partial.id)).implementation).toMatchObject({
      state: 'partially_implemented',
      progress: 50,
    });
    expect((await implemented(full.id)).implementation).toMatchObject({ state: 'implemented' });
    const filter = async (state: string) => {
      const response = await request(
        'GET',
        `/api/v1/requirements?projectId=${acme.projectId}&implementation=${state}`,
        as(acme.owner),
      );
      return response.json().data.map((row: { id: string }) => row.id);
    };
    expect(await filter('not_implemented')).toEqual([none.id]);
    expect(await filter('partially_implemented')).toEqual([partial.id]);
    expect(await filter('implemented')).toEqual([full.id]);
    const detail = await request('GET', `/api/v1/requirements/${full.id}`, as(acme.owner));
    expect(detail.json().implementation.state).toBe('implemented');
  });

  it('refuses other projects, other tenants and hidden resources like missing ones', async () => {
    const requirement = await createRequirement();
    const item = await createItem();
    const otherProject = await createProject('OTH');
    const elsewhere = await createItem({ projectId: otherProject });
    const foreignItem = await createItem({}, globex);
    const foreignRequirement = await createRequirement(globex);
    const missing = await link(requirement.id, 'cl_missing');
    expect(missing.statusCode).toBe(404);
    for (const response of [
      await link(requirement.id, elsewhere.id),
      await link(requirement.id, foreignItem.id),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toEqual(errorOf(missing));
    }
    expect((await link(foreignRequirement.id, item.id)).statusCode).toBe(404);
    expect((await link(requirement.id, item.id, globex.owner, globex)).statusCode).toBe(404);
    const outsider = await acme.addMember('tester', 'outsider', { projectAccess: false });
    expect((await link(requirement.id, item.id, outsider)).statusCode).toBe(404);
    const viewer = await acme.addMember('viewer');
    expect((await link(requirement.id, item.id, viewer)).statusCode).toBe(403);
    expect((await unlink(requirement.id, item.id, viewer)).statusCode).toBe(403);
    const tester = await acme.addMember('tester');
    expect((await link(requirement.id, item.id, tester)).statusCode).toBe(200);
    expect(await owner.requirementWorkItemLink.count()).toBe(1);
    // The database itself refuses a cross-project row.
    await expect(
      owner.requirementWorkItemLink.create({
        data: {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
          requirementId: requirement.id,
          workItemId: elsewhere.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('hides links to deleted ends and refuses new ones', async () => {
    const requirement = await createRequirement();
    const item = await createItem();
    const other = await createItem({ title: 'Other item' });
    await link(requirement.id, item.id);
    await link(requirement.id, other.id);
    expect(
      (await request('DELETE', `/api/v1/work-items/${item.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect((await implemented(requirement.id)).workItems.map((row) => row.workItemId)).toEqual([
      other.id,
    ]);
    expect((await link(requirement.id, item.id)).statusCode).toBe(404);
    expect(
      (await request('DELETE', `/api/v1/requirements/${requirement.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(204);
    expect((await link(requirement.id, other.id)).statusCode).toBe(404);
    const reverse = await request(
      'GET',
      `/api/v1/work-items/${other.id}/requirements`,
      as(acme.owner),
    );
    expect(reverse.json()).toEqual([]);
  });

  it('stays consistent under concurrent link, unlink and delete', async () => {
    const requirement = await createRequirement();
    const item = await createItem();
    const burst = await Promise.all(Array.from({ length: 6 }, () => link(requirement.id, item.id)));
    expect(burst.every((response) => response.statusCode === 200)).toBe(true);
    expect(burst.filter((response) => response.json().created === true)).toHaveLength(1);
    expect(await owner.requirementWorkItemLink.count()).toBe(1);

    const mixed = await Promise.all([
      unlink(requirement.id, item.id),
      link(requirement.id, item.id),
      unlink(requirement.id, item.id),
      link(requirement.id, item.id),
    ]);
    expect(mixed.every((response) => [200, 204].includes(response.statusCode))).toBe(true);
    const rows = await owner.requirementWorkItemLink.count();
    const created = await owner.auditLog.count({
      where: { entityType: 'RequirementWorkItemLink', action: 'create' },
    });
    const removed = await owner.auditLog.count({
      where: { entityType: 'RequirementWorkItemLink', action: 'delete' },
    });
    expect(rows).toBe(created - removed);

    const target = await createItem({ title: 'Racing item' });
    const [linked, deleted] = await Promise.all([
      link(requirement.id, target.id),
      request('DELETE', `/api/v1/work-items/${target.id}`, as(acme.owner)),
    ]);
    expect(deleted.statusCode).toBe(204);
    expect([200, 404]).toContain(linked.statusCode);
    expect(
      (await implemented(requirement.id)).workItems.map((row) => row.workItemId),
    ).not.toContain(target.id);
  });

  it('extends the traceability matrix and the release view with work items', async () => {
    const requirement = await createRequirement();
    const release = (
      await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: acme.projectId, name: 'Release 1', version: '1.0.0' }),
      )
    ).json();
    const planned = await createItem({ title: 'Planned item', releaseId: release.id });
    const later = await createItem({ title: 'Later item' });
    await link(requirement.id, planned.id);
    await link(requirement.id, later.id);
    await setStatus(planned.id, 'done');
    const matrix = await request(
      'GET',
      `/api/v1/traceability/matrix?projectId=${acme.projectId}`,
      as(acme.owner),
    );
    expect(matrix.statusCode, matrix.body).toBe(200);
    const row = matrix
      .json()
      .rows.find((entry: { requirementId: string }) => entry.requirementId === requirement.id);
    expect(row.workItems.map((entry: { workItemId: string }) => entry.workItemId)).toEqual([
      planned.id,
      later.id,
    ]);
    expect(row.implementation.state).toBe('partially_implemented');
    expect(matrix.json().summary.implemented).toBe(0);
    const trace = await request(
      'GET',
      `/api/v1/releases/${release.id}/traceability`,
      as(acme.owner),
    );
    expect(trace.statusCode, trace.body).toBe(200);
    const releaseRow = trace
      .json()
      .rows.find((entry: { requirementId: string }) => entry.requirementId === requirement.id);
    expect(releaseRow.workItems.map((entry: { workItemId: string }) => entry.workItemId)).toEqual([
      planned.id,
    ]);
    expect(releaseRow.implementation.state).toBe('implemented');
  });
});
