import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * Import & export end to end, with the API connected as `qaflow_app` so
 * `import_jobs` and every table an import writes are under Row Level Security.
 * The owner connection only asserts what was — or was not — written.
 */
describe('imports and exports: final review regressions', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;

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

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? acme.organizationId,
  });

  const upload = (
    account: TestAccount,
    content: string | Buffer,
    query = 'format=qaflow_csv&suiteName=Imported',
    projectId = acme.projectId,
    organizationId = acme.organizationId,
    fileName = 'cases.csv',
  ) => {
    const boundary = 'qa-flow-hub-import';
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: text/csv\r\n\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/imports?${query}`,
      payload: Buffer.concat([
        Buffer.from(head),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        authorization: `Bearer ${account.accessToken}`,
        'x-organization-id': organizationId,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  const commit = (
    account: TestAccount,
    jobId: string,
    projectId = acme.projectId,
    organizationId = acme.organizationId,
  ) =>
    request(
      'POST',
      `/api/v1/projects/${projectId}/imports/${jobId}/commit`,
      as(account, undefined, organizationId),
    );

  const createRequirement = async (
    title: string,
    projectId = acme.projectId,
  ): Promise<{ id: string; key: string }> =>
    (await request('POST', '/api/v1/requirements', as(acme.owner, { projectId, title }))).json();

  const counts = async () => ({
    suites: await owner.testSuite.count(),
    sections: await owner.testSection.count(),
    cases: await owner.testCase.count(),
    steps: await owner.testStep.count(),
    links: await owner.traceabilityLink.count(),
  });

  const caseCounter = async (): Promise<number> =>
    (await owner.project.findUniqueOrThrow({ where: { id: acme.projectId } })).testCaseCounter;

  const CSV =
    'ref,section,title,priority,tags,references,step_action,step_expected\n' +
    'C-1,Login > OAuth,Sign in with Google,high,auth;sso,WEB-R-1,Open login,Login page shown\n' +
    'C-1,,,,,,Click Google,Signed in\n' +
    'C-2,Login,Sign out,low,,,Click sign out,Signed out\n' +
    'C-3,,"Search, with ""quotes""\nand lines",medium,,,Type query,Results\n';

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({ databaseUrl: appRoleUrl(), importRateLimitMax: 10_000 });
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
  });

  afterAll(async () => {
    await truncate();
    await app.close();
    await owner.$disconnect();
  });

  const exportCases = (account: TestAccount, projectId = acme.projectId) =>
    request('GET', `/api/v1/projects/${projectId}/exports/test-cases.csv`, as(account));

  it('neutralizes imported formula titles on export and restores them exactly on reimport', async () => {
    const titles = [
      ' =1+1 case',
      ' \t+cmd case',
      '\n@SUM(A1) case',
      '  -2+3 case',
      '\u00a0=HYPERLINK("x") case',
    ];
    const csv =
      'title\n' + titles.map((title) => `"${title.replace(/"/g, '""')}"`).join('\n') + '\n';
    const job = (await upload(acme.owner, csv)).json();
    expect(job.status).toBe('ready');
    expect((await commit(acme.owner, job.id)).statusCode).toBe(200);
    const stored = (await owner.testCase.findMany({ select: { title: true } })).map((c) => c.title);

    const body = (await exportCases(acme.owner)).body;
    const cells = body
      .slice(1)
      .split('\r\n')
      .slice(1)
      .filter((line) => line.length > 0);
    for (const title of stored) {
      expect(body).toContain(`'${title}`.replace(/"/g, '""'));
    }
    expect(cells.length).toBeGreaterThanOrEqual(stored.length);

    const other = (
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Copy', key: 'CPY' }))
    ).json();
    const copy = (await upload(acme.owner, Buffer.from(body.slice(1)), undefined, other.id)).json();
    expect(copy.status).toBe('ready');
    await commit(acme.owner, copy.id, other.id);
    const copied = (
      await owner.testCase.findMany({ where: { projectId: other.id }, select: { title: true } })
    ).map((c) => c.title);
    expect(copied.sort()).toEqual([...stored].sort());
  });

  it('round-trips an export into another project: cases, sections, steps and fields', async () => {
    await createRequirement('Users can sign in');
    await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
    const exported = (await exportCases(acme.owner)).body;
    const other = (
      await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Copy', key: 'CPY' }))
    ).json();
    const job = (await upload(acme.owner, Buffer.from(exported), undefined, other.id)).json();
    expect(job.status).toBe('ready');
    expect((await commit(acme.owner, job.id, other.id)).statusCode).toBe(200);

    const shape = async (projectId: string) =>
      (
        await owner.testCase.findMany({
          where: { projectId },
          orderBy: { title: 'asc' },
          include: { steps: { orderBy: { position: 'asc' } }, section: true, suite: true },
        })
      ).map((c) => ({
        title: c.title,
        priority: c.priority,
        type: c.type,
        status: c.status,
        tags: c.tags,
        suite: c.suite.name,
        section: c.section?.name ?? null,
        steps: c.steps.map((s) => [s.action, s.expectedResult, s.data]),
      }));
    expect(await shape(other.id)).toEqual(await shape(acme.projectId));
  });

  it('accepts CRLF, BOM and line breaks inside quoted cells exactly like LF', async () => {
    const crlf = '\uFEFF' + CSV.replace(/\n(?=(?:[^"]*"[^"]*")*[^"]*$)/g, '\r\n');
    const a = (await upload(acme.owner, CSV)).json();
    const b = (await upload(acme.owner, Buffer.from(crlf))).json();
    expect(b.status).toBe('ready');
    expect(b.summary).toEqual(a.summary);
    expect(await owner.testCase.count()).toBe(0);
  });

  it('imports the same title into two suites, but rejects it twice in one suite and section', async () => {
    const ok = (
      await upload(acme.owner, 'suite,title\nAlpha,Same title\nBeta,Same title\n')
    ).json();
    expect(ok.status).toBe('ready');
    expect(ok.summary.cases).toBe(2);
    const dup = (
      await upload(acme.owner, 'suite,title\nAlpha,Same title\nAlpha,same  TITLE\n')
    ).json();
    expect(dup.status).toBe('invalid');
    expect(dup.issues).toContainEqual(
      expect.objectContaining({ row: 3, code: 'DUPLICATE_IN_FILE' }),
    );
  });

  it('treats NFC and NFD spellings of a title as the same case', async () => {
    await commit(acme.owner, (await upload(acme.owner, 'title\nAñadir usuario\n')).json().id);
    const job = (await upload(acme.owner, `title\n${'Añadir usuario'.normalize('NFD')}\n`)).json();
    expect(job.summary).toMatchObject({ cases: 0, duplicates: 1 });
  });

  it('reports a section path with an empty level instead of silently collapsing it', async () => {
    for (const section of ['Auth >  > Password', '> Auth', 'Auth >']) {
      const job = (await upload(acme.owner, `section,title\n"${section}",A case\n`)).json();
      expect(job.status).toBe('invalid');
      expect(job.issues).toContainEqual(
        expect.objectContaining({ row: 2, column: 'section', code: 'REQUIRED' }),
      );
    }
    const deep = (await upload(acme.owner, 'section,title\nA > B > C > D > E > F,A case\n')).json();
    expect(deep.issues).toContainEqual(expect.objectContaining({ code: 'SECTION_DEPTH' }));
    expect(await counts()).toEqual({ suites: 0, sections: 0, cases: 0, steps: 0, links: 0 });
  });

  it('refuses a stale plan when a referenced requirement was deleted or a planned section appeared', async () => {
    const requirement = await createRequirement('Users can sign in');
    const job = (await upload(acme.owner, CSV)).json();
    await owner.requirement.update({
      where: { id: requirement.id },
      data: { deletedAt: new Date() },
    });
    const first = await commit(acme.owner, job.id);
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe('IMPORT_STALE');

    await owner.requirement.update({ where: { id: requirement.id }, data: { deletedAt: null } });
    await commit(acme.owner, (await upload(acme.owner, 'suite,title\nOther,Seed\n')).json().id);
    const second = (
      await upload(acme.owner, 'suite,section,title\nOther,Brand new,X case\n')
    ).json();
    const suite = await owner.testSuite.findFirstOrThrow({ where: { name: 'Other' } });
    await owner.testSection.create({
      data: { organizationId: acme.organizationId, suiteId: suite.id, name: 'Brand new' },
    });
    expect((await commit(acme.owner, second.id)).json().error.code).toBe('IMPORT_STALE');
    expect(await owner.testCase.count()).toBe(1);
    expect(await owner.testSection.count()).toBe(1);
  });

  it('refuses a job that expires while it waits, a repeated commit and an archived project', async () => {
    const job = (await upload(acme.owner, CSV)).json();
    await owner.importJob.update({
      where: { id: job.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await commit(acme.owner, job.id)).statusCode).toBe(409);
    expect((await owner.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      'expired',
    );

    const again = (await upload(acme.owner, CSV)).json();
    expect((await commit(acme.owner, again.id)).statusCode).toBe(200);
    expect((await commit(acme.owner, again.id)).statusCode).toBe(409);
    expect(await owner.testCase.count()).toBe(3);

    const late = (await upload(acme.owner, 'title\nLate case\n')).json();
    await request('POST', `/api/v1/projects/${acme.projectId}/archive`, as(acme.owner));
    expect((await commit(acme.owner, late.id)).statusCode).toBe(409);
    expect(await owner.testCase.count()).toBe(3);
  });

  it('serializes jobs on one project: disjoint plans both commit, a plan made stale by the other is refused', async () => {
    await commit(acme.owner, (await upload(acme.owner, 'title\nSeed case\n')).json().id);
    const a = (await upload(acme.owner, 'title\nA one\nA two\n')).json();
    const b = (await upload(acme.owner, 'title\nB one\nB two\n')).json();
    const both = await Promise.all([commit(acme.owner, a.id), commit(acme.owner, b.id)]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    const keys = (await owner.testCase.findMany({ select: { key: true } }))
      .map((c) => c.key)
      .sort();
    expect(keys).toEqual(['WEB-C-1', 'WEB-C-2', 'WEB-C-3', 'WEB-C-4', 'WEB-C-5']);

    // Both plan the same new suite: whichever commits second planned against a
    // project that no longer exists and must run a new dry run.
    const c = (await upload(acme.owner, 'suite,title\nFresh,C one\n')).json();
    const d = (await upload(acme.owner, 'suite,title\nFresh,D one\n')).json();
    const racing = await Promise.all([commit(acme.owner, c.id), commit(acme.owner, d.id)]);
    expect(racing.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(racing.find((r) => r.statusCode === 409)?.json().error.code).toBe('IMPORT_STALE');
    expect(await owner.testSuite.count({ where: { name: 'Fresh' } })).toBe(1);
    expect(await owner.testCase.count()).toBe(6);
    expect(await caseCounter()).toBe(6);
  });

  it('never exports another tenant: foreign project, run or matrix ids', async () => {
    const globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLX',
    });
    await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
    const foreign = [
      `/api/v1/projects/${acme.projectId}/exports/test-cases.csv`,
      `/api/v1/traceability/matrix/export.csv?projectId=${acme.projectId}`,
    ];
    for (const url of foreign) {
      const response = await request('GET', url, {
        token: globex.owner.accessToken,
        organizationId: globex.organizationId,
      });
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('Sign in with Google');
    }
    const crossHeader = await request('GET', foreign[0] ?? '', {
      token: globex.owner.accessToken,
      organizationId: acme.organizationId,
    });
    expect([403, 404]).toContain(crossHeader.statusCode);
  });
});
