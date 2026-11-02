import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Builds (S5-F4), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Builds', () => {
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

  interface Build {
    id: string;
    status: string;
    version: number;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    release: { id: string } | null;
    workItems: Array<{ workItemId: string }>;
    related: { branchId: string | null; commitId: string | null };
    logSummary: string | null;
    metadata: { facts: Record<string, unknown> } | null;
  }

  const item = async (title: string, workspace: TestWorkspace = acme, projectId?: string) =>
    ok<{ id: string; key: string }>(
      await request(
        'POST',
        '/api/v1/work-items',
        as(workspace.owner, { projectId: projectId ?? workspace.projectId, title }, workspace),
      ),
      201,
    );
  const release = async (version: string, projectId = acme.projectId) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId, name: `Release ${version}`, version }),
      ),
      201,
    );
  const report = (
    body: object,
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ) =>
    request(
      'POST',
      '/api/v1/builds',
      as(account, { projectId: workspace.projectId, ...body }, workspace),
    );
  const build = async (body: object) =>
    ok<{ created: boolean; build: Build }>(await report(body)).build;
  const move = (
    id: string,
    status: string,
    account: TestAccount = acme.owner,
    extra: object = {},
  ) => request('POST', `/api/v1/builds/${id}/transition`, as(account, { status, ...extra }));
  const statusOf = async (id: string) =>
    ok<{ summary: { status: string; evidence: string[] } }>(
      await request('GET', `/api/v1/work-items/${id}/development`, as(acme.owner)),
    ).summary;
  const list = async (params: string, account: TestAccount = acme.owner) =>
    ok<{ data: Build[]; meta: { total: number } }>(
      await request('GET', `/api/v1/builds?projectId=${acme.projectId}${params}`, as(account)),
    );

  it('follows the lifecycle, refuses invalid and terminal transitions and drives development status', async () => {
    const story = await item('Card payment form');
    const queued = await build({
      identifier: 'ci-1',
      workItemIds: [story.id],
      branchName: 'feature/cards',
    });
    expect([queued.status, queued.startedAt, queued.finishedAt]).toEqual(['queued', null, null]);
    expect((await statusOf(story.id)).status).toBe('build_running');

    const skipped = await move(queued.id, 'passed');
    expect([skipped.statusCode, errorOf(skipped).code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    const running = ok<Build>(await move(queued.id, 'running'));
    expect(running.startedAt).not.toBeNull();
    const started = Date.parse(running.startedAt!);
    const passed = ok<Build>(
      await move(queued.id, 'passed', acme.owner, { at: new Date(started + 90_000).toISOString() }),
    );
    expect([passed.status, passed.durationMs]).toEqual(['passed', 90_000]);
    expect(await statusOf(story.id)).toMatchObject({
      status: 'build_passed',
      evidence: [queued.id],
    });

    for (const status of ['running', 'queued', 'failed', 'passed']) {
      expect((await move(queued.id, status)).statusCode).toBe(422);
    }
    const generic = await request(
      'PATCH',
      `/api/v1/development-artifacts/${queued.id}`,
      as(acme.owner, { status: 'running' }),
    );
    expect([generic.statusCode, errorOf(generic).code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    expect((await move(queued.id, 'cancelled', acme.owner, { version: 1 })).statusCode).toBe(409);

    // A newer failing build is what the story shows; finishing before start is refused.
    const second = await build({ identifier: 'ci-2', status: 'running', workItemIds: [story.id] });
    expect(
      (await move(second.id, 'failed', acme.owner, { at: '2000-01-01T00:00:00.000Z' })).statusCode,
    ).toBe(400);
    ok(await move(second.id, 'failed'));
    expect((await statusOf(story.id)).status).toBe('build_failed');

    const audits = await owner.auditLog.findMany({
      where: { entityId: story.id, summary: { startsWith: 'Development status of' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(
      audits.map(
        (log) => (log.changes as { developmentStatus: { to: string } }).developmentStatus.to,
      ),
    ).toEqual(['build_running', 'build_passed', 'build_running', 'build_failed']);
  });

  it('is idempotent per provider and externalId, also under concurrency, and refuses duplicates', async () => {
    const first = ok<{ created: boolean; build: Build }>(
      await report({
        identifier: 'run-1',
        provider: 'github',
        externalId: 'gh-100',
        status: 'running',
      }),
    );
    const again = ok<{ created: boolean; build: Build }>(
      await report({
        identifier: 'run-1',
        provider: 'github',
        externalId: 'gh-100',
        status: 'passed',
      }),
    );
    expect([first.created, again.created, again.build.id, again.build.status]).toEqual([
      true,
      false,
      first.build.id,
      'running',
    ]);
    const racing = await Promise.all(
      Array.from({ length: 5 }, () =>
        report({ identifier: 'run-2', provider: 'gitlab', externalId: 'gl-7', status: 'queued' }),
      ),
    );
    expect(racing.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const results = racing.map((response) => response.json<{ created: boolean; build: Build }>());
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.build.id)).size).toBe(1);
    expect(
      await owner.developmentArtifact.count({ where: { externalId: 'gl-7', deletedAt: null } }),
    ).toBe(1);

    const duplicate = await report({ identifier: 'run-1', provider: 'github' });
    expect([duplicate.statusCode, errorOf(duplicate).code]).toEqual([409, 'DUPLICATE_RESOURCE']);
    expect((await report({ identifier: 'run-1' })).statusCode).toBe(200);
    expect(
      (await request('DELETE', `/api/v1/development-artifacts/${first.build.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(204);
    const reborn = ok<{ created: boolean; build: Build }>(
      await report({ identifier: 'run-1', provider: 'github', externalId: 'gh-100' }),
    );
    expect(reborn.created).toBe(true);
    expect(reborn.build.id).not.toBe(first.build.id);
  });

  it('applies concurrent transitions one at a time', async () => {
    for (let round = 0; round < 3; round += 1) {
      const running = await build({ identifier: `race-${round}`, status: 'running' });
      const results = await Promise.all(
        ['passed', 'failed', 'cancelled'].map((status) => move(running.id, status)),
      );
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 422, 422]);
      const winner = results.find((response) => response.statusCode === 200)!.json<Build>();
      const row = await owner.developmentArtifact.findUniqueOrThrow({ where: { id: running.id } });
      expect(row.status).toBe(winner.status);
      expect(
        await owner.auditLog.count({ where: { entityId: running.id, summary: { contains: '→' } } }),
      ).toBe(1);
    }
    const queued = await build({ identifier: 'edits' });
    const edits = await Promise.all([
      request('PATCH', `/api/v1/builds/${queued.id}`, as(acme.owner, { title: 'One', version: 1 })),
      request('PATCH', `/api/v1/builds/${queued.id}`, as(acme.owner, { title: 'Two', version: 1 })),
    ]);
    expect(edits.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it('keeps releases, work items, tenants and permissions apart', async () => {
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const otherRelease = await release('9.0.0', project.id);
    const otherItem = await item('Mobile item', acme, project.id);
    const foreignItem = await item('Globex item', globex);
    expect((await report({ identifier: 'x', releaseId: otherRelease.id })).statusCode).toBe(404);
    expect((await report({ identifier: 'x', workItemIds: [otherItem.id] })).statusCode).toBe(404);
    expect((await report({ identifier: 'x', workItemIds: [foreignItem.id] })).statusCode).toBe(404);
    expect(await owner.developmentArtifact.count({ where: { identifier: 'x' } })).toBe(0);

    const r1 = await release('1.0.0');
    const story = await item('Story');
    const ours = await build({
      identifier: 'ci-9',
      releaseId: r1.id,
      branchName: 'main',
      commitSha: 'ABCDEF1234',
      workItemIds: [story.id],
    });
    expect(ours.release?.id).toBe(r1.id);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/builds/${ours.id}`,
          as(acme.owner, { releaseId: otherRelease.id }),
        )
      ).statusCode,
    ).toBe(404);
    const branch = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/development-artifacts',
        as(acme.owner, { projectId: acme.projectId, kind: 'branch', branchName: 'main' }),
      ),
      201,
    );
    expect(
      (await request('GET', `/api/v1/builds/${ours.id}`, as(acme.owner))).json<Build>().related,
    ).toEqual({
      branchId: branch.id,
      commitId: null,
    });
    await build({ identifier: 'ci-10', provider: 'gitlab', status: 'failed', branchName: 'dev' });

    expect((await list(`&releaseId=${r1.id}`)).data.map((row) => row.id)).toEqual([ours.id]);
    expect((await list('&releaseId=none')).meta.total).toBe(1);
    expect((await list('&branch=dev&status=failed&provider=gitlab')).meta.total).toBe(1);
    expect((await list(`&workItemId=${story.id}`)).data.map((row) => row.id)).toEqual([ours.id]);
    const metrics = ok<{ total: number; failureRate: number; byStatus: Record<string, number> }>(
      await request('GET', `/api/v1/builds/metrics?projectId=${acme.projectId}`, as(acme.owner)),
    );
    expect([metrics.total, metrics.failureRate, metrics.byStatus['queued']]).toEqual([2, 1, 1]);

    expect(
      (await request('GET', `/api/v1/builds/${ours.id}`, as(globex.owner, undefined, globex)))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          `/api/v1/builds/${ours.id}/transition`,
          as(globex.owner, { status: 'running' }, globex),
        )
      ).statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await request('GET', `/api/v1/builds/${ours.id}`, as(hidden))).statusCode).toBe(404);
    expect(
      ok<{ data: Build[] }>(
        await request(
          'GET',
          `/api/v1/builds?projectId=${acme.projectId}`,
          as(globex.owner, undefined, globex),
        ),
      ).data,
    ).toEqual([]);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await report({ identifier: 'v-1' }, viewer)).statusCode).toBe(403);
    expect((await list('', viewer)).meta.total).toBe(2);
    const tester = await acme.addMember('tester', 'tester');
    ok(await move(ours.id, 'running', tester));
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
        as(acme.owner, { overrides: [{ permission: 'work_items.write', effect: 'revoke' }] }),
      ),
    );
    expect((await move(ours.id, 'passed', tester)).statusCode).toBe(403);
    expect(
      (await request('GET', `/api/v1/builds/${ours.id}`, as(tester))).json<Build>().status,
    ).toBe('running');
  });

  it('never stores secrets from logs or metadata', async () => {
    const reported = await build({
      identifier: 'secret-1',
      status: 'failed',
      logSummary:
        'npm ci\nexport NPM_TOKEN=npm_abcdef123456\nAuthorization: Bearer abc.def.ghi\nexit 1',
      metadata: {
        artifacts: [{ name: 'app.tar.gz', sizeBytes: 1024 }],
        facts: { image: 'node:24', deployToken: 'tok_123', note: 'password=hunter2' },
      },
    });
    const row = await owner.developmentArtifact.findUniqueOrThrow({ where: { id: reported.id } });
    const stored = JSON.stringify([row.logSummary, row.metadata]);
    for (const secret of ['npm_abcdef123456', 'abc.def.ghi', 'tok_123', 'hunter2']) {
      expect(stored).not.toContain(secret);
    }
    expect(reported.metadata?.facts).toEqual({
      image: 'node:24',
      deployToken: '[redacted]',
      note: 'password=[redacted]',
    });
    expect(reported.finishedAt).not.toBeNull();
  });
});
