import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Development status (S5-F2), derived from development links, with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Development status', () => {
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

  interface Summary {
    status: string;
    evidence: string[];
    counts: Record<string, number>;
  }

  const item = async (title: string) =>
    ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(acme.owner, { projectId: acme.projectId, title }),
      ),
      201,
    );
  const artifact = async (body: object) =>
    ok<{ id: string; version: number }>(
      await request(
        'POST',
        '/api/v1/development-artifacts',
        as(acme.owner, { projectId: acme.projectId, ...body }),
      ),
      201,
    );
  const patch = async (id: string, body: object) =>
    ok(await request('PATCH', `/api/v1/development-artifacts/${id}`, as(acme.owner, body)));
  const statusOf = async (workItemId: string): Promise<Summary> =>
    ok<{ summary: Summary }>(
      await request('GET', `/api/v1/work-items/${workItemId}/development`, as(acme.owner)),
    ).summary;
  const link = (artifactId: string, workItemId: string) =>
    request('POST', `/api/v1/work-items/${workItemId}/development`, as(acme.owner, { artifactId }));
  const chain = async (workItemId: string) =>
    (
      await owner.auditLog.findMany({
        where: { entityId: workItemId, summary: { startsWith: 'Development status of' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(
      (log) =>
        (log.changes as { developmentStatus: { from: string; to: string } }).developmentStatus,
    );
  const expectChained = (steps: Array<{ from: string; to: string }>) => {
    expect(steps[0]?.from).toBe('no_development');
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]?.from).toBe(steps[index - 1]?.to);
    }
  };

  it('derives the status from every combination of links and audits each change', async () => {
    const a = await item('Card payment form');
    expect((await statusOf(a.id)).status).toBe('no_development');
    await artifact({ kind: 'branch', branchName: 'feature/cards', workItemIds: [a.id] });
    expect((await statusOf(a.id)).status).toBe('branch_created');
    await artifact({ kind: 'commit', commitSha: 'abc1234', workItemIds: [a.id] });
    expect((await statusOf(a.id)).status).toBe('commits');
    const pr = await artifact({
      kind: 'pull_request',
      prNumber: 1,
      status: 'open',
      workItemIds: [a.id],
    });
    expect((await statusOf(a.id)).status).toBe('pr_open');
    await patch(pr.id, { status: 'approved' });
    expect((await statusOf(a.id)).status).toBe('pr_approved');
    await patch(pr.id, { status: 'merged' });
    expect((await statusOf(a.id)).status).toBe('merged');
    const build = await artifact({
      kind: 'build',
      identifier: 'b-1',
      status: 'running',
      workItemIds: [a.id],
    });
    expect((await statusOf(a.id)).status).toBe('build_running');
    await patch(build.id, { status: 'failed' });
    const failed = await statusOf(a.id);
    expect([failed.status, failed.evidence]).toEqual(['build_failed', [build.id]]);
    const deployment = await artifact({
      kind: 'deployment',
      identifier: 'd-1',
      status: 'succeeded',
      workItemIds: [a.id],
    });
    expect((await statusOf(a.id)).status).toBe('deployed');
    // Deleted artifacts and removed links stop counting.
    expect(
      (await request('DELETE', `/api/v1/development-artifacts/${deployment.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(204);
    expect((await statusOf(a.id)).status).toBe('build_failed');
    expect(
      (
        await request(
          'DELETE',
          `/api/v1/work-items/${a.id}/development/${build.id}`,
          as(acme.owner),
        )
      ).statusCode,
    ).toBe(204);
    const merged = await statusOf(a.id);
    expect([merged.status, merged.evidence]).toEqual(['merged', [pr.id]]);
    expect(merged.counts).toMatchObject({
      branch: 1,
      commit: 1,
      pull_request: 1,
      build: 0,
      deployment: 0,
    });

    const steps = await chain(a.id);
    expectChained(steps);
    expect(steps.map((step) => step.to)).toEqual([
      'branch_created',
      'commits',
      'pr_open',
      'pr_approved',
      'merged',
      'build_running',
      'build_failed',
      'deployed',
      'build_failed',
      'merged',
    ]);
    // A status change of the PR shared by two items is audited on both.
    const b = await item('Second item');
    ok(await link(pr.id, b.id));
    await patch(pr.id, { status: 'closed' });
    expect((await statusOf(a.id)).status).toBe('commits');
    expect((await statusOf(b.id)).status).toBe('no_development');
    expect((await chain(b.id)).map((step) => step.to)).toEqual(['merged', 'no_development']);
  });

  it('filters and badges work items by development status in every view', async () => {
    const a = await item('Deployed item');
    const b = await item('Failing item');
    const c = await item('Untouched item');
    await artifact({
      kind: 'deployment',
      identifier: 'd-1',
      status: 'succeeded',
      workItemIds: [a.id],
    });
    await artifact({ kind: 'build', identifier: 'b-1', status: 'failed', workItemIds: [b.id] });
    const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
    const get = async <T>(path: string) =>
      ok<T>(await request('GET', `/api/v1${path}`, as(acme.owner)));
    const project = `projectId=${acme.projectId}`;

    expect(
      ids(
        (
          await get<{ data: Array<{ id: string }> }>(
            `/work-items?${project}&developmentStatus=deployed`,
          )
        ).data,
      ),
    ).toEqual([a.id]);
    expect(
      ids(
        (
          await get<{ data: Array<{ id: string }> }>(
            `/work-items?${project}&developmentStatus=no_development`,
          )
        ).data,
      ),
    ).toEqual([c.id]);
    const backlog = await get<{
      items: Array<{ id: string }>;
      developmentStatuses: Record<string, string>;
    }>(`/backlog?${project}&developmentStatus=build_failed`);
    expect(ids(backlog.items)).toEqual([b.id]);
    expect(backlog.developmentStatuses).toEqual({ [b.id]: 'build_failed' });
    const tree = await get<{
      roots: Array<{ item: { id: string } }>;
      developmentStatuses: Record<string, string>;
    }>(`/work-items/tree?${project}`);
    expect(tree.developmentStatuses).toMatchObject({
      [a.id]: 'deployed',
      [b.id]: 'build_failed',
      [c.id]: 'no_development',
    });
    expect(
      (
        await get<{ roots: Array<{ item: { id: string } }> }>(
          `/work-items/tree?${project}&developmentStatus=deployed`,
        )
      ).roots.map((root) => root.item.id),
    ).toEqual([a.id]);
    const kanban = await get<{ cards: Array<{ id: string; developmentStatus: string }> }>(
      `/kanban?${project}&developmentStatus=build_failed`,
    );
    expect(kanban.cards.map((card) => [card.id, card.developmentStatus])).toEqual([
      [b.id, 'build_failed'],
    ]);
    expect(
      (await request('GET', `/api/v1/kanban?${project}&developmentStatus=shipped`, as(acme.owner)))
        .statusCode,
    ).toBe(400);

    const summary = await get<{
      workItems: Record<string, number>;
      artifacts: Record<string, number>;
    }>(`/development-artifacts/summary?${project}`);
    expect(summary.workItems).toMatchObject({ deployed: 1, build_failed: 1, no_development: 1 });
    expect(summary.artifacts).toMatchObject({ deployment: 1, build: 1, commit: 0 });
  });

  it('keeps tenants and hidden projects apart', async () => {
    const a = await item('Deployed item');
    await artifact({
      kind: 'deployment',
      identifier: 'd-1',
      status: 'succeeded',
      workItemIds: [a.id],
    });
    const theirs = ok<{ workItems: Record<string, number> }>(
      await request(
        'GET',
        `/api/v1/development-artifacts/summary?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex),
      ),
    );
    expect(theirs.workItems['deployed']).toBe(0);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    const blind = ok<{ workItems: Record<string, number> }>(
      await request(
        'GET',
        `/api/v1/development-artifacts/summary?projectId=${acme.projectId}`,
        as(hidden),
      ),
    );
    expect(Object.values(blind.workItems).reduce((sum, value) => sum + value, 0)).toBe(0);
    expect(
      (
        await request(
          'GET',
          `/api/v1/work-items?projectId=${acme.projectId}&developmentStatus=deployed`,
          as(globex.owner, undefined, globex),
        )
      ).json<{ meta: { total: number } }>().meta.total,
    ).toBe(0);
  });

  it('stays deterministic and keeps a consistent audit chain under concurrent changes', async () => {
    const a = await item('Busy item');
    const artifacts = [
      await artifact({ kind: 'branch', branchName: 'feature/busy' }),
      await artifact({ kind: 'commit', commitSha: 'def5678' }),
      await artifact({ kind: 'pull_request', prNumber: 9, status: 'open' }),
      await artifact({ kind: 'build', identifier: 'b-9', status: 'running' }),
      await artifact({ kind: 'deployment', identifier: 'd-9', status: 'succeeded' }),
    ];
    const results = await Promise.all(artifacts.map((entry) => link(entry.id, a.id)));
    expect(results.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect((await statusOf(a.id)).status).toBe('deployed');
    const build = artifacts[3]!;
    const raced = await Promise.all([
      patch(build.id, { status: 'failed' }),
      request('DELETE', `/api/v1/development-artifacts/${artifacts[4]!.id}`, as(acme.owner)),
    ]);
    expect(raced).toHaveLength(2);
    expect((await statusOf(a.id)).status).toBe('build_failed');
    const steps = await chain(a.id);
    expectChained(steps);
    expect(steps.at(-1)?.to).toBe('build_failed');
  });
});
