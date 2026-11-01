import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Development links (S5-F1), with the API connected as `qaflow_app` so `work_items`
 * is under Row Level Security. The owner connection only asserts.
 */
describe('Development links', () => {
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

  interface Artifact {
    id: string;
    kind: string;
    provider: string;
    commitSha: string | null;
    status: string | null;
    version: number;
    workItems: Array<{ workItemId: string; key: string }>;
  }
  interface Page {
    data: Artifact[];
    meta: { total: number };
  }
  interface Development {
    artifacts: Array<Artifact & { linkId: string }>;
    counts: Record<string, number>;
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
  const record = (
    body: object,
    account: TestAccount = acme.owner,
    workspace: TestWorkspace = acme,
  ) =>
    request(
      'POST',
      '/api/v1/development-artifacts',
      as(account, { projectId: workspace.projectId, ...body }, workspace),
    );
  const artifact = async (body: object, workspace: TestWorkspace = acme) =>
    ok<Artifact>(await record(body, workspace.owner, workspace), 201);
  const list = async (params = '', account: TestAccount = acme.owner) =>
    ok<Page>(
      await request(
        'GET',
        `/api/v1/development-artifacts?projectId=${acme.projectId}${params}`,
        as(account),
      ),
    );
  const link = (artifactId: string, workItemId: string, account: TestAccount = acme.owner) =>
    request(
      'POST',
      `/api/v1/development-artifacts/${artifactId}/work-items`,
      as(account, { workItemId }),
    );
  const linkFromItem = (
    workItemId: string,
    artifactId: string,
    account: TestAccount = acme.owner,
  ) => request('POST', `/api/v1/work-items/${workItemId}/development`, as(account, { artifactId }));
  const unlink = (artifactId: string, workItemId: string, account: TestAccount = acme.owner) =>
    request(
      'DELETE',
      `/api/v1/development-artifacts/${artifactId}/work-items/${workItemId}`,
      as(account),
    );
  const ofItem = async (workItemId: string, account: TestAccount = acme.owner) =>
    ok<Development>(
      await request('GET', `/api/v1/work-items/${workItemId}/development`, as(account)),
    );

  it('records every kind in the same project and navigates both ways', async () => {
    const a = await item('Card payment form');
    const b = await item('Release the form');
    const branch = await artifact({
      kind: 'branch',
      branchName: 'feature/WEB-1-cards',
      status: 'active',
      workItemIds: [a.id],
    });
    const commit = await artifact({
      kind: 'commit',
      commitSha: 'ABCDEF1234567',
      workItemIds: [a.id],
    });
    expect(commit.commitSha).toBe('abcdef1234567');
    const pr = await artifact({
      kind: 'pull_request',
      prNumber: 42,
      title: 'Cards',
      status: 'open',
      url: 'https://git.example.test/pr/42',
    });
    const build = await artifact({ kind: 'build', identifier: 'build-7', status: 'succeeded' });
    const deployment = await artifact({
      kind: 'deployment',
      identifier: 'deploy-3',
      environment: 'staging',
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
    });
    ok(await link(pr.id, a.id));
    ok(await linkFromItem(a.id, build.id));
    ok(await link(deployment.id, b.id));

    const development = await ofItem(a.id);
    expect(development.artifacts.map((entry) => entry.id).sort()).toEqual(
      [branch.id, commit.id, pr.id, build.id].sort(),
    );
    expect(development.counts).toEqual({
      branch: 1,
      commit: 1,
      pull_request: 1,
      build: 1,
      deployment: 0,
    });
    const back = ok<Artifact>(
      await request('GET', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner)),
    );
    expect(back.workItems.map((entry) => entry.key)).toEqual([a.key]);

    expect((await list()).meta.total).toBe(5);
    expect((await list('&kind=build')).data.map((row) => row.id)).toEqual([build.id]);
    expect((await list('&provider=local')).meta.total).toBe(5);
    expect((await list('&provider=github')).meta.total).toBe(0);
    expect((await list('&status=succeeded')).meta.total).toBe(2);
    expect((await list(`&workItemId=${b.id}`)).data.map((row) => row.id)).toEqual([deployment.id]);
    expect((await list('&workItemId=none')).meta.total).toBe(0);
    expect((await list('&search=cards')).data.map((row) => row.id).sort()).toEqual(
      [branch.id, pr.id].sort(),
    );
    expect((await list()).data[0]?.id).toBe(deployment.id);

    expect((await record({ kind: 'commit' })).statusCode).toBe(400);
    expect((await record({ kind: 'branch', branchName: 'x', status: 'open' })).statusCode).toBe(
      400,
    );
    expect(
      (await record({ kind: 'build', identifier: 'b', url: 'javascript:alert(1)' })).statusCode,
    ).toBe(400);
    expect(await owner.auditLog.count({ where: { summary: { startsWith: 'Recorded ' } } })).toBe(5);
    expect(await owner.auditLog.count({ where: { summary: { startsWith: 'Linked ' } } })).toBe(5);
  });

  it('refuses duplicates and keeps link and unlink idempotent, also concurrently', async () => {
    const a = await item('Card payment form');
    const pr = await artifact({ kind: 'pull_request', prNumber: 7 });
    const duplicate = await record({ kind: 'pull_request', prNumber: 7 });
    expect([duplicate.statusCode, errorOf(duplicate).code]).toEqual([409, 'DUPLICATE_RESOURCE']);
    expect(
      (await record({ kind: 'pull_request', prNumber: 7, provider: 'github' })).statusCode,
    ).toBe(201);
    expect(
      (await record({ kind: 'commit', commitSha: 'abc1234', externalId: 'x-1' })).statusCode,
    ).toBe(201);
    expect(
      (await record({ kind: 'commit', commitSha: 'abc9999', externalId: 'x-1' })).statusCode,
    ).toBe(409);
    const racing = await Promise.all([
      record({ kind: 'pull_request', prNumber: 8 }),
      record({ kind: 'pull_request', prNumber: 8 }),
    ]);
    expect(racing.map((response) => response.statusCode).sort()).toEqual([201, 409]);

    expect(ok<{ created: boolean }>(await link(pr.id, a.id)).created).toBe(true);
    expect(ok<{ created: boolean }>(await linkFromItem(a.id, pr.id)).created).toBe(false);
    expect((await unlink(pr.id, a.id)).statusCode).toBe(204);
    expect((await unlink(pr.id, a.id)).statusCode).toBe(204);
    expect(
      (await request('DELETE', `/api/v1/work-items/${a.id}/development/${pr.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(204);
    expect(await owner.auditLog.count({ where: { summary: { startsWith: 'Unlinked ' } } })).toBe(1);

    const links = await Promise.all([
      link(pr.id, a.id),
      link(pr.id, a.id),
      linkFromItem(a.id, pr.id),
    ]);
    expect(links.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(links.filter((response) => response.json<{ created: boolean }>().created)).toHaveLength(
      1,
    );
    expect(await owner.workItemDevelopmentLink.count({ where: { artifactId: pr.id } })).toBe(1);
    const mixed = await Promise.all([unlink(pr.id, a.id), link(pr.id, a.id)]);
    expect(mixed.map((response) => response.statusCode).sort()).toEqual([200, 204]);
    expect(
      await owner.workItemDevelopmentLink.count({ where: { artifactId: pr.id } }),
    ).toBeLessThanOrEqual(1);

    expect(
      (await request('DELETE', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(204);
    expect((await record({ kind: 'pull_request', prNumber: 7 })).statusCode).toBe(201);
  });

  it('refuses work items, artifacts and projects of other projects or tenants like missing ones', async () => {
    const mine = await artifact({ kind: 'build', identifier: 'build-1' });
    const theirs = await item('Their item', globex);
    const theirArtifact = await artifact({ kind: 'build', identifier: 'build-1' }, globex);
    const project = ok<{ id: string }>(
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile app', key: 'MOB' })),
      201,
    );
    const other = await item('Mobile item', acme, project.id);

    const missingItem = errorOf(await link(mine.id, 'does-not-exist'));
    for (const id of [theirs.id, other.id]) {
      const response = await link(mine.id, id);
      expect([response.statusCode, errorOf(response)]).toEqual([404, missingItem]);
    }
    const missingArtifact = errorOf(await link('does-not-exist', other.id));
    const foreign = await linkFromItem(other.id, theirArtifact.id);
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, missingArtifact]);
    expect(
      (await request('GET', `/api/v1/development-artifacts/${theirArtifact.id}`, as(acme.owner)))
        .statusCode,
    ).toBe(404);
    expect(
      (await request('GET', `/api/v1/work-items/${theirs.id}/development`, as(acme.owner)))
        .statusCode,
    ).toBe(404);

    const before = await owner.developmentArtifact.count();
    expect(
      (await record({ kind: 'build', identifier: 'build-2', workItemIds: [other.id] })).statusCode,
    ).toBe(404);
    expect(
      (await record({ kind: 'build', identifier: 'build-2', workItemIds: [theirs.id] })).statusCode,
    ).toBe(404);
    expect(
      (
        await request(
          'POST',
          '/api/v1/development-artifacts',
          as(acme.owner, { projectId: globex.projectId, kind: 'build', identifier: 'b-9' }),
        )
      ).statusCode,
    ).toBe(404);
    expect(await owner.developmentArtifact.count()).toBe(before);
    expect(
      ok<Page>(
        await request(
          'GET',
          `/api/v1/development-artifacts?projectId=${globex.projectId}`,
          as(acme.owner),
        ),
      ).meta.total,
    ).toBe(0);
    // The database refuses a cross-project link even without the API.
    await expect(
      owner.workItemDevelopmentLink.create({
        data: {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
          workItemId: other.id,
          artifactId: mine.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('follows permission changes and hides hidden projects', async () => {
    const a = await item('Card payment form');
    const tester = await acme.addMember('tester', 'tester');
    const viewer = await acme.addMember('viewer', 'viewer');
    const hidden = await acme.addMember('tester', 'hidden', { projectAccess: false });
    const build = ok<Artifact>(await record({ kind: 'build', identifier: 'b-1' }, tester), 201);
    ok(await link(build.id, a.id, tester));

    expect((await list('', viewer)).meta.total).toBe(1);
    expect((await ofItem(a.id, viewer)).artifacts).toHaveLength(1);
    expect((await record({ kind: 'build', identifier: 'b-2' }, viewer)).statusCode).toBe(403);
    expect((await unlink(build.id, a.id, viewer)).statusCode).toBe(403);
    expect(
      (await request('DELETE', `/api/v1/development-artifacts/${build.id}`, as(tester))).statusCode,
    ).toBe(403);

    expect((await list('', hidden)).meta.total).toBe(0);
    expect(
      (await request('GET', `/api/v1/development-artifacts/${build.id}`, as(hidden))).statusCode,
    ).toBe(404);
    expect((await link(build.id, a.id, hidden)).statusCode).toBe(404);
    expect(
      (await request('GET', `/api/v1/work-items/${a.id}/development`, as(hidden))).statusCode,
    ).toBe(404);

    await owner.projectMember.deleteMany({
      where: { projectId: acme.projectId, userId: tester.userId },
    });
    expect((await unlink(build.id, a.id, tester)).statusCode).toBe(404);
    expect((await record({ kind: 'build', identifier: 'b-3' }, tester)).statusCode).toBe(404);
    expect(await owner.workItemDevelopmentLink.count({ where: { artifactId: build.id } })).toBe(1);
  });

  it('versions edits and soft-deletes artifacts, hiding them and deleted work items', async () => {
    const a = await item('Card payment form');
    const b = await item('Release the form');
    const pr = await artifact({
      kind: 'pull_request',
      prNumber: 3,
      status: 'open',
      workItemIds: [a.id, b.id],
    });
    const edited = ok<Artifact>(
      await request(
        'PATCH',
        `/api/v1/development-artifacts/${pr.id}`,
        as(acme.owner, { status: 'merged', version: pr.version }),
      ),
    );
    expect([edited.status, edited.version]).toEqual(['merged', pr.version + 1]);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/development-artifacts/${pr.id}`,
          as(acme.owner, { status: 'closed', version: pr.version }),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          'PATCH',
          `/api/v1/development-artifacts/${pr.id}`,
          as(acme.owner, { status: 'succeeded' }),
        )
      ).statusCode,
    ).toBe(400);

    expect((await request('DELETE', `/api/v1/work-items/${b.id}`, as(acme.owner))).statusCode).toBe(
      204,
    );
    expect(
      ok<Artifact>(
        await request('GET', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner)),
      ).workItems.map((entry) => entry.workItemId),
    ).toEqual([a.id]);

    const raced = await Promise.all([
      request('DELETE', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner)),
      request('DELETE', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner)),
    ]);
    expect(raced.map((response) => response.statusCode).sort()).toEqual([204, 404]);
    expect(
      (await request('GET', `/api/v1/development-artifacts/${pr.id}`, as(acme.owner))).statusCode,
    ).toBe(404);
    expect((await ofItem(a.id)).artifacts).toEqual([]);
    expect((await list()).meta.total).toBe(0);
    expect((await link(pr.id, a.id)).statusCode).toBe(404);
    // History: the row and its links stay in the database.
    expect(
      (await owner.developmentArtifact.findUniqueOrThrow({ where: { id: pr.id } })).deletedAt,
    ).not.toBeNull();
    expect(await owner.workItemDevelopmentLink.count({ where: { artifactId: pr.id } })).toBe(2);
    expect(await owner.auditLog.count({ where: { summary: 'Deleted pull_request #3' } })).toBe(1);
  });
});
