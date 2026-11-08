import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Release pipeline (S6-F2), with the API connected as `qaflow_app` so every
 * table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Release pipeline', () => {
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

  interface Stage {
    environment: { id: string; name: string; protected: boolean };
    status: string;
    blockers: string[];
    rolledBack: boolean;
    canDeploy: boolean;
    deploymentCount: number;
    lastDeployment: {
      id: string;
      status: string;
      isRollback: boolean;
      build: { identifier: string | null } | null;
      actor: { fullName: string } | null;
    } | null;
    qa: { runId: string; result: string } | null;
  }
  interface Pipeline {
    status: string;
    progress: { deployed: number; total: number; percent: number };
    build: { id: string } | null;
    defects: { open: number; blocking: Array<{ key: string }> };
    stages: Stage[];
    history: Array<{ environment: { name: string }; deploymentCount: number }>;
  }

  const env = async (name: string, position: number, body: object = {}, projectId?: string) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/environments',
        as(acme.owner, { projectId: projectId ?? acme.projectId, name, position, ...body }),
      ),
      201,
    );
  const release = async (version: string, workspace: TestWorkspace = acme) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(
          workspace.owner,
          { projectId: workspace.projectId, name: `Release ${version}`, version },
          workspace,
        ),
      ),
      201,
    );
  const build = async (identifier: string, releaseId: string) =>
    ok<{ build: { id: string } }>(
      await request(
        'POST',
        '/api/v1/builds',
        as(acme.owner, { projectId: acme.projectId, identifier, status: 'passed', releaseId }),
      ),
    ).build;
  const deploy = async (body: object) =>
    ok<{ deployment: { id: string } }>(
      await request(
        'POST',
        '/api/v1/deployments',
        as(acme.owner, { projectId: acme.projectId, ...body }),
      ),
    ).deployment;
  const move = (id: string, status: string) =>
    request('POST', `/api/v1/deployments/${id}/transition`, as(acme.owner, { status }));
  const pipelineOf = (id: string, params = '', account: TestAccount = acme.owner, ws = acme) =>
    request('GET', `/api/v1/releases/${id}/pipeline${params}`, as(account, undefined, ws));
  const pipeline = async (id: string, params = '', account: TestAccount = acme.owner) =>
    ok<Pipeline>(await pipelineOf(id, params, account));
  const statuses = (view: Pipeline) => view.stages.map((stage) => stage.status);

  it('derives stages across environments: deploy, failure, redeploy and rollback', async () => {
    const dev = await env('dev', 0, { kind: 'development' });
    const staging = await env('staging', 1, { kind: 'staging' });
    const prod = await env('prod', 2, { kind: 'production' });
    const r1 = await release('1.0.0');

    const empty = await pipeline(r1.id);
    expect([empty.status, statuses(empty), empty.progress]).toEqual([
      'not_started',
      ['pending', 'pending', 'pending'],
      { deployed: 0, total: 3, percent: 0 },
    ]);
    expect(empty.stages.map((stage) => stage.environment.name)).toEqual(['dev', 'staging', 'prod']);
    expect(empty.stages[2]!.environment.protected).toBe(true);

    const ci = await build('ci-1', r1.id);
    expect(statuses(await pipeline(r1.id))).toEqual(['ready', 'pending', 'pending']);
    await deploy({
      identifier: 'd-dev',
      environmentId: dev.id,
      buildId: ci.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    const afterDev = await pipeline(r1.id);
    expect([afterDev.status, statuses(afterDev), afterDev.progress.percent]).toEqual([
      'in_progress',
      ['deployed', 'ready', 'pending'],
      33,
    ]);
    expect(afterDev.stages[0]!.lastDeployment?.build?.identifier).toBe('ci-1');
    expect(afterDev.stages[0]!.lastDeployment?.actor).not.toBeNull();

    const s1 = await deploy({
      identifier: 'd-stg-1',
      environmentId: staging.id,
      buildId: ci.id,
      releaseId: r1.id,
    });
    expect(statuses(await pipeline(r1.id))).toEqual(['deployed', 'deploying', 'pending']);
    expect((await pipeline(r1.id)).status).toBe('deploying');
    ok(await move(s1.id, 'deploying'));
    ok(await move(s1.id, 'failed'));
    const failed = await pipeline(r1.id);
    expect([failed.status, statuses(failed), failed.stages[2]!.blockers]).toEqual([
      'failed',
      ['deployed', 'failed', 'blocked'],
      ['previous_stage_failed'],
    ]);

    const s2 = await deploy({
      identifier: 'd-stg-2',
      environmentId: staging.id,
      buildId: ci.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    const redeployed = await pipeline(r1.id);
    expect([statuses(redeployed), redeployed.stages[1]!.deploymentCount]).toEqual([
      ['deployed', 'deployed', 'ready'],
      2,
    ]);
    expect(redeployed.stages[1]!.lastDeployment?.id).toBe(s2.id);
    const cancelled = await deploy({
      identifier: 'd-prod-0',
      environmentId: prod.id,
      releaseId: r1.id,
      status: 'cancelled',
    });
    expect(cancelled.id).toBeTruthy();
    expect(statuses(await pipeline(r1.id))).toEqual(['deployed', 'deployed', 'ready']);

    const p1 = await deploy({
      identifier: 'd-prod',
      environmentId: prod.id,
      buildId: ci.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    const done = await pipeline(r1.id);
    expect([done.status, done.progress]).toEqual([
      'completed',
      { deployed: 3, total: 3, percent: 100 },
    ]);
    ok(await request('POST', `/api/v1/deployments/${p1.id}/rollback`, as(acme.owner, {})));
    const rolled = await pipeline(r1.id);
    expect([rolled.status, statuses(rolled), rolled.stages[2]!.rolledBack]).toEqual([
      'in_progress',
      ['deployed', 'deployed', 'ready'],
      true,
    ]);
    expect(rolled.stages[2]!.lastDeployment?.isRollback).toBe(true);

    expect(
      (await pipeline(r1.id, '?status=deployed')).stages.map((stage) => stage.environment.name),
    ).toEqual(['dev', 'staging']);
    expect(
      (await pipeline(r1.id, `?environmentId=${prod.id}`)).stages.map(
        (stage) => stage.environment.name,
      ),
    ).toEqual(['prod']);
    expect((await pipeline(r1.id, '?status=deployed')).progress.total).toBe(3);
    expect((await pipelineOf(r1.id, '?status=nope')).statusCode).toBe(400);
  });

  it('shows QA per stage, blocks on blocking defects and inactive environments', async () => {
    const dev = await env('dev', 0);
    const staging = await env('staging', 1);
    const r1 = await release('2.0.0');
    const ci = await build('ci-2', r1.id);
    await deploy({
      identifier: 'd-dev',
      environmentId: dev.id,
      buildId: ci.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    const run = await owner.testRun.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        name: 'Staging regression',
        environment: 'STAGING',
        releaseId: r1.id,
        status: 'in_progress',
      },
    });
    const view = await pipeline(r1.id);
    expect(view.stages[1]!.qa).toEqual(
      expect.objectContaining({ runId: run.id, result: 'in_progress' }),
    );
    expect(view.stages[0]!.qa).toBeNull();

    await owner.defect.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'ACME-D-900',
        title: 'Checkout crashes',
        severity: 'blocker',
        testRunId: run.id,
      },
    });
    await owner.defect.create({
      data: {
        organizationId: acme.organizationId,
        projectId: acme.projectId,
        key: 'ACME-D-901',
        title: 'Typo',
        severity: 'minor',
        testRunId: run.id,
      },
    });
    const blocked = await pipeline(r1.id);
    expect([blocked.status, statuses(blocked), blocked.stages[1]!.blockers]).toEqual([
      'blocked',
      ['deployed', 'blocked'],
      ['blocking_defects'],
    ]);
    expect([blocked.defects.open, blocked.defects.blocking.map((defect) => defect.key)]).toEqual([
      2,
      ['ACME-D-900'],
    ]);
    await owner.defect.updateMany({ where: { key: 'ACME-D-900' }, data: { status: 'resolved' } });
    expect(statuses(await pipeline(r1.id))).toEqual(['deployed', 'ready']);
    ok(
      await request(
        'PATCH',
        `/api/v1/environments/${staging.id}`,
        as(acme.owner, { status: 'inactive' }),
      ),
    );
    const inactive = await pipeline(r1.id);
    expect([
      inactive.stages[1]!.status,
      inactive.stages[1]!.blockers,
      inactive.stages[1]!.canDeploy,
    ]).toEqual(['blocked', ['environment_inactive'], false]);
  });

  it('keeps archived environments as history only', async () => {
    const old = await env('legacy', 0);
    const dev = await env('dev', 1);
    const r1 = await release('3.0.0');
    const ci = await build('ci-3', r1.id);
    await deploy({
      identifier: 'd-old',
      environmentId: old.id,
      buildId: ci.id,
      releaseId: r1.id,
      status: 'succeeded',
    });
    ok(await request('POST', `/api/v1/environments/${old.id}/archive`, as(acme.owner, {})));
    const view = await pipeline(r1.id);
    expect(view.stages.map((stage) => [stage.environment.name, stage.status])).toEqual([
      ['dev', 'ready'],
    ]);
    expect(view.history.map((entry) => [entry.environment.name, entry.deploymentCount])).toEqual([
      ['legacy', 1],
    ]);
    expect(view.progress).toEqual({ deployed: 0, total: 1, percent: 0 });
    expect(dev.id).toBeTruthy();
  });

  it('keeps other projects, tenants and revoked permissions out', async () => {
    const r1 = await release('4.0.0');
    await env('dev', 0);
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' })),
      201,
    );
    await env('mobile-prod', 0, {}, project.id);
    expect((await pipeline(r1.id)).stages.map((stage) => stage.environment.name)).toEqual(['dev']);
    const foreign = await release('9.9.9', globex);
    expect((await pipelineOf(foreign.id)).statusCode).toBe(404);
    expect((await pipelineOf(r1.id, '', globex.owner, globex)).statusCode).toBe(404);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await pipelineOf(r1.id, '', hidden)).statusCode).toBe(404);

    const tester = await acme.addMember('tester', 'tester');
    const view = await pipeline(r1.id, '', tester);
    expect(view.stages[0]!.canDeploy).toBe(true);
    for (const permission of ['work_items.read', 'releases.read']) {
      ok(
        await request(
          'PUT',
          `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
          as(acme.owner, { overrides: [{ permission, effect: 'revoke' }] }),
        ),
      );
      expect((await pipelineOf(r1.id, '', tester)).statusCode).toBe(403);
      ok(
        await request(
          'PUT',
          `/api/v1/projects/${acme.projectId}/permissions/members/${tester.userId}`,
          as(acme.owner, { overrides: [] }),
        ),
      );
    }
    expect((await pipelineOf(r1.id, '', tester)).statusCode).toBe(200);
  });

  it('answers consistent snapshots while deployments move concurrently', async () => {
    const dev = await env('dev', 0);
    const staging = await env('staging', 1);
    const r1 = await release('5.0.0');
    const ci = await build('ci-5', r1.id);
    const d1 = await deploy({
      identifier: 'c-dev',
      environmentId: dev.id,
      buildId: ci.id,
      releaseId: r1.id,
    });
    const d2 = await deploy({
      identifier: 'c-stg',
      environmentId: staging.id,
      buildId: ci.id,
      releaseId: r1.id,
    });
    const writes = [
      async () => {
        await move(d1.id, 'deploying');
        await move(d1.id, 'succeeded');
      },
      async () => {
        await move(d2.id, 'deploying');
        await move(d2.id, 'failed');
      },
    ];
    const reads = Array.from({ length: 8 }, () => pipeline(r1.id));
    const [views] = await Promise.all([Promise.all(reads), ...writes.map((write) => write())]);
    const expected: Record<string, string> = {
      pending: 'deploying',
      deploying: 'deploying',
      succeeded: 'deployed',
      failed: 'failed',
    };
    for (const view of views) {
      for (const stage of view.stages) {
        expect(stage.status).toBe(expected[stage.lastDeployment!.status]);
      }
      const deployed = view.stages.filter((stage) => stage.status === 'deployed').length;
      expect(view.progress.deployed).toBe(deployed);
    }
    const final = await pipeline(r1.id);
    expect([final.status, statuses(final)]).toEqual(['failed', ['deployed', 'failed']]);
  });
});
