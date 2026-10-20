import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IngestionRepository } from '../src/modules/automation/ingestion.repository';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * API keys and report ingestion, with the API connected as `qaflow_app` so
 * `api_keys`, `ingestion_reports` and every table an ingestion writes are
 * under Row Level Security. The owner connection only asserts state.
 */
describe('API keys and report ingestion', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let suiteId: string;

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

  const createKey = async (
    payload: object = { name: 'CI' },
    workspace: TestWorkspace = acme,
    projectId = workspace.projectId,
  ): Promise<{ id: string; token: string; prefix: string }> => {
    const response = await request(
      'POST',
      `/api/v1/projects/${projectId}/api-keys`,
      as(workspace.owner, payload, workspace),
    );
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    return { id: body.key.id, token: body.token, prefix: body.key.prefix };
  };

  const ingest = (
    token: string | null,
    content: string | Buffer,
    options: {
      kind?: 'junit' | 'playwright';
      query?: string;
      idempotencyKey?: string;
    } = {},
  ) => {
    const boundary = 'qa-flow-hub-ingest';
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="report"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    return app.inject({
      method: 'POST',
      url: `/api/v1/ingest/${options.kind ?? 'junit'}${options.query === undefined ? '' : `?${options.query}`}`,
      payload: Buffer.concat([
        Buffer.from(head),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { 'idempotency-key': options.idempotencyKey }),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  const createCase = async (
    title: string,
    workspace = acme,
    suite = suiteId,
  ): Promise<{ id: string; key: string }> =>
    (
      await request(
        'POST',
        '/api/v1/test-cases',
        as(workspace.owner, { suiteId: suite, title }, workspace),
      )
    ).json();

  const counts = async () => ({
    runs: await owner.testRun.count(),
    runCases: await owner.testRunCase.count(),
    results: await owner.testResult.count(),
    reports: await owner.ingestionReport.count(),
  });

  const junit = (cases: string, name = 'web-e2e'): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${name}">\n<testsuite name="checkout">\n${cases}\n</testsuite>\n</testsuites>`;

  const REPORT = junit(
    [
      '<testcase classname="checkout.spec" name="WEB-C-1 pays with a card" time="1.5"/>',
      '<testcase classname="checkout.spec" name="WEB-C-2 rejects an expired card" time="2.25">',
      '  <failure message="Expected 402, got 200">at checkout.spec.ts:42</failure>',
      '</testcase>',
      '<testcase classname="checkout.spec" name="WEB-C-999 unknown case" time="0.1"/>',
      '<testcase classname="checkout.spec" name="no key here" time="0.1"><skipped/></testcase>',
    ].join('\n'),
  );

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({
      databaseUrl: appRoleUrl(),
      ingestion: { rateLimitMax: 10_000, maxBytes: 64 * 1024, maxTests: 50 },
    });
  });

  beforeEach(async () => {
    await truncate();
    acme = await createWorkspace(app, { emailPrefix: 'acme-owner', slug: 'acme' });
    suiteId = (
      await request(
        'POST',
        '/api/v1/test-suites',
        as(acme.owner, { projectId: acme.projectId, name: 'Checkout' }),
      )
    ).json().id;
  });

  afterAll(async () => {
    await truncate();
    await app.close();
    await owner.$disconnect();
  });

  describe('key management', () => {
    it('returns the token once, stores only its SHA-256 and never lists it again', async () => {
      const key = await createKey({ name: 'GitHub Actions', expiresInDays: 30 });
      expect(key.token).toMatch(/^qfh_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
      expect(key.token.startsWith(`${key.prefix}_`)).toBe(true);

      const row = await owner.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(key.token.slice('qfh_'.length + 13));
      expect(row.expiresAt).not.toBeNull();

      const list = await request(
        'GET',
        `/api/v1/projects/${acme.projectId}/api-keys`,
        as(acme.owner),
      );
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
      expect(list.json()[0]).toMatchObject({
        name: 'GitHub Actions',
        state: 'active',
        scopes: ['results:ingest'],
      });
      expect(list.body).not.toContain(key.token.slice('qfh_'.length + 13));
      expect(list.json()[0]).not.toHaveProperty('token');
      expect(list.json()[0]).not.toHaveProperty('secretHash');

      const audit = await owner.auditLog.findMany({ where: { entityType: 'ApiKey' } });
      expect(audit.map((entry) => entry.action)).toEqual(['create']);
      expect(JSON.stringify(audit)).not.toContain(key.token.slice('qfh_'.length + 13));
    });

    it('validates the input', async () => {
      for (const payload of [
        { name: '' },
        { name: 'x', scopes: [] },
        { name: 'x', scopes: ['admin'] },
        { name: 'x', expiresInDays: 0 },
        { name: 'x', expiresInDays: 366 },
      ]) {
        const response = await request(
          'POST',
          `/api/v1/projects/${acme.projectId}/api-keys`,
          as(acme.owner, payload),
        );
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(await owner.apiKey.count()).toBe(0);
    });

    it('requires api_keys.manage: project_manager can, qa_lead and tester cannot', async () => {
      const manager = await acme.addMember('project_manager');
      const lead = await acme.addMember('qa_lead');
      const tester = await acme.addMember('tester');
      const url = `/api/v1/projects/${acme.projectId}/api-keys`;
      expect((await request('POST', url, as(manager, { name: 'pm' }))).statusCode).toBe(201);
      expect((await request('POST', url, as(lead, { name: 'lead' }))).statusCode).toBe(403);
      expect((await request('GET', url, as(tester))).statusCode).toBe(403);
      expect(await owner.apiKey.count()).toBe(1);
    });

    it('hides the keys of a project the member has no grant on, and of another organization', async () => {
      const manager = await acme.addMember('project_manager', 'pm-nogrant', {
        projectAccess: false,
      });
      const url = `/api/v1/projects/${acme.projectId}/api-keys`;
      const hidden = await request('GET', url, as(manager));
      expect(hidden.statusCode).toBe(404);
      expect((await request('POST', url, as(manager, { name: 'x' }))).statusCode).toBe(404);

      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      const cross = await request('GET', url, as(globex.owner, undefined, globex));
      expect(cross.statusCode).toBe(404);
      const key = await createKey();
      const revoke = await request(
        'POST',
        `/api/v1/projects/${globex.projectId}/api-keys/${key.id}/revoke`,
        as(globex.owner, undefined, globex),
      );
      expect(revoke.statusCode).toBe(404);
      expect(
        (await owner.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt,
      ).toBeNull();
    });

    it('revokes immediately, idempotently, auditing once', async () => {
      await createCase('Pay');
      const key = await createKey();
      expect((await ingest(key.token, REPORT)).statusCode).toBe(200);

      const url = `/api/v1/projects/${acme.projectId}/api-keys/${key.id}/revoke`;
      const first = await request('POST', url, as(acme.owner));
      expect(first.statusCode).toBe(200);
      expect(first.json().state).toBe('revoked');
      expect((await request('POST', url, as(acme.owner))).statusCode).toBe(200);

      const after = await ingest(key.token, `${REPORT}\n`);
      expect(after.statusCode).toBe(401);
      expect(after.json().error.code).toBe('UNAUTHENTICATED');
      const actions = (
        await owner.auditLog.findMany({ where: { entityType: 'ApiKey', action: 'revoke' } })
      ).length;
      expect(actions).toBe(1);
    });
  });

  describe('authentication of the ingestion endpoints', () => {
    it('rejects a missing, malformed, unknown or tampered token with one response', async () => {
      const key = await createKey();
      const tampered = `${key.token.slice(0, -1)}${key.token.endsWith('A') ? 'B' : 'A'}`;
      const unknown = `qfh_${'Z'.repeat(12)}_${'a'.repeat(43)}`;
      const responses = await Promise.all(
        [null, 'not-a-key', unknown, tampered, acme.owner.accessToken].map((token) =>
          ingest(token, REPORT),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toMatchObject({
          code: 'UNAUTHENTICATED',
          message: 'The API key is invalid, expired or revoked',
        });
      }
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
      const rejected = await owner.auditLog.findMany({
        where: { entityType: 'ApiKey', action: 'execute' },
      });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.summary).toContain('wrong secret');
      expect(JSON.stringify(rejected)).not.toContain(tampered.slice('qfh_'.length + 13));
    });

    it('accepts X-Api-Key and ignores X-Organization-Id pointing elsewhere', async () => {
      await createCase('Pay');
      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      const key = await createKey();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest/junit',
        payload: Buffer.from(
          `--b\r\nContent-Disposition: form-data; name="file"; filename="r.xml"\r\n\r\n${REPORT}\r\n--b--\r\n`,
        ),
        headers: {
          'x-api-key': key.token,
          'x-organization-id': globex.organizationId,
          'content-type': 'multipart/form-data; boundary=b',
        },
      });
      expect(response.statusCode).toBe(200);
      const run = await owner.testRun.findFirstOrThrow();
      expect(run.organizationId).toBe(acme.organizationId);
      expect(run.projectId).toBe(acme.projectId);
    });

    it('rejects an expired key immediately and audits the attempt', async () => {
      const key = await createKey({ name: 'short', expiresInDays: 1 });
      await owner.apiKey.update({
        where: { id: key.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const response = await ingest(key.token, REPORT);
      expect(response.statusCode).toBe(401);
      const list = await request(
        'GET',
        `/api/v1/projects/${acme.projectId}/api-keys`,
        as(acme.owner),
      );
      expect(list.json()[0].state).toBe('expired');
      const rejected = await owner.auditLog.findFirstOrThrow({
        where: { entityType: 'ApiKey', action: 'execute' },
      });
      expect(rejected.summary).toContain('expired');
    });

    it('requires the results:ingest scope', async () => {
      const key = await createKey();
      await owner.apiKey.update({ where: { id: key.id }, data: { scopes: [] } });
      const response = await ingest(key.token, REPORT);
      expect(response.statusCode).toBe(403);
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
    });

    it('stops working when its organization is deleted', async () => {
      const key = await createKey();
      await owner.organization.update({
        where: { id: acme.organizationId },
        data: { deletedAt: new Date() },
      });
      expect((await ingest(key.token, REPORT)).statusCode).toBe(401);
    });
  });

  describe('JUnit ingestion', () => {
    it('creates a run and maps suite, test, result, duration and error', async () => {
      const pay = await createCase('Pay with a card');
      const expired = await createCase('Reject an expired card');
      expect([pay.key, expired.key]).toEqual(['WEB-C-1', 'WEB-C-2']);
      const key = await createKey();

      const response = await ingest(key.token, REPORT, {
        query: 'environment=staging&milestone=1.4',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.duplicate).toBe(false);
      expect(body.report.summary).toEqual({
        tests: 4,
        passed: 2,
        failed: 1,
        skipped: 1,
        recorded: 2,
        unmatched: 2,
      });
      expect(body.report.unmatched).toEqual([
        {
          name: 'checkout > checkout.spec > WEB-C-999 unknown case',
          outcome: 'passed',
          reason: 'case_not_found',
        },
        {
          name: 'checkout > checkout.spec > no key here',
          outcome: 'skipped',
          reason: 'no_case_key',
        },
      ]);
      expect(body.report.apiKeyPrefix).toBe(key.prefix);

      const run = await owner.testRun.findUniqueOrThrow({ where: { id: body.report.testRunId } });
      expect(run).toMatchObject({
        status: 'in_progress',
        environment: 'staging',
        milestone: '1.4',
        projectId: acme.projectId,
      });
      expect(run.name).toContain('web-e2e');

      const results = await owner.testResult.findMany({
        include: { testRunCase: true },
        orderBy: { status: 'asc' },
      });
      const byCase = new Map(results.map((result) => [result.testRunCase.testCaseId, result]));
      expect(byCase.get(pay.id)).toMatchObject({
        status: 'passed',
        elapsedSeconds: 2,
        executedById: null,
      });
      expect(byCase.get(expired.id)).toMatchObject({ status: 'failed', elapsedSeconds: 2 });
      expect(byCase.get(expired.id)!.comment).toContain('Expected 402, got 200');
      expect(byCase.get(expired.id)!.comment).toContain('at checkout.spec.ts:42');
      const runCases = await owner.testRunCase.findMany();
      expect(runCases.map((rc) => rc.latestStatus).sort()).toEqual(['failed', 'passed']);
      expect((runCases[0]!.caseSnapshot as { key: string }).key).toMatch(/^WEB-C-[12]$/);

      const keyRow = await owner.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(keyRow.lastUsedAt).not.toBeNull();
      const audit = await owner.auditLog.findFirstOrThrow({
        where: { entityType: 'IngestionReport' },
      });
      expect(audit.organizationId).toBe(acme.organizationId);
      expect(audit.userId).toBeNull();
      expect(JSON.stringify(audit)).not.toContain(key.token.slice('qfh_'.length + 13));
      const history = await request(
        'GET',
        `/api/v1/projects/${acme.projectId}/ingestion-reports`,
        as(acme.owner),
      );
      expect(history.json()).toHaveLength(1);
    });

    it('aggregates several tests of one case: any failure fails it, skipped only if all are', async () => {
      await createCase('Case A');
      await createCase('Case B');
      const key = await createKey();
      const report = junit(
        [
          '<testcase name="WEB-C-1 chrome" time="1"/>',
          '<testcase name="WEB-C-1 firefox" time="2"><error message="boom"/></testcase>',
          '<testcase name="WEB-C-2 one"><skipped/></testcase>',
          '<testcase name="WEB-C-2 two"><skipped/></testcase>',
        ].join(''),
      );
      const body = (await ingest(key.token, report)).json();
      expect(body.report.recorded).toEqual([
        { caseKey: 'WEB-C-1', status: 'failed', tests: 2, elapsedSeconds: 3 },
        { caseKey: 'WEB-C-2', status: 'skipped', tests: 2, elapsedSeconds: null },
      ]);
    });

    it('records into an existing open run and reports cases outside it', async () => {
      const one = await createCase('One');
      await createCase('Two');
      const key = await createKey();
      const run = (
        await request(
          'POST',
          '/api/v1/test-runs',
          as(acme.owner, {
            projectId: acme.projectId,
            name: 'Nightly',
            selection: { testCaseIds: [one.id] },
          }),
        )
      ).json();
      const response = await ingest(
        key.token,
        junit('<testcase name="WEB-C-1"/><testcase name="WEB-C-2"/>'),
        {
          query: `runId=${run.id}`,
        },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().report.testRunId).toBe(run.id);
      expect(response.json().report.unmatched).toEqual([
        { name: 'checkout > WEB-C-2', outcome: 'passed', reason: 'case_not_in_run' },
      ]);
      expect(await owner.testRun.count()).toBe(1);
      expect(await owner.testRunCase.count()).toBe(1);
    });

    it('refuses a closed run, a run of another project and a run of another organization', async () => {
      await createCase('One');
      const key = await createKey();
      const closed = await owner.testRun.create({
        data: {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
          name: 'Old',
          status: 'completed',
        },
      });
      const other = (
        await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' }))
      ).json();
      const otherRun = await owner.testRun.create({
        data: { organizationId: acme.organizationId, projectId: other.id, name: 'Mobile run' },
      });
      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      const foreignRun = await owner.testRun.create({
        data: {
          organizationId: globex.organizationId,
          projectId: globex.projectId,
          name: 'Foreign',
        },
      });
      const before = await counts();

      const closedResponse = await ingest(key.token, REPORT, { query: `runId=${closed.id}` });
      expect(closedResponse.statusCode).toBe(409);
      for (const runId of [otherRun.id, foreignRun.id, 'does-not-exist']) {
        const response = await ingest(key.token, REPORT, { query: `runId=${runId}` });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.message).toBe('Test run not found');
      }
      expect(await counts()).toEqual(before);
    });

    it('matches only the case keys of the key project', async () => {
      await createCase('Web');
      const other = (
        await request('POST', '/api/v1/projects', as(acme.owner, { name: 'Mobile', key: 'MOB' }))
      ).json();
      const mobileSuite = (
        await request(
          'POST',
          '/api/v1/test-suites',
          as(acme.owner, { projectId: other.id, name: 'M' }),
        )
      ).json().id;
      await createCase('Mobile', acme, mobileSuite);
      const key = await createKey();
      const body = (
        await ingest(
          key.token,
          junit('<testcase name="MOB-C-1"/><testcase name="XWEB-C-1"/><testcase name="WEB-C-10"/>'),
        )
      ).json();
      expect(body.report.summary.recorded).toBe(0);
      expect(body.report.testRunId).toBeNull();
      expect(await owner.testRun.count()).toBe(0);
      expect(await owner.ingestionReport.count()).toBe(1);
    });

    it('refuses to ingest into an archived project', async () => {
      const key = await createKey();
      await owner.project.update({
        where: { id: acme.projectId },
        data: { status: 'archived', archivedAt: new Date() },
      });
      expect((await ingest(key.token, REPORT)).statusCode).toBe(409);
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
    });
  });

  describe('idempotency and concurrency', () => {
    it('returns the original report for a resend and creates nothing new', async () => {
      await createCase('Pay');
      await createCase('Expired');
      const key = await createKey();
      const first = (await ingest(key.token, REPORT)).json();
      const before = await counts();
      const again = await ingest(key.token, REPORT);
      expect(again.statusCode).toBe(200);
      expect(again.json().duplicate).toBe(true);
      expect(again.json().report.id).toBe(first.report.id);
      expect(await counts()).toEqual(before);
    });

    it('honours Idempotency-Key and refuses it for a different report', async () => {
      await createCase('Pay');
      const key = await createKey();
      expect(
        (await ingest(key.token, REPORT, { idempotencyKey: 'build-1234' })).json().duplicate,
      ).toBe(false);
      const conflict = await ingest(key.token, `${REPORT} `, { idempotencyKey: 'build-1234' });
      expect(conflict.statusCode).toBe(409);
      const invalid = await ingest(key.token, REPORT, { idempotencyKey: 'short' });
      expect(invalid.statusCode).toBe(400);
      // Same bytes under a new key are a new upload on purpose (a rerun).
      expect(
        (await ingest(key.token, REPORT, { idempotencyKey: 'build-1235' })).json().duplicate,
      ).toBe(false);
      expect(await owner.ingestionReport.count()).toBe(2);
    });

    it('lets exactly one of many simultaneous resends write', async () => {
      await createCase('Pay');
      await createCase('Expired');
      const key = await createKey();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => ingest(key.token, REPORT)),
      );
      expect(responses.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
      expect(responses.filter((r) => r.json().duplicate === false)).toHaveLength(1);
      expect(new Set(responses.map((r) => r.json().report.id)).size).toBe(1);
      expect(await counts()).toEqual({ runs: 1, runCases: 2, results: 2, reports: 1 });
    });

    it('serializes different reports into the same run without losing results', async () => {
      const one = await createCase('One');
      const run = (
        await request(
          'POST',
          '/api/v1/test-runs',
          as(acme.owner, {
            projectId: acme.projectId,
            name: 'Shared',
            selection: { testCaseIds: [one.id] },
          }),
        )
      ).json();
      const key = await createKey();
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          ingest(key.token, junit(`<testcase name="WEB-C-1 shard ${index}"/>`), {
            query: `runId=${run.id}`,
          }),
        ),
      );
      expect(responses.every((r) => r.statusCode === 200 && r.json().duplicate === false)).toBe(
        true,
      );
      expect(await owner.testResult.count()).toBe(5);
      expect(await owner.ingestionReport.count()).toBe(5);
    });

    it('a revocation racing an ingestion leaves no result recorded after it returns', async () => {
      await createCase('Pay');
      const key = await createKey();
      const revoke = request(
        'POST',
        `/api/v1/projects/${acme.projectId}/api-keys/${key.id}/revoke`,
        as(acme.owner),
      );
      const uploads = Array.from({ length: 4 }, (_, index) =>
        ingest(key.token, `${REPORT}${' '.repeat(index)}`),
      );
      const [revoked] = await Promise.all([revoke, ...uploads]);
      const revokedAt = (await owner.apiKey.findUniqueOrThrow({ where: { id: key.id } }))
        .revokedAt!;
      expect(revoked.statusCode).toBe(200);
      const late = await owner.ingestionReport.findMany({
        where: { createdAt: { gt: revokedAt } },
      });
      expect(late).toHaveLength(0);
      expect((await ingest(key.token, `${REPORT}x`)).statusCode).toBe(401);
    });
  });

  describe('atomicity', () => {
    it('leaves no run, run case, result or report when the last write fails', async () => {
      await createCase('Pay');
      await createCase('Expired');
      const key = await createKey();
      const spy = vi
        .spyOn(IngestionRepository.prototype, 'createReport')
        .mockRejectedValueOnce(new Error('disk full'));
      try {
        const response = await ingest(key.token, REPORT);
        expect(response.statusCode).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
      expect(
        (await owner.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt,
      ).toBeNull();
      // And the same report goes through on retry: no idempotency row was left behind.
      expect((await ingest(key.token, REPORT)).json().duplicate).toBe(false);
    });
  });

  describe('invalid and dangerous reports', () => {
    const reasonOf = async (content: string | Buffer, kind: 'junit' | 'playwright' = 'junit') => {
      const key = await createKey({ name: `k-${Math.random()}` });
      const response = await ingest(key.token, content, { kind });
      return { status: response.statusCode, error: response.json().error };
    };

    it('refuses DTDs, external entities and entity expansion before parsing', async () => {
      await createCase('Pay');
      const payloads = [
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><testsuites><testsuite><testcase name="WEB-C-1 &xxe;"/></testsuite></testsuites>',
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><testsuites>&lol2;</testsuites>',
        '<!doctype testsuites SYSTEM "http://attacker.example/x.dtd"><testsuites/>',
        '<testsuites><!ENTITY x "y"></testsuites>',
      ];
      for (const payload of payloads) {
        const { status, error } = await reasonOf(payload);
        expect(status).toBe(400);
        expect(error.code).toBe('INVALID_REPORT');
        expect(error.details[0].message).toMatch(/^REPORT_DTD_FORBIDDEN/);
      }
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
    });

    it('explains empty, non UTF-8, malformed and unsupported reports', async () => {
      const cases: Array<[string | Buffer, string, 'junit' | 'playwright']> = [
        ['', 'REPORT_EMPTY', 'junit'],
        ['   \n', 'REPORT_EMPTY', 'junit'],
        [Buffer.from([0x3c, 0x74, 0xff, 0xfe]), 'REPORT_NOT_UTF8', 'junit'],
        ['<testsuites><testsuite>', 'REPORT_MALFORMED', 'junit'],
        ['<testsuites><testcase name="a &unknown;"/></testsuites>', 'REPORT_MALFORMED', 'junit'],
        ['<html><body/></html>', 'REPORT_UNSUPPORTED', 'junit'],
        ['{"suites": [', 'REPORT_MALFORMED', 'playwright'],
        ['{"tests": []}', 'REPORT_UNSUPPORTED', 'playwright'],
        [
          '{"suites": [{"specs": [{"tests": [{"status": "weird"}]}]}]}',
          'REPORT_MALFORMED',
          'playwright',
        ],
        ['<testsuites/>', 'REPORT_MALFORMED', 'playwright'],
      ];
      for (const [content, reason, kind] of cases) {
        const { status, error } = await reasonOf(content, kind);
        expect(status, `${reason} ${String(content)}`).toBe(400);
        expect(error.code).toBe('INVALID_REPORT');
        expect(error.details[0].message.startsWith(reason), error.details[0].message).toBe(true);
      }
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
    });

    it('enforces the byte and test count limits', async () => {
      const key = await createKey();
      const big = await ingest(key.token, `<testsuites>${' '.repeat(70 * 1024)}</testsuites>`);
      expect(big.statusCode).toBe(413);
      expect(big.json().error.code).toBe('REPORT_TOO_LARGE');
      const many = await ingest(key.token, junit('<testcase name="t"/>'.repeat(51)));
      expect(many.statusCode).toBe(413);
      expect(many.json().error.details[0].path).toBe('tests');
      const deep = await ingest(
        key.token,
        `<testsuites>${'<testsuite>'.repeat(40)}${'</testsuite>'.repeat(40)}</testsuites>`,
      );
      expect(deep.statusCode).toBe(400);
      expect(await counts()).toEqual({ runs: 0, runCases: 0, results: 0, reports: 0 });
    });

    it('requires a multipart body', async () => {
      const key = await createKey();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/ingest/junit',
        payload: { file: REPORT },
        headers: { authorization: `Bearer ${key.token}` },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('Playwright JSON ingestion', () => {
    it('maps specs, tags, annotations, flaky retries and errors', async () => {
      await createCase('Login');
      await createCase('Logout');
      await createCase('Search');
      const key = await createKey();
      const report = {
        config: {},
        suites: [
          {
            title: 'auth.spec.ts',
            file: 'auth.spec.ts',
            specs: [
              {
                title: 'logs in',
                tags: ['@WEB-C-1'],
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'flaky',
                    annotations: [],
                    results: [
                      { status: 'failed', duration: 1200, error: { message: 'timeout' } },
                      { status: 'passed', duration: 800 },
                    ],
                  },
                ],
              },
            ],
            suites: [
              {
                title: 'logout',
                specs: [
                  {
                    title: 'logs out',
                    tests: [
                      {
                        projectName: 'firefox',
                        status: 'unexpected',
                        annotations: [{ type: 'issue', description: 'WEB-C-2' }],
                        results: [
                          {
                            status: 'failed',
                            duration: 3000,
                            error: { message: '\u001b[31mExpected visible\u001b[39m' },
                          },
                        ],
                      },
                    ],
                  },
                  { title: 'WEB-C-3 searches', tests: [{ status: 'skipped', results: [] }] },
                ],
              },
            ],
          },
        ],
      };
      const response = await ingest(key.token, JSON.stringify(report), { kind: 'playwright' });
      expect(response.statusCode).toBe(200);
      expect(response.json().report.format).toBe('playwright_json');
      expect(response.json().report.recorded).toEqual([
        { caseKey: 'WEB-C-1', status: 'passed', tests: 1, elapsedSeconds: 2 },
        { caseKey: 'WEB-C-2', status: 'failed', tests: 1, elapsedSeconds: 3 },
        { caseKey: 'WEB-C-3', status: 'skipped', tests: 1, elapsedSeconds: null },
      ]);
      const failed = await owner.testResult.findFirstOrThrow({ where: { status: 'failed' } });
      expect(failed.comment).toContain('logout > logs out [firefox]: Expected visible');
      expect(failed.comment).not.toContain('\u001b');
    });

    it('the Playwright JUnit reporter output goes through the JUnit endpoint', async () => {
      await createCase('Login');
      const key = await createKey();
      const xml =
        '<testsuites id="" name="" tests="1" failures="0" skipped="0" errors="0" time="1.2">' +
        '<testsuite name="auth.spec.ts" timestamp="2026-10-04T10:00:00.000Z" hostname="chromium" tests="1" failures="0" skipped="0" time="1.2" errors="0">' +
        '<testcase name="logs in @WEB-C-1" classname="auth.spec.ts" time="1.2"><properties><property name="tag" value="smoke"/></properties></testcase>' +
        '</testsuite></testsuites>';
      const response = await ingest(key.token, xml);
      expect(response.statusCode).toBe(200);
      expect(response.json().report.recorded).toEqual([
        { caseKey: 'WEB-C-1', status: 'passed', tests: 1, elapsedSeconds: 1 },
      ]);
    });
  });
});
