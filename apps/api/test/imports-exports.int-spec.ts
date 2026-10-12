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
describe('imports and exports', () => {
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

  describe('dry run', () => {
    it('validates and plans without creating any suite, section, case, step or link', async () => {
      await createRequirement('Users can sign in');
      const before = await counts();
      const response = await upload(acme.owner, CSV);
      expect(response.statusCode).toBe(201);
      const job = response.json();
      expect(job).toMatchObject({
        status: 'ready',
        format: 'qaflow_csv',
        fileName: 'cases.csv',
        targetSuiteName: 'Imported',
        summary: {
          rows: 4,
          cases: 3,
          steps: 4,
          newSuites: 1,
          newSections: 2,
          links: 1,
          duplicates: 0,
          errors: 0,
        },
      });
      expect(job.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(await counts()).toEqual(before);
      expect(await caseCounter()).toBe(0);
      const stored = await owner.importJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored.organizationId).toBe(acme.organizationId);
      expect(stored.plan).not.toBeNull();
    });

    it('reports errors by row and column and refuses to commit an invalid job', async () => {
      const response = await upload(
        acme.owner,
        'title,priority,estimate_minutes\nab,high,\nGood title,urgent,abc\n',
      );
      const job = response.json();
      expect(job.status).toBe('invalid');
      expect(job.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            row: 2,
            column: 'title',
            code: 'TOO_SHORT',
            severity: 'error',
          }),
          expect.objectContaining({
            row: 3,
            column: 'priority',
            code: 'INVALID_ENUM',
            severity: 'warning',
          }),
          expect.objectContaining({
            row: 3,
            column: 'estimate_minutes',
            code: 'INVALID_NUMBER',
            severity: 'error',
          }),
        ]),
      );
      expect((await owner.importJob.findUniqueOrThrow({ where: { id: job.id } })).plan).toBeNull();
      const refused = await commit(acme.owner, job.id);
      expect(refused.statusCode).toBe(409);
      expect(await owner.testCase.count()).toBe(0);
    });

    it('records a malformed CSV as an invalid job with a MALFORMED_CSV issue', async () => {
      const job = (await upload(acme.owner, 'title,priority\n"never closed,high\n')).json();
      expect(job.status).toBe('invalid');
      expect(job.issues).toEqual([
        expect.objectContaining({ code: 'MALFORMED_CSV', severity: 'error' }),
      ]);
    });

    it('refuses binaries and non UTF-8 files outright, storing nothing', async () => {
      const xlsx = await upload(
        acme.owner,
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
        undefined,
        undefined,
        undefined,
        'cases.csv',
      );
      expect(xlsx.statusCode).toBe(415);
      const latin1 = await upload(
        acme.owner,
        Buffer.from([0x74, 0x69, 0x74, 0x6c, 0x65, 0x0a, 0xe9, 0x74, 0xe9]),
      );
      expect(latin1.statusCode).toBe(415);
      expect(await owner.importJob.count()).toBe(0);
    });

    it('validates the query: exactly one of suiteId or suiteName, and a known format', async () => {
      expect((await upload(acme.owner, CSV, 'format=qaflow_csv')).statusCode).toBe(400);
      expect((await upload(acme.owner, CSV, 'format=xlsx&suiteName=Imported')).statusCode).toBe(
        400,
      );
      expect((await upload(acme.owner, CSV, 'format=qaflow_csv&suiteId=missing')).statusCode).toBe(
        404,
      );
    });

    it('stores only the base name of the uploaded file', async () => {
      const job = (
        await upload(acme.owner, CSV, undefined, undefined, undefined, '../../etc/cases.csv')
      ).json();
      expect(job.fileName).toBe('cases.csv');
    });
  });

  describe('commit', () => {
    it('applies the stored plan atomically: suites, nested sections, cases, steps, links and audit', async () => {
      const requirement = await createRequirement('Users can sign in');
      const job = (await upload(acme.owner, CSV)).json();
      const response = await commit(acme.owner, job.id);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        job: { status: 'committed' },
        created: { cases: 3, steps: 4, sections: 2, suites: 1, links: 1 },
      });

      const cases = await owner.testCase.findMany({
        orderBy: { key: 'asc' },
        include: { steps: { orderBy: { position: 'asc' } }, section: true },
      });
      expect(cases.map((testCase) => testCase.key)).toEqual(['WEB-C-1', 'WEB-C-2', 'WEB-C-3']);
      expect(cases[0]).toMatchObject({
        title: 'Sign in with Google',
        priority: 'high',
        tags: ['auth', 'sso'],
        organizationId: acme.organizationId,
      });
      expect(cases[0]?.section?.name).toBe('OAuth');
      expect(cases[0]?.steps.map((step) => step.action)).toEqual(['Open login', 'Click Google']);
      expect(cases[2]?.title).toBe('Search, with "quotes"\nand lines');
      const oauth = await owner.testSection.findFirstOrThrow({ where: { name: 'OAuth' } });
      expect(
        (await owner.testSection.findUniqueOrThrow({ where: { id: oauth.parentId ?? '' } })).name,
      ).toBe('Login');
      expect(await owner.traceabilityLink.findMany()).toEqual([
        expect.objectContaining({
          sourceId: requirement.id,
          targetId: cases[0]?.id,
          linkType: 'verifies',
        }),
      ]);
      expect(await caseCounter()).toBe(3);
      expect((await owner.importJob.findUniqueOrThrow({ where: { id: job.id } })).plan).toBeNull();
      expect(
        await owner.auditLog.count({ where: { entityType: 'ImportJob', entityId: job.id } }),
      ).toBe(1);

      expect((await commit(acme.owner, job.id)).statusCode).toBe(409);
      expect(await owner.testCase.count()).toBe(3);
    });

    it('skips cases that already exist: reimporting the same file creates nothing', async () => {
      await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
      const again = (await upload(acme.owner, CSV)).json();
      expect(again.status).toBe('ready');
      expect(again.summary).toMatchObject({
        cases: 0,
        duplicates: 3,
        newSuites: 0,
        newSections: 0,
      });
      expect(
        again.issues.filter((entry: { code: string }) => entry.code === 'DUPLICATE_EXISTING'),
      ).toHaveLength(3);
      const response = await commit(acme.owner, again.id);
      expect(response.json().created.cases).toBe(0);
      expect(await owner.testCase.count()).toBe(3);
      expect(await caseCounter()).toBe(3);
    });

    it('treats archived cases as duplicates', async () => {
      await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
      await owner.testCase.updateMany({ data: { archivedAt: new Date(), status: 'deprecated' } });
      expect((await upload(acme.owner, CSV)).json().summary).toMatchObject({
        cases: 0,
        duplicates: 3,
      });
    });

    it('refuses a stale plan when the project changed since the dry run', async () => {
      await commit(acme.owner, (await upload(acme.owner, 'title\nFirst case\n')).json().id);
      const job = (await upload(acme.owner, 'title\nSecond case\n')).json();
      const suite = await owner.testSuite.findFirstOrThrow({ where: { name: 'Imported' } });
      await request(
        'POST',
        '/api/v1/test-cases',
        as(acme.owner, { suiteId: suite.id, title: 'Second case' }),
      );
      const response = await commit(acme.owner, job.id);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('IMPORT_STALE');
      expect(await owner.testCase.count()).toBe(2);
      expect((await owner.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
        'ready',
      );
    });

    it('lets exactly one of two concurrent commits win', async () => {
      const job = (await upload(acme.owner, CSV)).json();
      const responses = await Promise.all([
        commit(acme.owner, job.id),
        commit(acme.owner, job.id),
        commit(acme.owner, job.id),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409, 409]);
      expect(await owner.testCase.count()).toBe(3);
      expect(await caseCounter()).toBe(3);
    });

    it('serializes two different jobs creating the same new section', async () => {
      const first = (await upload(acme.owner, 'section,title\nShared,Case one\n')).json();
      const second = (await upload(acme.owner, 'section,title\nShared,Case two\n')).json();
      const responses = await Promise.all([
        commit(acme.owner, first.id),
        commit(acme.owner, second.id),
      ]);
      const statuses = responses.map((response) => response.statusCode).sort();
      // The loser saw a suite and section appear after its dry run: stale, not a copy.
      expect(statuses).toEqual([200, 409]);
      expect(await owner.testSection.count({ where: { name: 'Shared' } })).toBe(1);
      expect(await owner.testSuite.count({ where: { name: 'Imported' } })).toBe(1);
    });

    it('rolls everything back, case counter included, when a write fails mid-commit', async () => {
      const job = (await upload(acme.owner, CSV)).json();
      await owner.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION import_test_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql`);
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER import_test_fail BEFORE INSERT ON "test_steps" FOR EACH ROW EXECUTE FUNCTION import_test_fail()`,
      );
      try {
        expect((await commit(acme.owner, job.id)).statusCode).toBe(500);
      } finally {
        await owner.$executeRawUnsafe(`DROP TRIGGER import_test_fail ON "test_steps"`);
        await owner.$executeRawUnsafe(`DROP FUNCTION import_test_fail()`);
      }
      expect(await counts()).toMatchObject({
        suites: 0,
        sections: 0,
        cases: 0,
        steps: 0,
        links: 0,
      });
      expect(await caseCounter()).toBe(0);
      expect(await owner.auditLog.count({ where: { entityType: 'ImportJob' } })).toBe(0);
      expect((await owner.importJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
        'ready',
      );
      expect((await commit(acme.owner, job.id)).statusCode).toBe(200);
      expect(await caseCounter()).toBe(3);
    });

    it('refuses expired jobs and clears their plan', async () => {
      const job = (await upload(acme.owner, CSV)).json();
      await owner.importJob.update({
        where: { id: job.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await commit(acme.owner, job.id)).statusCode).toBe(409);
      const stored = await owner.importJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored).toMatchObject({ status: 'expired', plan: null });
      expect(await owner.testCase.count()).toBe(0);
    });

    it('imports a TestRail export with separated steps', async () => {
      const csv =
        'ID,Title,Section,Type,Priority,Estimate,Steps (Step),Steps (Expected Result),Custom Browser\n' +
        'C101,Checkout with card,Checkout,Functionality,1 - Critical,1h,Add item,In cart,Chrome\n' +
        ',,,,,,Pay,Paid,\n' +
        'C102,Refund,Checkout,Regression,3 - Medium,30m,Request refund,Refunded,Firefox\n';
      const job = (await upload(acme.owner, csv, 'format=testrail_csv&suiteName=TestRail')).json();
      expect(job.status).toBe('ready');
      expect(job.issues).toEqual([
        expect.objectContaining({
          code: 'UNKNOWN_COLUMN',
          column: 'Custom Browser',
          severity: 'warning',
        }),
      ]);
      expect((await commit(acme.owner, job.id)).json().created).toMatchObject({
        cases: 2,
        steps: 3,
      });
      expect(
        await owner.testCase.findFirstOrThrow({ where: { title: 'Checkout with card' } }),
      ).toMatchObject({
        priority: 'critical',
        estimateMinutes: 60,
      });
    });
  });

  describe('isolation and permissions', () => {
    it('lets only qa_lead and above import', async () => {
      const tester = await acme.addMember('tester');
      const viewer = await acme.addMember('viewer');
      const lead = await acme.addMember('qa_lead');
      expect((await upload(tester, CSV)).statusCode).toBe(403);
      expect((await upload(viewer, CSV)).statusCode).toBe(403);
      expect((await upload(lead, CSV)).statusCode).toBe(201);
    });

    it('binds a job to its author and re-checks the permission at commit', async () => {
      const lead = await acme.addMember('qa_lead');
      const job = (await upload(lead, CSV)).json();
      expect((await commit(acme.owner, job.id)).statusCode).toBe(404);
      const revoke = await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${lead.userId}`,
        as(acme.owner, { overrides: [{ permission: 'test_design.import', effect: 'revoke' }] }),
      );
      expect(revoke.statusCode).toBe(200);
      expect((await commit(lead, job.id)).statusCode).toBe(403);
      expect(await owner.testCase.count()).toBe(0);
    });

    it('links only requirements of the same project; others are reported, not linked', async () => {
      const other = (
        await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' }))
      ).json();
      await createRequirement('Mobile sign in', other.id);
      const job = (
        await upload(acme.owner, 'title,references\nLinked case,MOB-R-1;WEB-R-9\n')
      ).json();
      expect(job.status).toBe('ready');
      expect(job.issues.map((entry: { code: string }) => entry.code)).toEqual([
        'UNKNOWN_REFERENCE',
        'UNKNOWN_REFERENCE',
      ]);
      await commit(acme.owner, job.id);
      expect(await owner.traceabilityLink.count()).toBe(0);
    });

    it('keeps jobs invisible and unusable across tenants and projects', async () => {
      const globex = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'GLX',
      });
      const job = (await upload(acme.owner, CSV)).json();
      const other = (
        await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' }))
      ).json();

      expect(
        (
          await request(
            'GET',
            `/api/v1/projects/${globex.projectId}/imports/${job.id}`,
            as(globex.owner, undefined, globex.organizationId),
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (await commit(globex.owner, job.id, globex.projectId, globex.organizationId)).statusCode,
      ).toBe(404);
      expect((await commit(acme.owner, job.id, other.id)).statusCode).toBe(404);
      expect(
        (await upload(globex.owner, CSV, undefined, acme.projectId, globex.organizationId))
          .statusCode,
      ).toBe(404);
      const history = await request(
        'GET',
        `/api/v1/projects/${globex.projectId}/imports`,
        as(globex.owner, undefined, globex.organizationId),
      );
      expect(history.json()).toEqual([]);
      expect(await owner.testCase.count()).toBe(0);
    });

    it('enforces RLS on import_jobs for the runtime role', async () => {
      await upload(acme.owner, CSV);
      const runtime = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
      try {
        expect(await runtime.importJob.count()).toBe(0);
        const visible = await runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization', ${acme.organizationId}, TRUE)`;
          return tx.importJob.count();
        });
        expect(visible).toBe(1);
        await expect(
          runtime.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_organization', ${acme.organizationId}, TRUE)`;
            return tx.importJob.deleteMany();
          }),
        ).rejects.toThrow();
      } finally {
        await runtime.$disconnect();
      }
    });

    it('refuses imports into an archived project', async () => {
      const job = (await upload(acme.owner, CSV)).json();
      await request('POST', `/api/v1/projects/${acme.projectId}/archive`, as(acme.owner));
      expect((await upload(acme.owner, CSV)).statusCode).toBe(409);
      expect((await commit(acme.owner, job.id)).statusCode).toBe(409);
      expect(await owner.testCase.count()).toBe(0);
    });

    it('lists the history newest first, without issues', async () => {
      await upload(acme.owner, 'title\nab\n');
      await upload(acme.owner, CSV);
      const history = (
        await request('GET', `/api/v1/projects/${acme.projectId}/imports`, as(acme.owner))
      ).json();
      expect(history.map((job: { status: string }) => job.status)).toEqual(['ready', 'invalid']);
      expect(history[0].issues).toBeUndefined();
    });
  });

  describe('exports', () => {
    const exportCases = (
      account: TestAccount,
      projectId = acme.projectId,
      organizationId = acme.organizationId,
    ) =>
      request(
        'GET',
        `/api/v1/projects/${projectId}/exports/test-cases.csv`,
        as(account, undefined, organizationId),
      );

    it('exports test cases as an Excel-safe CSV that imports back as duplicates', async () => {
      await createRequirement('Users can sign in');
      await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
      const suite = await owner.testSuite.findFirstOrThrow();
      await request(
        'POST',
        '/api/v1/test-cases',
        as(acme.owner, { suiteId: suite.id, title: '=HYPERLINK("http://evil.test","x")' }),
      );

      const response = await exportCases(acme.owner);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toMatch(
        /^attachment; filename="WEB-test-cases-\d{4}-\d{2}-\d{2}\.csv"/,
      );
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body.startsWith('\uFEFFref,suite,section,title,')).toBe(true);
      expect(response.body).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
      expect(response.body).toContain('WEB-C-1,Imported,Login > OAuth,Sign in with Google,');
      expect(response.body).toContain('WEB-R-1');
      expect(await owner.auditLog.count({ where: { action: 'export' } })).toBe(1);

      const reimport = (await upload(acme.owner, Buffer.from(response.body.slice(1)))).json();
      expect(reimport.status).toBe('ready');
      expect(reimport.summary).toMatchObject({ cases: 0, duplicates: 4 });
    });

    it('lets a viewer export, unless data.export is revoked for them', async () => {
      const viewer = await acme.addMember('viewer');
      expect((await exportCases(viewer)).statusCode).toBe(200);
      await request(
        'PUT',
        `/api/v1/projects/${acme.projectId}/permissions/members/${viewer.userId}`,
        as(acme.owner, { overrides: [{ permission: 'data.export', effect: 'revoke' }] }),
      );
      expect((await exportCases(viewer)).statusCode).toBe(403);
    });

    it('exports a run from its snapshots and hides deleted or foreign runs', async () => {
      await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
      const caseIds = (await owner.testCase.findMany({ select: { id: true } })).map(
        (testCase) => testCase.id,
      );
      const run = (
        await request(
          'POST',
          '/api/v1/test-runs',
          as(acme.owner, {
            projectId: acme.projectId,
            name: 'Release 1',
            selection: { testCaseIds: caseIds },
          }),
        )
      ).json();
      await request(
        'PATCH',
        `/api/v1/test-cases/${caseIds[0]}`,
        as(acme.owner, { title: 'Renamed after the run' }),
      );

      const response = await request(
        'GET',
        `/api/v1/test-runs/${run.id}/export.csv`,
        as(acme.owner),
      );
      expect(response.statusCode).toBe(200);
      expect(response.body.startsWith('\uFEFFkey,title,priority,type,case_version,status,')).toBe(
        true,
      );
      expect(response.body).not.toContain('Renamed after the run');
      expect(response.headers['x-export-rows']).toBe('3');

      const globex = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'GLX',
      });
      expect(
        (
          await request(
            'GET',
            `/api/v1/test-runs/${run.id}/export.csv`,
            as(globex.owner, undefined, globex.organizationId),
          )
        ).statusCode,
      ).toBe(404);
      await request('DELETE', `/api/v1/test-runs/${run.id}`, as(acme.owner));
      expect(
        (await request('GET', `/api/v1/test-runs/${run.id}/export.csv`, as(acme.owner))).statusCode,
      ).toBe(404);
    });

    it('exports the traceability matrix one row per requirement and case', async () => {
      await createRequirement('Users can sign in');
      await createRequirement('Nobody covers this');
      await commit(acme.owner, (await upload(acme.owner, CSV)).json().id);
      const response = await request(
        'GET',
        `/api/v1/traceability/matrix/export.csv?projectId=${acme.projectId}`,
        as(acme.owner),
      );
      expect(response.statusCode).toBe(200);
      const lines = response.body.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe(
        'requirement_key,requirement_title,requirement_status,requirement_priority,covered,verified,case_key,case_title,case_last_status,case_archived,open_defects',
      );
      expect(
        lines.some(
          (line) =>
            line.startsWith('WEB-R-1,Users can sign in,') &&
            line.includes(',yes,') &&
            line.includes('WEB-C-1'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (line) => line.startsWith('WEB-R-2,Nobody covers this,') && line.includes(',no,'),
        ),
      ).toBe(true);

      const globex = await createWorkspace(app, {
        emailPrefix: 'globex-owner',
        slug: 'globex',
        projectKey: 'GLX',
      });
      const foreign = await request(
        'GET',
        `/api/v1/traceability/matrix/export.csv?projectId=${acme.projectId}`,
        as(globex.owner, undefined, globex.organizationId),
      );
      expect(foreign.statusCode).toBe(404);
    });
  });
});
