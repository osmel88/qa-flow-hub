import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Environment rollback (S6-F5), with the API connected as `qaflow_app` so
 * every table it reads is under Row Level Security. The owner connection only asserts.
 */
describe('Environment rollback', () => {
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
    identifier: string;
    status: string;
    trigger: string | null;
    build: { id: string } | null;
    release: { id: string } | null;
    rollbackOf: { id: string; identifier: string } | null;
    rollbackTarget: { id: string; identifier: string } | null;
    rollbackReason: string | null;
    rollbackEmergency: boolean;
    title: string;
  }
  interface Result {
    created: boolean;
    deployment: Deployment;
  }
  const REASON = 'Checkout broke after the release';

  const release = async (version: string) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: acme.projectId, name: `R ${version}`, version }),
      ),
      201,
    );
  const environment = async (
    name: string,
    body: object = {},
    workspace: TestWorkspace = acme,
    projectId = workspace.projectId,
  ) =>
    ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/environments',
        as(workspace.owner, { projectId, name, ...body }, workspace),
      ),
      201,
    );
  const build = async (
    identifier: string,
    workspace: TestWorkspace = acme,
    projectId = workspace.projectId,
  ) =>
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
  const deploy = async (
    body: object,
    workspace: TestWorkspace = acme,
    projectId = workspace.projectId,
  ) =>
    ok<{ deployment: Deployment }>(
      await request(
        'POST',
        '/api/v1/deployments',
        as(workspace.owner, { projectId, status: 'succeeded', ...body }, workspace),
      ),
    ).deployment;
  const rollback = (environmentId: string, body: object, account: TestAccount = acme.owner) =>
    request(
      'POST',
      `/api/v1/environments/${environmentId}/rollback`,
      as(account, { reason: REASON, ...body }),
    );
  const get = async (id: string) =>
    ok<Deployment>(await request('GET', `/api/v1/deployments/${id}`, as(acme.owner)));
  const history = async (environmentId: string) =>
    ok<Deployment[]>(
      await request('GET', `/api/v1/environments/${environmentId}/rollbacks`, as(acme.owner)),
    );
  const pipeline = async (releaseId: string) =>
    ok<{
      stages: Array<{
        environment: { name: string };
        status: string;
        rolledBack: boolean;
        lastDeployment: {
          id: string;
          rollback: {
            from: { identifier: string } | null;
            to: { identifier: string } | null;
            reason: string;
          } | null;
        } | null;
      }>;
    }>(await request('GET', `/api/v1/releases/${releaseId}/pipeline`, as(acme.owner)));

  it('rolls back, keeps history, refuses repeats and races, replays idempotency keys and rolls back a rollback', async () => {
    const staging = await environment('staging');
    const other = await environment('qa');
    const [r1, r2] = [await release('1.0.0'), await release('2.0.0')];
    const [ci1, ci2, ci3] = [await build('ci-1'), await build('ci-2'), await build('ci-3')];
    const d1 = await deploy({
      identifier: 'd1',
      environmentId: staging.id,
      buildId: ci1.id,
      releaseId: r1.id,
    });
    const d2 = await deploy({
      identifier: 'd2',
      environmentId: staging.id,
      buildId: ci2.id,
      releaseId: r2.id,
    });
    const failed = await deploy({
      identifier: 'dx',
      environmentId: staging.id,
      buildId: ci3.id,
      status: 'failed',
    });
    const elsewhere = await deploy({ identifier: 'q1', environmentId: other.id, buildId: ci1.id });

    expect(
      (await rollback(staging.id, { targetDeploymentId: d1.id, reason: undefined })).statusCode,
    ).toBe(400);
    expect(
      (await rollback(staging.id, { targetDeploymentId: d1.id, reason: 'oops' })).statusCode,
    ).toBe(400);
    expect(errorOf(await rollback(staging.id, { targetDeploymentId: failed.id })).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(errorOf(await rollback(staging.id, { targetDeploymentId: elsewhere.id })).code).toBe(
      'VALIDATION_ERROR',
    );
    expect(errorOf(await rollback(staging.id, { targetDeploymentId: d2.id })).code).toBe(
      'CONFLICT',
    );
    expect((await rollback(staging.id, { targetDeploymentId: 'nope' })).statusCode).toBe(404);
    expect(
      (await rollback(staging.id, { targetDeploymentId: d1.id, expectedCurrentId: d1.id }))
        .statusCode,
    ).toBe(409);

    const race = await Promise.all(
      Array.from({ length: 3 }, () => rollback(staging.id, { targetDeploymentId: d1.id })),
    );
    expect(race.map((result) => result.statusCode).sort()).toEqual([200, 409, 409]);
    const back = race.find((result) => result.statusCode === 200)!.json<Result>();
    expect([
      back.created,
      back.deployment.status,
      back.deployment.trigger,
      back.deployment.rollbackOf?.id,
      back.deployment.rollbackTarget?.id,
      back.deployment.build?.id,
      back.deployment.release?.id,
      back.deployment.rollbackReason,
      back.deployment.title,
    ]).toEqual([
      true,
      'succeeded',
      'rollback',
      d2.id,
      d1.id,
      ci1.id,
      r1.id,
      REASON,
      'Rolled back from d2 to d1',
    ]);
    expect((await get(d2.id)).status).toBe('rolled_back');
    expect((await get(d1.id)).status).toBe('succeeded');
    expect((await rollback(staging.id, { targetDeploymentId: d1.id })).statusCode).toBe(409);

    const rolledAway = (await pipeline(r2.id)).stages.find(
      (stage) => stage.environment.name === 'staging',
    )!;
    expect([rolledAway.status, rolledAway.rolledBack]).toEqual(['pending', true]);
    const restored = (await pipeline(r1.id)).stages.find(
      (stage) => stage.environment.name === 'staging',
    )!;
    expect([
      restored.status,
      restored.lastDeployment?.id,
      restored.lastDeployment?.rollback?.from?.identifier,
      restored.lastDeployment?.rollback?.to?.identifier,
    ]).toEqual(['deployed', back.deployment.id, 'd2', 'd1']);

    const first = ok<Result>(
      await rollback(staging.id, { targetDeploymentId: d2.id, idempotencyKey: 'k-1' }),
    );
    expect([
      first.created,
      first.deployment.rollbackOf?.id,
      first.deployment.rollbackTarget?.id,
    ]).toEqual([true, back.deployment.id, d2.id]);
    const replayed = ok<Result>(
      await rollback(staging.id, { targetDeploymentId: d2.id, idempotencyKey: 'k-1' }),
    );
    expect([replayed.created, replayed.deployment.id]).toEqual([false, first.deployment.id]);
    const keyed = await Promise.all(
      Array.from({ length: 3 }, () =>
        rollback(staging.id, { targetDeploymentId: d1.id, idempotencyKey: 'k-2' }),
      ),
    );
    expect(keyed.map((result) => result.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(keyed.map((result) => result.json<Result>().deployment.id)).size).toBe(1);
    expect(keyed.map((result) => result.json<Result>().created).sort()).toEqual([
      false,
      false,
      true,
    ]);
    expect(await owner.developmentArtifact.count({ where: { externalId: 'rollback:k-2' } })).toBe(
      1,
    );

    const log = await history(staging.id);
    expect(log.map((entry) => entry.title)).toEqual([
      'Rolled back from d2-rollback-rollback to d1',
      'Rolled back from d2-rollback to d2',
      'Rolled back from d2 to d1',
    ]);
    expect(await owner.developmentArtifact.count({ where: { environmentId: staging.id } })).toBe(6);
    expect(
      await owner.auditLog.count({ where: { summary: { contains: 'Rolled back from' } } }),
    ).toBe(3);
  });

  it('protects production: higher permission, gates and approvals by policy, emergency only with its permission', async () => {
    const prod = await environment('prod', { kind: 'production' });
    const r1 = await release('3.0.0');
    const r2 = await release('3.1.0');
    const [ci1, ci2] = [await build('ci-p1'), await build('ci-p2')];
    const d1 = await deploy({
      identifier: 'p1',
      environmentId: prod.id,
      buildId: ci1.id,
      releaseId: r1.id,
    });
    await deploy({ identifier: 'p2', environmentId: prod.id, buildId: ci2.id, releaseId: r2.id });
    ok(
      await request(
        'POST',
        '/api/v1/release-approval-rules',
        as(acme.owner, {
          projectId: acme.projectId,
          type: 'release_manager',
          environmentId: prod.id,
        }),
      ),
      201,
    );
    const [tester, manager, admin] = await Promise.all([
      acme.addMember('tester', 'tester'),
      acme.addMember('project_manager', 'manager'),
      acme.addMember('organization_admin', 'admin'),
    ]);
    expect((await rollback(prod.id, { targetDeploymentId: d1.id }, tester)).statusCode).toBe(403);
    expect(errorOf(await rollback(prod.id, { targetDeploymentId: d1.id }, manager)).code).toBe(
      'APPROVAL_REQUIRED',
    );
    expect(
      (await rollback(prod.id, { targetDeploymentId: d1.id, emergency: true }, manager)).statusCode,
    ).toBe(403);
    expect(
      (
        await rollback(
          prod.id,
          { targetDeploymentId: d1.id, emergency: true, reason: 'down' },
          admin,
        )
      ).statusCode,
    ).toBe(400);
    const emergency = ok<Result>(
      await rollback(prod.id, { targetDeploymentId: d1.id, emergency: true }, admin),
    );
    expect([emergency.deployment.rollbackEmergency, emergency.deployment.release?.id]).toEqual([
      true,
      r1.id,
    ]);
    expect(await owner.auditLog.count({ where: { summary: { startsWith: 'Emergency: ' } } })).toBe(
      1,
    );

    ok(
      await request(
        'PATCH',
        `/api/v1/environments/${prod.id}`,
        as(acme.owner, { rollbackChecks: 'skip' }),
      ),
    );
    const p2 = (await history(prod.id))[0]!.rollbackOf!;
    const skipped = ok<Result>(await rollback(prod.id, { targetDeploymentId: p2.id }, manager));
    expect(skipped.deployment.rollbackEmergency).toBe(false);

    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${manager.userId}`,
        as(acme.owner, { overrides: [{ permission: 'work_items.manage', effect: 'revoke' }] }),
      ),
    );
    expect((await rollback(prod.id, { targetDeploymentId: d1.id }, manager)).statusCode).toBe(403);
  });

  it('refuses targets and environments of other projects and tenants, and hides them', async () => {
    const staging = await environment('staging');
    const ci1 = await build('ci-1');
    const ci2 = await build('ci-2');
    await deploy({ identifier: 'd1', environmentId: staging.id, buildId: ci1.id });
    await deploy({ identifier: 'd2', environmentId: staging.id, buildId: ci2.id });
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' })),
      201,
    );
    const mobileEnv = await environment('m-staging', {}, acme, project.id);
    const mobile = await deploy(
      {
        identifier: 'm1',
        environmentId: mobileEnv.id,
        buildId: (await build('m-ci', acme, project.id)).id,
      },
      acme,
      project.id,
    );
    const globexEnv = await environment('g-staging', {}, globex);
    const foreign = await deploy(
      { identifier: 'g1', environmentId: globexEnv.id, buildId: (await build('g-ci', globex)).id },
      globex,
    );

    expect((await rollback(staging.id, { targetDeploymentId: mobile.id })).statusCode).toBe(404);
    expect((await rollback(staging.id, { targetDeploymentId: foreign.id })).statusCode).toBe(404);
    expect((await rollback(globexEnv.id, { targetDeploymentId: foreign.id })).statusCode).toBe(404);
    expect(
      (await request('GET', `/api/v1/environments/${globexEnv.id}/rollbacks`, as(acme.owner)))
        .statusCode,
    ).toBe(404);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect(
      (await request('GET', `/api/v1/environments/${staging.id}/rollbacks`, as(hidden))).statusCode,
    ).toBe(404);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await rollback(staging.id, { targetDeploymentId: mobile.id }, viewer)).statusCode).toBe(
      403,
    );
    expect(await owner.developmentArtifact.count({ where: { trigger: 'rollback' } })).toBe(0);
  });
});
