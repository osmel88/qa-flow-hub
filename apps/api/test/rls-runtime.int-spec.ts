import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector, registerAccount } from './utils/workspace';

/**
 * The API booted as `qaflow_app`, the role it runs as in production, with Row
 * Level Security applied to everything it writes.
 *
 * `rls.int-spec.ts` proves the policies from the database side. This suite asks
 * the application side of the same question: the flows that run *before* the
 * caller has an active organization — creating one, accepting an invitation —
 * write rows that belong to a tenant nobody has announced yet. Under the owner
 * connection every other suite uses, forgetting to announce it is invisible;
 * under the runtime role it is a policy violation and a 500.
 *
 * One application per process: the suites share the Nest module graph, and a
 * second app in the same file does not authenticate cleanly, so this file boots
 * only the runtime-role app and reaches the database as the owner for truncation
 * and assertions.
 */
describe('the API connected as the runtime role', () => {
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
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;
    const list = tables.map((row) => `"${row.tablename}"`).join(', ');
    if (list.length === 0) {
      return;
    }
    // Same dance as PrismaService.truncateAllTables: the append-only guard on
    // audit_logs is lifted for the wipe, as the owner, and restored right after.
    await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER USER`);
    try {
      await owner.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    } finally {
      await owner.$executeRawUnsafe(`ALTER TABLE "audit_logs" ENABLE TRIGGER USER`);
    }
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({ databaseUrl: appRoleUrl() });
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

  it('runs as the non-owning role, so the policies apply', async () => {
    const rows = await app.get(PrismaService).$queryRaw<
      Array<{ current_user: string }>
    >`SELECT current_user`;

    expect(rows[0]?.current_user).toBe('qaflow_app');
  });

  it('creates an organization and records its audit entry', async () => {
    const founder = await registerAccount(app, 'founder@example.test');

    const created = await request('POST', '/api/v1/organizations', {
      payload: { name: 'Initech', slug: 'initech' },
      token: founder.accessToken,
    });

    expect(created.statusCode, created.body).toBe(201);
    const organizationId: string = created.json().id;
    const audit = await owner.auditLog.findMany({
      where: { organizationId, entityType: 'Organization' },
    });
    expect(audit).toHaveLength(1);
  });

  it('lets an invited user accept and join, audited under the joined organization', async () => {
    const guest = await registerAccount(app, 'guest@example.test');
    const invited = await request('POST', '/api/v1/organizations/current/invitations', {
      payload: { email: guest.email, role: 'qa_lead' },
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });
    expect(invited.statusCode, invited.body).toBe(201);

    const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
      payload: { token: invited.json().token },
      token: guest.accessToken,
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ organizationId: acme.organizationId, role: 'qa_lead' });

    const membership = await owner.organizationMember.findFirst({
      where: { organizationId: acme.organizationId, userId: guest.userId },
    });
    expect(membership?.role).toBe('qa_lead');
    const audit = await owner.auditLog.findMany({
      where: { organizationId: acme.organizationId, action: 'accept_invite' },
    });
    expect(audit).toHaveLength(1);
  });

  it('still enforces the tenant boundary on ordinary project routes', async () => {
    const globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLO',
    });

    await request('POST', '/api/v1/requirements', {
      payload: { projectId: globex.projectId, title: 'Globex login', type: 'functional' },
      token: globex.owner.accessToken,
      organizationId: globex.organizationId,
    });

    const stolen = await request('GET', `/api/v1/requirements?projectId=${globex.projectId}`, {
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });

    expect(stolen.json().data).toEqual([]);
  });
  it('computes analytics under the policies and never across tenants', async () => {
    const asAcme = (payload?: object) => ({
      ...(payload === undefined ? {} : { payload }),
      token: acme.owner.accessToken,
      organizationId: acme.organizationId,
    });
    const globex = await createWorkspace(app, {
      emailPrefix: 'globex-owner',
      slug: 'globex',
      projectKey: 'GLO',
    });

    const suiteId = (
      await request(
        'POST',
        '/api/v1/test-suites',
        asAcme({ projectId: acme.projectId, name: 'Checkout' }),
      )
    ).json().id;
    const caseId = (
      await request('POST', '/api/v1/test-cases', asAcme({ suiteId, title: 'Pay by card' }))
    ).json().id;
    const requirementId = (
      await request(
        'POST',
        '/api/v1/requirements',
        asAcme({ projectId: acme.projectId, title: 'Pay', type: 'functional' }),
      )
    ).json().id;
    await request(
      'POST',
      '/api/v1/traceability/links',
      asAcme({
        sourceType: 'requirement',
        sourceId: requirementId,
        targetType: 'test_case',
        targetId: caseId,
        linkType: 'verifies',
      }),
    );
    const run = await request(
      'POST',
      '/api/v1/test-runs',
      asAcme({
        projectId: acme.projectId,
        name: 'Release run',
        selection: { testCaseIds: [caseId] },
      }),
    );
    expect(run.statusCode, run.body).toBe(201);
    const runId: string = run.json().id;
    const runCaseId = (await request('GET', `/api/v1/test-runs/${runId}/cases`, asAcme())).json()
      .data[0].id;
    await request(
      'POST',
      `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
      asAcme({ status: 'passed' }),
    );
    await request(
      'POST',
      '/api/v1/defects',
      asAcme({ projectId: acme.projectId, title: 'Found one', severity: 'critical' }),
    );

    const summary = await request(
      'GET',
      `/api/v1/projects/${acme.projectId}/dashboard/summary`,
      asAcme(),
    );
    const trends = await request(
      'GET',
      `/api/v1/projects/${acme.projectId}/dashboard/trends`,
      asAcme(),
    );
    const organization = await request('GET', '/api/v1/dashboard/organization', asAcme());
    const theirs = await request('GET', '/api/v1/dashboard/organization', {
      token: globex.owner.accessToken,
      organizationId: globex.organizationId,
    });

    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({
      execution: { planned: 1, passRate: 100 },
      coverage: { requirements: 1, covered: 1 },
      defects: { open: 1, openCritical: 1 },
    });
    expect(
      trends
        .json()
        .points.reduce((sum: number, point: { results: number }) => sum + point.results, 0),
    ).toBe(1);
    expect(organization.json().recentActivity.length).toBeGreaterThan(0);
    expect(theirs.json().health).toMatchObject({ openDefects: 0, execution: { planned: 0 } });
    expect(theirs.json().recentActivity).toEqual([]);
  });
});
