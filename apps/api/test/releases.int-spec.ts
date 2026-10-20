import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Releases (S3-F4), with the API connected as `qaflow_app` so `releases` and
 * `test_runs` are under Row Level Security. The owner connection only asserts.
 */
describe('Releases', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let globex: TestWorkspace;
  let suiteId: string;

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

  const createRelease = async (
    payload: object = {},
    workspace: TestWorkspace = acme,
    projectId = workspace.projectId,
  ): Promise<{ id: string; version: string; status: string }> => {
    const response = await request(
      'POST',
      '/api/v1/releases',
      as(
        workspace.owner,
        { projectId, name: 'Spring launch', version: '2.4.0', ...payload },
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

  const createCase = async (title: string): Promise<{ id: string; key: string }> =>
    (await request('POST', '/api/v1/test-cases', as(acme.owner, { suiteId, title }))).json();

  const createRun = (payload: object, account: TestAccount = acme.owner, workspace = acme) =>
    request(
      'POST',
      '/api/v1/test-runs',
      as(account, { projectId: workspace.projectId, name: 'Regression', ...payload }, workspace),
    );

  const record = async (runId: string, testCaseId: string, status: string): Promise<void> => {
    const cases = await request('GET', `/api/v1/test-runs/${runId}/cases`, as(acme.owner));
    const runCase = cases
      .json()
      .data.find((row: { testCaseId: string }) => row.testCaseId === testCaseId);
    const response = await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCase.id}/results`,
      as(acme.owner, { status }),
    );
    expect(response.statusCode, response.body).toBe(201);
  };

  const ingest = (token: string, content: string, query: string) => {
    const boundary = 'qa-flow-hub-release';
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/ingest/junit${query}`,
      payload: Buffer.concat([
        Buffer.from(head),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  const junit = (caseKey: string, failed = false): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ci"><testsuite name="s">` +
    (failed
      ? `<testcase name="${caseKey} works" time="1"><failure message="boom">x</failure></testcase>`
      : `<testcase name="${caseKey} works" time="1"/>`) +
    `</testsuite></testsuites>`;

  const createKey = async (): Promise<string> => {
    const response = await request(
      'POST',
      `/api/v1/projects/${acme.projectId}/api-keys`,
      as(acme.owner, { name: 'CI' }),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json().token;
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({
      databaseUrl: appRoleUrl(),
      ingestion: { rateLimitMax: 10_000, maxBytes: 64 * 1024, maxTests: 50 },
    });
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
    suiteId = (
      await request(
        'POST',
        '/api/v1/test-suites',
        as(acme.owner, { projectId: acme.projectId, name: 'Checkout' }),
      )
    ).json().id;
  });

  describe('lifecycle', () => {
    it('creates, lists, filters, edits and audits a release', async () => {
      const release = await createRelease({
        tag: 'v2.4.0',
        startDate: '2026-10-01',
        targetDate: '2026-10-31',
      });
      expect(release).toMatchObject({ version: '2.4.0', status: 'planned' });
      await createRelease({ name: 'Hotfix', version: '2.4.1' });

      const list = await request(
        'GET',
        `/api/v1/releases?projectId=${acme.projectId}&search=hotfix`,
        as(acme.owner),
      );
      expect(list.json().data.map((row: { version: string }) => row.version)).toEqual(['2.4.1']);
      expect(list.json().meta.total).toBe(1);

      const updated = await request(
        'PATCH',
        `/api/v1/releases/${release.id}`,
        as(acme.owner, { name: 'Autumn launch', targetDate: null }),
      );
      expect(updated.statusCode, updated.body).toBe(200);
      expect(updated.json()).toMatchObject({
        name: 'Autumn launch',
        startDate: '2026-10-01',
        targetDate: null,
        tag: 'v2.4.0',
      });

      const backwards = await request(
        'PATCH',
        `/api/v1/releases/${release.id}`,
        as(acme.owner, { targetDate: '2026-09-01' }),
      );
      expect(backwards.statusCode).toBe(400);

      const audit = await owner.auditLog.findMany({
        where: { entityType: 'Release', entityId: release.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((entry) => entry.action)).toEqual(['create', 'update']);
    });

    it('rejects a duplicate version in the same project but not in another project', async () => {
      await createRelease();
      const duplicate = await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: acme.projectId, name: 'Again', version: '2.4.0' }),
      );
      expect(duplicate.statusCode).toBe(409);

      const other = await createProject('MOB');
      await createRelease({}, acme, other);
    });

    it('creates exactly one release when the same version is created concurrently', async () => {
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(
            'POST',
            '/api/v1/releases',
            as(acme.owner, { projectId: acme.projectId, name: 'Race', version: '9.9.9' }),
          ),
        ),
      );
      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(5);
      expect(await owner.release.count()).toBe(1);
    });

    it('moves planned → in_progress → released → archived and refuses anything else', async () => {
      const release = await createRelease();
      const skip = await request('POST', `/api/v1/releases/${release.id}/release`, as(acme.owner));
      expect(skip.statusCode).toBe(409);

      for (const step of ['start', 'release', 'archive']) {
        const response = await request(
          'POST',
          `/api/v1/releases/${release.id}/${step}`,
          as(acme.owner),
        );
        expect(response.statusCode, response.body).toBe(200);
      }
      const archived = await request('GET', `/api/v1/releases/${release.id}`, as(acme.owner));
      expect(archived.json()).toMatchObject({ status: 'archived' });
      expect(archived.json().releasedAt).not.toBeNull();
      expect(archived.json().archivedAt).not.toBeNull();

      const again = await request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner));
      expect(again.statusCode).toBe(409);
      const edit = await request(
        'PATCH',
        `/api/v1/releases/${release.id}`,
        as(acme.owner, { name: 'Renamed' }),
      );
      expect(edit.statusCode).toBe(409);

      const audit = await owner.auditLog.findMany({
        where: { entityType: 'Release', entityId: release.id },
      });
      expect(audit.filter((entry) => entry.action === 'archive')).toHaveLength(1);
    });

    it('applies concurrent transitions of one release exactly once', async () => {
      const release = await createRelease();
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request('POST', `/api/v1/releases/${release.id}/start`, as(acme.owner)),
        ),
      );
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(4);
      const audit = await owner.auditLog.count({
        where: { entityType: 'Release', entityId: release.id, action: 'update' },
      });
      expect(audit).toBe(1);
    });

    it('refuses to plan a release in an archived project', async () => {
      const project = await createProject('OLD');
      const archive = await request('POST', `/api/v1/projects/${project}/archive`, as(acme.owner));
      expect(archive.statusCode, archive.body).toBe(200);
      const response = await request(
        'POST',
        '/api/v1/releases',
        as(acme.owner, { projectId: project, name: 'Late', version: '1.0.0' }),
      );
      expect(response.statusCode).toBe(409);
    });
  });

  describe('runs', () => {
    it('attaches runs on create and update, filters runs and keeps them when archived', async () => {
      const release = await createRelease();
      const attached = await createRun({ releaseId: release.id });
      expect(attached.statusCode, attached.body).toBe(201);
      expect(attached.json().releaseId).toBe(release.id);
      const loose = (await createRun({ name: 'Loose run' })).json();

      const later = await request(
        'PATCH',
        `/api/v1/test-runs/${loose.id}`,
        as(acme.owner, { releaseId: release.id }),
      );
      expect(later.statusCode, later.body).toBe(200);
      expect(later.json().releaseId).toBe(release.id);

      const filtered = await request(
        'GET',
        `/api/v1/test-runs?projectId=${acme.projectId}&releaseId=${release.id}`,
        as(acme.owner),
      );
      expect(filtered.json().meta.total).toBe(2);

      await request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner));
      const afterArchive = await request(
        'GET',
        `/api/v1/test-runs?projectId=${acme.projectId}&releaseId=${release.id}`,
        as(acme.owner),
      );
      expect(afterArchive.json().meta.total).toBe(2);
      const view = await request('GET', `/api/v1/releases/${release.id}`, as(acme.owner));
      expect(view.json().runCount).toBe(2);

      const closed = await createRun({ releaseId: release.id });
      expect(closed.statusCode).toBe(409);
      const detach = await request(
        'PATCH',
        `/api/v1/test-runs/${loose.id}`,
        as(acme.owner, { releaseId: null }),
      );
      expect(detach.statusCode).toBe(409);
      expect(await owner.testRun.count({ where: { releaseId: release.id } })).toBe(2);
    });

    it('answers a release of another project or tenant exactly like a missing one', async () => {
      const otherProject = await createProject('MOB');
      const sibling = await createRelease({}, acme, otherProject);
      const foreign = await createRelease({}, globex);

      const missing = await createRun({ releaseId: 'does-not-exist' });
      const crossProject = await createRun({ releaseId: sibling.id });
      const crossTenant = await createRun({ releaseId: foreign.id });
      for (const response of [missing, crossProject, crossTenant]) {
        expect(response.statusCode).toBe(404);
        expect(errorOf(response)).toEqual(errorOf(missing));
      }

      const run = (await createRun({})).json();
      const patch = await request(
        'PATCH',
        `/api/v1/test-runs/${run.id}`,
        as(acme.owner, { releaseId: foreign.id }),
      );
      expect(patch.statusCode).toBe(404);
      expect(await owner.testRun.count({ where: { releaseId: { not: null } } })).toBe(0);
    });

    it('blocks a cross-project link in the database even without the API', async () => {
      const otherProject = await createProject('MOB');
      const sibling = await createRelease({}, acme, otherProject);
      const run = (await createRun({})).json();
      await expect(
        owner.testRun.update({ where: { id: run.id }, data: { releaseId: sibling.id } }),
      ).rejects.toThrow();
    });

    it('never attaches a run to a release archived at the same time', async () => {
      for (let round = 0; round < 5; round += 1) {
        const release = await createRelease({ version: `3.0.${round}` });
        const [run, archive] = await Promise.all([
          createRun({ releaseId: release.id }),
          request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner)),
        ]);
        expect(archive.statusCode).toBe(200);
        const stored = await owner.release.findUniqueOrThrow({ where: { id: release.id } });
        if (run.statusCode === 201) {
          // The run committed first; the archive came after it.
          const created = await owner.testRun.findUniqueOrThrow({ where: { id: run.json().id } });
          expect(created.createdAt.getTime()).toBeLessThanOrEqual(stored.archivedAt!.getTime());
        } else {
          expect(run.statusCode).toBe(409);
        }
      }
    });
  });

  describe('dashboard and traceability', () => {
    it('summarises the latest result per case across the release runs', async () => {
      const release = await createRelease();
      const a = await createCase('Pays with a card');
      const b = await createCase('Rejects an expired card');
      const requirement = (
        await request(
          'POST',
          '/api/v1/requirements',
          as(acme.owner, { projectId: acme.projectId, title: 'Card payments' }),
        )
      ).json();
      for (const testCase of [a, b]) {
        const link = await request(
          'POST',
          '/api/v1/traceability/links',
          as(acme.owner, {
            sourceType: 'requirement',
            sourceId: requirement.id,
            targetType: 'test_case',
            targetId: testCase.id,
            linkType: 'verifies',
          }),
        );
        expect(link.statusCode, link.body).toBe(201);
      }

      const first = (
        await createRun({ releaseId: release.id, selection: { testCaseIds: [a.id, b.id] } })
      ).json();
      await record(first.id, a.id, 'passed');
      await record(first.id, b.id, 'failed');
      const second = (
        await createRun({ releaseId: release.id, selection: { testCaseIds: [b.id] } })
      ).json();
      await record(second.id, b.id, 'passed');
      // A run outside the release does not count.
      const outside = (await createRun({ selection: { testCaseIds: [a.id] } })).json();
      await record(outside.id, a.id, 'failed');

      const summary = await request(
        'GET',
        `/api/v1/releases/${release.id}/summary`,
        as(acme.owner),
      );
      expect(summary.statusCode, summary.body).toBe(200);
      expect(summary.json().runs).toHaveLength(2);
      expect(summary.json().cases).toMatchObject({ total: 2, passed: 2, failed: 0, passRate: 100 });
      expect(summary.json().requirements).toEqual({ total: 1, verified: 1, passing: 1 });

      const trace = await request(
        'GET',
        `/api/v1/releases/${release.id}/traceability`,
        as(acme.owner),
      );
      expect(trace.statusCode, trace.body).toBe(200);
      const row = trace.json().rows[0];
      expect(row.requirementId).toBe(requirement.id);
      expect(
        row.cases.map((item: { key: string; status: string; testRunId: string }) => [
          item.key,
          item.status,
          item.testRunId,
        ]),
      ).toEqual([
        [a.key, 'passed', first.id],
        [b.key, 'passed', second.id],
      ]);

      const analytics = await request(
        'GET',
        `/api/v1/projects/${acme.projectId}/dashboard/test-results`,
        as(acme.owner),
      );
      expect(analytics.statusCode, analytics.body).toBe(200);
      const releaseRow = analytics
        .json()
        .releases.find((item: { releaseId: string | null }) => item.releaseId === release.id);
      expect(releaseRow).toMatchObject({ version: '2.4.0', runs: 2 });
    });
  });

  describe('CI ingestion', () => {
    it('records a report into an open release by version, and only into one', async () => {
      const release = await createRelease();
      const testCase = await createCase('Pays with a card');
      const token = await createKey();

      const accepted = await ingest(token, junit(testCase.key), '?release=2.4.0');
      expect(accepted.statusCode, accepted.body).toBe(200);
      const run = await owner.testRun.findFirstOrThrow({ where: { releaseId: release.id } });
      expect(run.projectId).toBe(acme.projectId);

      const unknown = await ingest(token, junit(testCase.key, true), '?release=0.0.1');
      expect(unknown.statusCode).toBe(404);

      const foreign = await createRelease({ version: '7.7.7' }, globex);
      const crossTenant = await ingest(token, junit(testCase.key, true), '?release=7.7.7');
      expect(crossTenant.statusCode).toBe(404);
      expect(await owner.testRun.count({ where: { releaseId: foreign.id } })).toBe(0);

      const loose = (await createRun({})).json();
      const mismatch = await ingest(
        token,
        junit(testCase.key, true),
        `?release=2.4.0&runId=${loose.id}`,
      );
      expect(mismatch.statusCode).toBe(409);

      await request('POST', `/api/v1/releases/${release.id}/archive`, as(acme.owner));
      const closed = await ingest(token, junit(testCase.key, true), '?release=2.4.0');
      expect(closed.statusCode).toBe(409);
      expect(await owner.testRun.count({ where: { releaseId: release.id } })).toBe(1);
      expect(await owner.ingestionReport.count()).toBe(1);
    });
  });

  describe('access', () => {
    it('lets every role read releases but only project managers and up manage them', async () => {
      const release = await createRelease();
      for (const role of ['viewer', 'tester', 'qa_lead']) {
        const member = await acme.addMember(role);
        const read = await request('GET', `/api/v1/releases/${release.id}`, as(member));
        expect(read.statusCode, `${role} read`).toBe(200);
        const create = await request(
          'POST',
          '/api/v1/releases',
          as(member, { projectId: acme.projectId, name: 'Nope', version: `${role}-1` }),
        );
        expect(create.statusCode, `${role} create`).toBe(403);
        const archive = await request('POST', `/api/v1/releases/${release.id}/archive`, as(member));
        expect(archive.statusCode, `${role} archive`).toBe(403);
      }
      const manager = await acme.addMember('project_manager');
      const created = await request(
        'POST',
        '/api/v1/releases',
        as(manager, { projectId: acme.projectId, name: 'Yes', version: '5.0.0' }),
      );
      expect(created.statusCode).toBe(201);
    });

    it('hides releases of projects without a grant and of other tenants', async () => {
      const release = await createRelease();
      const outsider = await acme.addMember('qa_lead', 'outsider', { projectAccess: false });

      const missing = await request('GET', '/api/v1/releases/does-not-exist', as(acme.owner));
      const hidden = await request('GET', `/api/v1/releases/${release.id}`, as(outsider));
      const summary = await request('GET', `/api/v1/releases/${release.id}/summary`, as(outsider));
      expect(hidden.statusCode).toBe(404);
      expect(summary.statusCode).toBe(404);
      expect(errorOf(hidden)).toEqual(errorOf(missing));

      const list = await request(
        'GET',
        `/api/v1/releases?projectId=${acme.projectId}`,
        as(outsider),
      );
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ data: [], meta: { total: 0 } });

      const crossTenant = await request(
        'GET',
        `/api/v1/releases/${release.id}`,
        as(globex.owner, undefined, globex),
      );
      expect(crossTenant.statusCode).toBe(404);
      const tenantSwitch = await request(
        'GET',
        `/api/v1/releases/${release.id}`,
        as(acme.owner, undefined, globex),
      );
      expect([403, 404]).toContain(tenantSwitch.statusCode);
      const foreignList = await request(
        'GET',
        `/api/v1/releases?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex),
      );
      expect(foreignList.json().meta.total).toBe(0);
    });

    it('lets RLS hide another organization’s releases from the application role', async () => {
      await createRelease({}, globex);
      const mine = await createRelease({ version: '1.0.0' });
      const appRole = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
      try {
        const rows = await appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization', ${acme.organizationId}, true)`;
          return tx.release.findMany();
        });
        expect(rows.map((row) => row.id)).toEqual([mine.id]);
        await expect(
          appRole.$executeRaw`DELETE FROM releases WHERE id = ${mine.id}`,
        ).rejects.toThrow();
      } finally {
        await appRole.$disconnect();
      }
    });
  });
});
