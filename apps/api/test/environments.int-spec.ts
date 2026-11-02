import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Environments (S6-F1), with the API connected as `qaflow_app` so
 * `environments` is under Row Level Security. The owner connection only asserts.
 */
describe('Environments', () => {
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

  interface Env {
    id: string;
    name: string;
    kind: string;
    status: string;
    protected: boolean;
    position: number;
    version: number;
    archivedAt: string | null;
    health: string;
    deploymentCount: number;
    current: {
      deploymentId: string;
      buildIdentifier: string | null;
      commitSha: string | null;
      release: { version: string } | null;
    } | null;
    lastDeployment: { id: string; status: string } | null;
  }

  const createEnv = (body: object, account: TestAccount = acme.owner, workspace = acme) =>
    request(
      'POST',
      '/api/v1/environments',
      as(account, { projectId: workspace.projectId, ...body }, workspace),
    );
  const env = async (name: string, body: object = {}) =>
    ok<Env>(await createEnv({ name, ...body }), 201);
  const getEnv = (id: string, account: TestAccount = acme.owner) =>
    request('GET', `/api/v1/environments/${id}`, as(account));
  const envs = async (params = '', account: TestAccount = acme.owner) =>
    ok<Env[]>(
      await request(
        'GET',
        `/api/v1/environments?projectId=${acme.projectId}${params}`,
        as(account),
      ),
    );
  const patchEnv = (id: string, body: object, account: TestAccount = acme.owner) =>
    request('PATCH', `/api/v1/environments/${id}`, as(account, body));
  const action = (id: string, name: 'archive' | 'restore', account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/environments/${id}/${name}`, as(account, {}));
  const report = (body: object, account: TestAccount = acme.owner) =>
    request('POST', '/api/v1/deployments', as(account, { projectId: acme.projectId, ...body }));
  const deploy = async (body: object, account: TestAccount = acme.owner) =>
    ok<{ deployment: { id: string; status: string } }>(await report(body, account)).deployment;
  const move = (id: string, status: string, account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/deployments/${id}/transition`, as(account, { status }));
  const rollback = (id: string, account: TestAccount = acme.owner) =>
    request('POST', `/api/v1/deployments/${id}/rollback`, as(account, {}));

  it('creates, filters and edits environments; names stay unique, also concurrently', async () => {
    const prod = await env('prod', { kind: 'production', position: 2 });
    expect([prod.protected, prod.status, prod.health, prod.deploymentCount]).toEqual([
      true,
      'active',
      'idle',
      0,
    ]);
    const staging = await env('staging', {
      kind: 'staging',
      position: 1,
      description: 'Pre-production',
      url: 'https://staging.example.test',
      metadata: { region: 'eu-west-1', replicas: 2 },
    });
    expect(staging.protected).toBe(false);
    expect(errorOf(await createEnv({ name: 'PROD' })).code).toBe('DUPLICATE_RESOURCE');
    expect((await createEnv({ name: 'x', metadata: { dbPassword: 'p' } })).statusCode).toBe(400);
    expect((await createEnv({ name: 'y', kind: 'testing' })).statusCode).toBe(400);
    const racing = await Promise.all(Array.from({ length: 4 }, () => createEnv({ name: 'qa' })));
    expect(racing.map((result) => result.statusCode).sort()).toEqual([201, 409, 409, 409]);

    expect((await envs()).map((row) => row.name)).toEqual(['qa', 'staging', 'prod']);
    expect((await envs('&kind=production')).map((row) => row.name)).toEqual(['prod']);
    expect((await envs('&protected=true')).map((row) => row.name)).toEqual(['prod']);
    expect((await envs('&search=pre-prod')).map((row) => row.name)).toEqual(['staging']);
    expect((await envs('&health=idle')).length).toBe(3);

    const edits = await Promise.all(
      ['a', 'b'].map((description) =>
        patchEnv(staging.id, { description, version: staging.version }),
      ),
    );
    expect(edits.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const renamed = ok<Env>(await patchEnv(staging.id, { name: 'pre', status: 'inactive' }));
    expect([renamed.name, renamed.status, renamed.health]).toEqual(['pre', 'inactive', 'inactive']);
    expect(errorOf(await patchEnv(staging.id, { name: 'Prod' })).code).toBe('DUPLICATE_RESOURCE');
    expect((await report({ identifier: 'd', environmentId: staging.id })).statusCode).toBe(409);
    expect(
      await owner.auditLog.count({ where: { entityType: 'Environment', entityId: staging.id } }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('needs work_items.manage to deploy, move or roll back in a protected environment', async () => {
    const prod = await env('prod', { kind: 'production' });
    const staging = await env('staging', { kind: 'staging' });
    const tester = await acme.addMember('tester', 'tester');
    const manager = await acme.addMember('project_manager', 'manager');
    expect((await report({ identifier: 't-1', environmentId: prod.id }, tester)).statusCode).toBe(
      403,
    );
    ok(await report({ identifier: 't-2', environmentId: staging.id }, tester));
    const pending = await deploy({ identifier: 'p-1', environmentId: prod.id });
    expect((await move(pending.id, 'deploying', tester)).statusCode).toBe(403);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/development-artifacts/${pending.id}`,
          as(tester, { status: 'deploying' }),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/deployments/${pending.id}`,
          as(tester, { title: 'mine now' }),
        )
      ).statusCode,
    ).toBe(403);
    ok(await move(pending.id, 'deploying', manager));
    ok(await move(pending.id, 'succeeded', manager));
    expect((await rollback(pending.id, tester)).statusCode).toBe(403);
    expect(
      (await owner.developmentArtifact.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('succeeded');

    ok(
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${manager.userId}`,
        as(acme.owner, { overrides: [{ permission: 'work_items.manage', effect: 'revoke' }] }),
      ),
    );
    expect((await rollback(pending.id, manager)).statusCode).toBe(403);
    expect((await report({ identifier: 'm-1', environmentId: prod.id }, manager)).statusCode).toBe(
      403,
    );
    expect((await patchEnv(prod.id, { protected: false }, manager)).statusCode).toBe(403);
    expect((await patchEnv(prod.id, { protected: false }, tester)).statusCode).toBe(403);
    ok(await patchEnv(prod.id, { protected: false }));
    ok(await report({ identifier: 't-3', environmentId: prod.id }, tester));
    ok(await rollback(pending.id, tester));
  });

  it('archives instead of deleting history, keeps existing deployments and restores', async () => {
    const staging = await env('staging', { kind: 'staging' });
    const ci = ok<{ build: { id: string } }>(
      await request(
        'POST',
        '/api/v1/builds',
        as(acme.owner, {
          projectId: acme.projectId,
          identifier: 'ci-1',
          status: 'passed',
          commitSha: 'abcdef1234',
        }),
      ),
    ).build;
    const release = ok<{ id: string }>(
      await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: acme.projectId, name: 'Release 1', version: '1.0.0' }),
      ),
      201,
    );
    const shipped = await deploy({
      identifier: 'dep-1',
      environmentId: staging.id,
      buildId: ci.id,
      releaseId: release.id,
      status: 'succeeded',
    });
    const view = ok<Env>(await getEnv(staging.id));
    expect([view.health, view.deploymentCount, view.current?.deploymentId]).toEqual([
      'healthy',
      1,
      shipped.id,
    ]);
    expect([
      view.current?.buildIdentifier,
      view.current?.commitSha,
      view.current?.release?.version,
    ]).toEqual(['ci-1', 'abcdef1234', '1.0.0']);
    const failing = await deploy({
      identifier: 'dep-2',
      environmentId: staging.id,
      status: 'failed',
    });
    expect(ok<Env>(await getEnv(staging.id)).health).toBe('failing');
    const inFlight = await deploy({ identifier: 'dep-3', environmentId: staging.id });
    expect(ok<Env>(await getEnv(staging.id)).health).toBe('deploying');
    expect((await action(staging.id, 'archive')).statusCode).toBe(409);
    ok(await move(inFlight.id, 'cancelled'));

    const removal = await request('DELETE', `/api/v1/environments/${staging.id}`, as(acme.owner));
    expect([removal.statusCode, removal.json<{ error: { code: string } }>().error.code]).toEqual([
      409,
      'CONFLICT',
    ]);
    const archived = ok<Env>(await action(staging.id, 'archive'));
    expect([archived.status, archived.archivedAt === null, archived.health]).toEqual([
      'archived',
      false,
      'archived',
    ]);
    expect((await action(staging.id, 'archive')).statusCode).toBe(409);
    expect(await envs()).toEqual([]);
    expect((await envs('&includeArchived=true')).length).toBe(1);
    expect((await envs('&status=archived')).length).toBe(1);
    expect((await report({ identifier: 'dep-4', environmentId: staging.id })).statusCode).toBe(409);
    expect((await rollback(shipped.id)).statusCode).toBe(409);
    expect((await patchEnv(staging.id, { description: 'x' })).statusCode).toBe(409);
    const kept = ok<{ environmentRef: { status: string } }>(
      await request('GET', `/api/v1/deployments/${shipped.id}`, as(acme.owner)),
    );
    expect(kept.environmentRef.status).toBe('archived');
    expect(
      ok<{ meta: { total: number } }>(
        await request(
          'GET',
          `/api/v1/deployments?projectId=${acme.projectId}&environmentId=${staging.id}`,
          as(acme.owner),
        ),
      ).meta.total,
    ).toBe(3);
    expect(failing.status).toBe('failed');

    expect(ok<Env>(await action(staging.id, 'restore')).status).toBe('active');
    expect((await action(staging.id, 'restore')).statusCode).toBe(409);
    ok(await report({ identifier: 'dep-5', environmentId: staging.id }));

    const scratch = await env('scratch');
    expect(
      (await request('DELETE', `/api/v1/environments/${scratch.id}`, as(acme.owner))).statusCode,
    ).toBe(204);
    expect((await getEnv(scratch.id)).statusCode).toBe(404);
    await env('scratch');
  });

  it('serializes archiving against deployments being recorded', async () => {
    const staging = await env('staging');
    const results = await Promise.all([
      ...Array.from({ length: 3 }, (_, index) =>
        report({ identifier: `race-${index}`, environmentId: staging.id, status: 'succeeded' }),
      ),
      action(staging.id, 'archive'),
    ]);
    const archive = results[3]!;
    expect(archive.statusCode).toBe(200);
    const created = results.slice(0, 3).filter((result) => result.statusCode === 200).length;
    expect(results.slice(0, 3).every((result) => [200, 409].includes(result.statusCode))).toBe(
      true,
    );
    expect(await owner.developmentArtifact.count({ where: { environmentId: staging.id } })).toBe(
      created,
    );
    const archivedAt = new Date(archive.json<Env>().archivedAt!);
    const rows = await owner.developmentArtifact.findMany({ where: { environmentId: staging.id } });
    expect(rows.every((row) => row.createdAt <= archivedAt)).toBe(true);
  });

  it('keeps environments of other projects, tenants and hidden projects out', async () => {
    const foreign = ok<Env>(await createEnv({ name: 'prod' }, globex.owner, globex), 201);
    const ours = await env('prod');
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' })),
      201,
    );
    const sibling = ok<Env>(
      await request(
        'POST',
        '/api/v1/environments',
        as(acme.owner, { projectId: project.id, name: 'prod' }),
      ),
      201,
    );
    expect(sibling.id).not.toBe(ours.id);
    expect((await envs()).map((row) => row.id)).toEqual([ours.id]);
    for (const response of [
      await getEnv(foreign.id),
      await patchEnv(foreign.id, { description: 'x' }),
      await action(foreign.id, 'archive'),
      await request('DELETE', `/api/v1/environments/${foreign.id}`, as(acme.owner)),
    ]) {
      expect(response.statusCode).toBe(404);
    }
    expect(
      ok<Env[]>(
        await request('GET', `/api/v1/environments?projectId=${globex.projectId}`, as(acme.owner)),
      ),
    ).toEqual([]);
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    expect((await getEnv(ours.id, hidden)).statusCode).toBe(404);
    const viewer = await acme.addMember('viewer', 'viewer');
    expect((await getEnv(ours.id, viewer)).statusCode).toBe(200);
    expect((await createEnv({ name: 'v' }, viewer)).statusCode).toBe(403);
    expect((await patchEnv(ours.id, { description: 'x' }, viewer)).statusCode).toBe(403);
    expect((await action(ours.id, 'archive', viewer)).statusCode).toBe(403);
    expect((await owner.environment.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe(
      'active',
    );
  });

  it('migrates the minimal S5-F5 environments in place (backfill)', async () => {
    const sql = readFileSync(
      join(__dirname, '../prisma/migrations/20270221100000_environments/migration.sql'),
      'utf8',
    );
    const backfill = sql.slice(sql.indexOf('-- backfill:start'), sql.indexOf('-- backfill:end'));
    const statements = backfill
      .split(';')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(4);
    const legacy = [
      ['e1', 'testing', '2027-01-01'],
      ['e2', 'production', '2027-01-03'],
      ['e3', 'other', '2027-01-02'],
    ] as const;
    const sentinel = new Error('rollback');
    let seen: Array<{ id: string; kind: string; protected: boolean; position: number }> = [];
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE "environments" DROP CONSTRAINT "environments_kind"`,
        );
        for (const [id, kind, createdAt] of legacy) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "environments" ("id", "organizationId", "projectId", "name", "kind", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $1, $4, $5::timestamp, now())`,
            id,
            acme.organizationId,
            acme.projectId,
            kind,
            createdAt,
          );
        }
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        seen = await tx.$queryRawUnsafe(
          `SELECT "id", "kind", "protected", "position" FROM "environments" ORDER BY "id"`,
        );
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(seen).toEqual([
      { id: 'e1', kind: 'qa', protected: false, position: 0 },
      { id: 'e2', kind: 'production', protected: true, position: 2 },
      { id: 'e3', kind: 'custom', protected: false, position: 1 },
    ]);
    expect(await owner.environment.count()).toBe(0);
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO "environments" ("id", "organizationId", "projectId", "name", "kind", "updatedAt")
         VALUES ('legacy', $1, $2, 'legacy', 'testing', now())`,
        acme.organizationId,
        acme.projectId,
      ),
    ).rejects.toThrow(/environments_kind/);
  });
});
