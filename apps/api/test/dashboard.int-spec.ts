import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp } from './utils/create-test-app';
import { TestWorkspace, createWorkspace, injector } from './utils/workspace';

describe('dashboard and audit log', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let workspace: TestWorkspace;

  const request = injector(() => app);

  const asOwner = (payload?: object) => ({
    ...(payload === undefined ? {} : { payload }),
    token: workspace.owner.accessToken,
    organizationId: workspace.organizationId,
  });

  const dashboard = async (query = '') =>
    (await request('GET', `/api/v1/dashboard${query}`, asOwner())).json();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    workspace = await createWorkspace(app);
  });

  afterAll(async () => {
    await prisma.truncateAllTables();
    await app.close();
  });

  describe('summary', () => {
    it('answers with zeroes instead of failing on an empty organization', async () => {
      const summary = await dashboard();

      expect(summary.projects).toEqual({ active: 1, archived: 0 });
      expect(summary.requirements).toEqual({ total: 0, byStatus: {} });
      expect(summary.coverage).toEqual({ requirements: 0, covered: 0, percentage: 0 });
      expect(summary.runs.recent).toEqual([]);
    });

    it('aggregates the whole flow, from requirement to defect', async () => {
      const requirement = (
        await request(
          'POST',
          '/api/v1/requirements',
          asOwner({ projectId: workspace.projectId, title: 'The user can pay' }),
        )
      ).json();
      const suiteId = (
        await request(
          'POST',
          '/api/v1/test-suites',
          asOwner({ projectId: workspace.projectId, name: 'Checkout' }),
        )
      ).json().id;
      const testCase = (
        await request('POST', '/api/v1/test-cases', asOwner({ suiteId, title: 'Pay by card' }))
      ).json();
      await request(
        'POST',
        '/api/v1/traceability/links',
        asOwner({
          sourceType: 'requirement',
          sourceId: requirement.id,
          targetType: 'test_case',
          targetId: testCase.id,
          linkType: 'verifies',
        }),
      );

      const runId = (
        await request(
          'POST',
          '/api/v1/test-runs',
          asOwner({
            projectId: workspace.projectId,
            name: 'Release 1.0',
            selection: { testCaseIds: [testCase.id] },
          }),
        )
      ).json().id;
      const runCaseId = (
        await request('GET', `/api/v1/test-runs/${runId}/cases`, asOwner())
      ).json().data[0].id;
      await request(
        'POST',
        `/api/v1/test-runs/${runId}/cases/${runCaseId}/results`,
        asOwner({ status: 'failed' }),
      );
      await request(
        'POST',
        '/api/v1/defects',
        asOwner({
          projectId: workspace.projectId,
          title: 'Card payment fails',
          severity: 'critical',
        }),
      );

      const summary = await dashboard();

      expect(summary.requirements.total).toBe(1);
      expect(summary.testCases.total).toBe(1);
      expect(summary.results).toMatchObject({ failed: 1 });
      expect(summary.defects).toMatchObject({ open: 1, bySeverity: { critical: 1 } });
      expect(summary.coverage).toEqual({ requirements: 1, covered: 1, percentage: 100 });
      expect(summary.runs).toMatchObject({ active: 1, completed: 0 });
      expect(summary.runs.recent[0]).toMatchObject({ name: 'Release 1.0', completion: 100 });
    });

    it('scopes to one project when asked and rejects an unknown one', async () => {
      const other = (
        await request(
          'POST',
          '/api/v1/projects',
          asOwner({ name: 'Mobile app', key: 'MOB' }),
        )
      ).json();
      await request(
        'POST',
        '/api/v1/requirements',
        asOwner({ projectId: workspace.projectId, title: 'Belongs to the web project' }),
      );

      const scoped = await dashboard(`?projectId=${other.id}`);
      const missing = await request('GET', '/api/v1/dashboard?projectId=nope', asOwner());

      expect(scoped.requirements.total).toBe(0);
      expect((await dashboard()).requirements.total).toBe(1);
      expect(missing.statusCode).toBe(404);
    });

    it('counts nothing from another organization', async () => {
      await request(
        'POST',
        '/api/v1/requirements',
        asOwner({ projectId: workspace.projectId, title: 'Private requirement' }),
      );
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const theirs = await request('GET', '/api/v1/dashboard', {
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });

      expect(theirs.json().requirements.total).toBe(0);
      expect(theirs.json().projects.active).toBe(1);
    });
  });

  describe('audit log', () => {
    it('exposes the trail to an owner and hides it from everyone else', async () => {
      const lead = await workspace.addMember('qa_lead');

      const owner = await request('GET', '/api/v1/audit-log', asOwner());
      const refused = await request('GET', '/api/v1/audit-log', {
        token: lead.accessToken,
        organizationId: workspace.organizationId,
      });

      expect(owner.statusCode).toBe(200);
      expect(refused.statusCode).toBe(403);
    });

    it('filters by entity and never returns another organization entries', async () => {
      const project = (
        await request('POST', '/api/v1/projects', asOwner({ name: 'Mobile app', key: 'MOB' }))
      ).json();
      const stranger = await createWorkspace(app, { emailPrefix: 'stranger', slug: 'globex' });

      const entries = await request(
        'GET',
        `/api/v1/audit-log?entityType=Project&entityId=${project.id}`,
        asOwner(),
      );
      const theirs = await request('GET', '/api/v1/audit-log?entityType=Project', {
        token: stranger.owner.accessToken,
        organizationId: stranger.organizationId,
      });

      expect(entries.json().data).toHaveLength(1);
      expect(entries.json().data[0]).toMatchObject({
        action: 'create',
        userId: workspace.owner.userId,
      });
      expect(
        theirs.json().data.some((entry: { entityId: string }) => entry.entityId === project.id),
      ).toBe(false);
    });

    it('never exposes a password hash or a token through the changes column', async () => {
      // Changing the owner's password would revoke the session reading the log.
      const tester = await workspace.addMember('tester');
      await request('POST', '/api/v1/auth/change-password', {
        payload: { currentPassword: 'Str0ngPassword!', newPassword: 'An0therSecret!' },
        token: tester.accessToken,
        organizationId: workspace.organizationId,
      });

      const entries = await request('GET', '/api/v1/audit-log?pageSize=50', asOwner());

      const serialized = JSON.stringify(entries.json().data);
      expect(serialized).not.toContain('Str0ngPassword!');
      expect(serialized).not.toContain('An0therSecret!');
      expect(serialized).not.toMatch(/\$argon2/);
    });
  });

  /**
   * Written against raw SQL on purpose. There is no code path that edits an
   * entry, so a test going through the API would only prove that the method we
   * chose not to write does not exist. What has to be true is stronger: the
   * database refuses the write even to whoever holds the application's
   * credentials.
   */
  describe('append-only enforcement', () => {
    const entryId = async (): Promise<string> =>
      (await prisma.auditLog.findFirstOrThrow({ where: { action: 'create' } })).id;

    it('refuses to update an entry', async () => {
      const id = await entryId();

      await expect(
        prisma.$executeRawUnsafe(`UPDATE audit_logs SET summary = 'nothing happened' WHERE id = $1`, id),
      ).rejects.toThrow(/append-only/);

      const entry = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
      expect(entry.summary).not.toBe('nothing happened');
    });

    it('refuses to delete an entry, one row or the whole table', async () => {
      const id = await entryId();
      const before = await prisma.auditLog.count();

      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = $1`, id),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM audit_logs`)).rejects.toThrow(
        /append-only/,
      );
      // TRUNCATE is the cheap way to erase every trace at once and row triggers
      // do not see it, so it is checked separately.
      await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE audit_logs`)).rejects.toThrow(
        /append-only/,
      );

      expect(await prisma.auditLog.count()).toBe(before);
    });

    it('still accepts an insert', async () => {
      const before = await prisma.auditLog.count();

      await request('POST', '/api/v1/projects', asOwner({ name: 'Another one', key: 'ANO' }));

      expect(await prisma.auditLog.count()).toBe(before + 1);
    });
  });
});
