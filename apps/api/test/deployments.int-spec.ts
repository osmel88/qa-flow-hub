import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Deployments (S5-F5), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Deployments', () => {
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

  interface Deployment {
    id: string;
    status: string;
    version: number;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    commitSha: string | null;
    trigger: string | null;
    environmentRef: { id: string; name: string } | null;
    build: { id: string } | null;
    release: { id: string } | null;
    rollbackOf: { id: string } | null;
    rolledBackBy: { id: string } | null;
    workItems: Array<{ workItemId: string }>;
    logSummary: string | null;
  }

  const item = async (title: string, workspace: TestWorkspace = acme, projectId?: string) =>
    ok<{ id: string }>(
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
  const environment = async (name: string, projectId = acme.projectId, workspace = acme) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/environments',
        as(workspace.owner, { projectId, name, kind: 'staging' }, workspace),
      ),
      201,
    );
  const build = async (identifier: string, projectId = acme.projectId, workspace = acme) =>
    ok<{ build: { id: string } }>(
      await request(
        'POST',
        '/api/v1/builds',
        as(
          workspace.owner,
          { projectId, identifier, status: 'passed', commitSha: 'abcdef1234' },
          workspace,
        ),
      ),
    ).build;
  const report = (body: object, account: TestAccount = acme.owner) =>
    request('POST', '/api/v1/deployments', as(account, { projectId: acme.projectId, ...body }));
  const deploy = async (body: object) =>
    ok<{ created: boolean; deployment: Deployment }>(await report(body)).deployment;
  const move = (id: string, status: string, account: TestAccount = acme.owner, extra = {}) =>
    request('POST', `/api/v1/deployments/${id}/transition`, as(account, { status, ...extra }));
  const rollback = (id: string, body: object = {}, account: TestAccount = acme.owner) =>
    request(
      'POST',
      `/api/v1/deployments/${id}/rollback`,
      as(account, { reason: 'Regression in checkout', ...body }),
    );
  const get = async (id: string) =>
    ok<Deployment>(await request('GET', `/api/v1/deployments/${id}`, as(acme.owner)));
  const statusOf = async (id: string) =>
    ok<{ summary: { status: string } }>(
      await request('GET', `/api/v1/work-items/${id}/development`, as(acme.owner)),
    ).summary.status;
  const list = async (params: string, account: TestAccount = acme.owner) =>
    ok<{ data: Deployment[]; meta: { total: number } }>(
      await request('GET', `/api/v1/deployments?projectId=${acme.projectId}${params}`, as(account)),
    );

  it('follows the lifecycle, refuses invalid and terminal transitions and drives development status', async () => {
    const staging = await environment('staging');
    const ci = await build('ci-1');
    const story = await item('Story');
    const created = await deploy({
      identifier: 'dep-1',
      environmentId: staging.id,
      buildId: ci.id,
      workItemIds: [story.id],
    });
    expect([created.status, created.startedAt, created.commitSha]).toEqual([
      'pending',
      null,
      'abcdef1234',
    ]);
    expect(created.environmentRef?.name).toBe('staging');
    expect(await statusOf(story.id)).toBe('no_development');
    expect(errorOf(await move(created.id, 'succeeded')).code).toBe('INVALID_STATE_TRANSITION');
    const deploying = ok<Deployment>(await move(created.id, 'deploying'));
    expect(deploying.startedAt).not.toBeNull();
    const done = ok<Deployment>(await move(created.id, 'succeeded'));
    expect(done.durationMs).not.toBeNull();
    expect(await statusOf(story.id)).toBe('deployed');
    for (const status of ['deploying', 'failed', 'cancelled']) {
      expect((await move(created.id, status)).statusCode).toBe(422);
    }
    for (const status of ['pending', 'rolled_back']) {
      expect(
        (
          await request(
            'PATCH',
            `/api/v1/development-artifacts/${created.id}`,
            as(acme.owner, { status }),
          )
        ).statusCode,
      ).toBe(422);
    }
    const failed = await deploy({
      identifier: 'dep-2',
      environmentId: staging.id,
      status: 'failed',
    });
    expect((await move(failed.id, 'deploying')).statusCode).toBe(422);

    expect((await list(`&buildId=${ci.id}`)).data.map((row) => row.id)).toEqual([created.id]);
    expect((await list(`&workItemId=${story.id}`)).meta.total).toBe(1);
    expect((await list(`&environmentId=${staging.id}&status=failed`)).meta.total).toBe(1);
    expect((await list('&provider=github')).meta.total).toBe(0);
    const audits = await owner.auditLog.findMany({ where: { entityId: created.id } });
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent per provider and externalId, also under concurrency, and refuses duplicates', async () => {
    const staging = await environment('staging');
    const body = {
      identifier: 'gh-1',
      environmentId: staging.id,
      externalId: 'run-77',
      provider: 'github',
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => report(body)));
    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200, 200, 200]);
    const ids = new Set(
      results.map((result) => result.json<{ deployment: Deployment }>().deployment.id),
    );
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.json<{ created: boolean }>().created)).toHaveLength(1);
    expect(await owner.developmentArtifact.count({ where: { kind: 'deployment' } })).toBe(1);
    ok(await report({ identifier: 'local-1', environmentId: staging.id }));
    expect(errorOf(await report({ identifier: 'local-1', environmentId: staging.id })).code).toBe(
      'DUPLICATE_RESOURCE',
    );
    expect(
      (
        await request(
          'POST',
          '/api/v1/environments',
          as(acme.owner, { projectId: acme.projectId, name: 'STAGING' }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it('applies concurrent transitions and updates one at a time', async () => {
    const staging = await environment('staging');
    const dep = await deploy({
      identifier: 'dep-c',
      environmentId: staging.id,
      status: 'deploying',
    });
    const results = await Promise.all(
      ['succeeded', 'failed', 'cancelled'].map((status) => move(dep.id, status)),
    );
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 422, 422]);
    const fresh = await get(dep.id);
    const updates = await Promise.all(
      ['a', 'b'].map((title) =>
        request(
          'PATCH',
          `/api/v1/deployments/${dep.id}`,
          as(acme.owner, { title, version: fresh.version }),
        ),
      ),
    );
    expect(updates.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  });

  it('rolls back once, also under concurrency, and back to the previous build', async () => {
    const staging = await environment('staging');
    const story = await item('Story');
    const ci1 = await build('ci-1');
    const ci2 = await build('ci-2');
    await deploy({
      identifier: 'dep-1',
      environmentId: staging.id,
      buildId: ci1.id,
      status: 'succeeded',
    });
    const second = await deploy({
      identifier: 'dep-2',
      environmentId: staging.id,
      buildId: ci2.id,
      status: 'succeeded',
      workItemIds: [story.id],
    });
    expect(await statusOf(story.id)).toBe('deployed');
    expect((await rollback(second.id, { version: 99 })).statusCode).toBe(409);
    const results = await Promise.all(Array.from({ length: 4 }, () => rollback(second.id)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409, 409, 409]);
    const back = results.find((result) => result.statusCode === 200)!.json<Deployment>();
    expect([back.status, back.trigger, back.rollbackOf?.id, back.build?.id]).toEqual([
      'succeeded',
      'rollback',
      second.id,
      ci1.id,
    ]);
    const original = await get(second.id);
    expect([original.status, original.rolledBackBy?.id]).toEqual(['rolled_back', back.id]);
    expect((await rollback(second.id)).statusCode).toBe(409);
    expect(await owner.developmentArtifact.count({ where: { rollbackOfId: second.id } })).toBe(1);
    expect(await statusOf(story.id)).toBe('no_development');
    const pending = await deploy({ identifier: 'dep-3', environmentId: staging.id });
    expect(errorOf(await rollback(pending.id)).code).toBe('INVALID_STATE_TRANSITION');
    const metrics = ok<{ total: number; rollbacks: number; successRate: number }>(
      await request(
        'GET',
        `/api/v1/deployments/metrics?projectId=${acme.projectId}`,
        as(acme.owner),
      ),
    );
    expect([metrics.total, metrics.rollbacks, metrics.successRate]).toEqual([4, 1, 1]);
    const environments = ok<Array<{ id: string; current: { deploymentId: string } | null }>>(
      await request('GET', `/api/v1/environments?projectId=${acme.projectId}`, as(acme.owner)),
    );
    expect(environments[0]?.current?.deploymentId).toBe(back.id);
  });

  it('keeps builds, releases, environments, tenants and permissions apart', async () => {
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const staging = await environment('staging');
    const otherEnv = await environment('staging', project.id);
    const otherBuild = await build('ci-x', project.id);
    const otherRelease = await release('9.0.0', project.id);
    const otherItem = await item('Mobile item', acme, project.id);
    const foreignEnv = await environment('prod', globex.projectId, globex);
    const foreignBuild = await build('ci-g', globex.projectId, globex);
    for (const body of [
      { environmentId: otherEnv.id },
      { environmentId: foreignEnv.id },
      { environmentId: staging.id, buildId: otherBuild.id },
      { environmentId: staging.id, buildId: foreignBuild.id },
      { environmentId: staging.id, releaseId: otherRelease.id },
      { environmentId: staging.id, workItemIds: [otherItem.id] },
    ]) {
      expect((await report({ identifier: 'x', ...body })).statusCode).toBe(404);
    }
    expect(await owner.developmentArtifact.count({ where: { identifier: 'x' } })).toBe(0);

    const r1 = await release('1.0.0');
    const ours = await deploy({
      identifier: 'dep-9',
      environmentId: staging.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    expect((await list(`&releaseId=${r1.id}`)).meta.total).toBe(1);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/deployments/${ours.id}`,
          as(acme.owner, { releaseId: otherRelease.id }),
        )
      ).statusCode,
    ).toBe(404);
    expect((await rollback(ours.id, { toBuildId: otherBuild.id })).statusCode).toBe(404);
    expect((await rollback(ours.id, { toBuildId: foreignBuild.id })).statusCode).toBe(404);
    expect((await get(ours.id)).status).toBe('succeeded');
    const globexCall = (method: 'GET' | 'POST', path: string) =>
      request(
        method,
        path,
        as(
          globex.owner,
          method === 'POST' ? { reason: 'Regression in checkout' } : undefined,
          globex,
        ),
      );
    expect((await globexCall('GET', `/api/v1/deployments/${ours.id}`)).statusCode).toBe(404);
    expect((await globexCall('POST', `/api/v1/deployments/${ours.id}/rollback`)).statusCode).toBe(
      404,
    );
    expect(
      ok<{ data: Deployment[] }>(
        await globexCall('GET', `/api/v1/deployments?projectId=${acme.projectId}`),
      ).data,
    ).toEqual([]);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await request('GET', `/api/v1/deployments/${ours.id}`, as(hidden))).statusCode).toBe(
      404,
    );
    expect((await rollback(ours.id, {}, hidden)).statusCode).toBe(404);

    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await report({ identifier: 'v', environmentId: staging.id }, viewer)).statusCode).toBe(
      403,
    );
    expect((await rollback(ours.id, {}, viewer)).statusCode).toBe(403);
    expect((await list('', viewer)).meta.total).toBe(1);
    const tester = await acme.addMember('tester', 'tester');
    expect(
      (
        await request(
          'POST',
          '/api/v1/environments',
          as(tester, { projectId: acme.projectId, name: 'qa' }),
        )
      ).statusCode,
    ).toBe(403);
    const mine = await deploy({ identifier: 'dep-t', environmentId: staging.id });
    ok(await move(mine.id, 'deploying', tester));
    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
        as(acme.owner, { overrides: [{ permission: 'work_items.write', effect: 'revoke' }] }),
      ),
    );
    expect((await move(mine.id, 'succeeded', tester)).statusCode).toBe(403);
    expect((await rollback(ours.id, {}, tester)).statusCode).toBe(403);
    expect((await get(mine.id)).status).toBe('deploying');
  });

  it('never stores secrets from logs or metadata', async () => {
    const staging = await environment('staging');
    const dep = await deploy({
      identifier: 'dep-s',
      environmentId: staging.id,
      logSummary: 'deploy with token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok',
      metadata: { facts: { apiKey: 'sk_live_abcdefghijklmnop1234' }, artifacts: [] },
    });
    const stored = await owner.developmentArtifact.findUniqueOrThrow({ where: { id: dep.id } });
    expect(JSON.stringify([stored.logSummary, stored.metadata])).not.toMatch(/ghp_|sk_live_/);
  });
});
