import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { MockEmailAdapter } from '../src/integrations/email-mock/email-mock.adapter';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestApp } from './utils/create-test-app';
import { TestAccount, TestWorkspace, createWorkspace, injector } from './utils/workspace';

/**
 * S3-F5: the ledger as an outbox. The first attempt happens in the request;
 * failures and rows a crash left pending are retried by `drainOutbox()`, which
 * the scheduler calls on an interval and these tests call by hand.
 */
describe('notification outbox', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let outbox: MockEmailAdapter;
  let notifications: NotificationsService;
  let asApp: PrismaClient;
  let workspace: TestWorkspace;
  let tester: TestAccount;

  const request = injector(() => app);

  const appRoleUrl = (): string => {
    const url = new URL(
      process.env['TEST_DATABASE_URL'] ??
        'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public',
    );
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });

  const transientOnce = () =>
    vi.spyOn(outbox, 'send').mockResolvedValueOnce({
      accepted: false,
      messageId: null,
      reason: 'provider_unavailable',
    });

  const assignDefect = async (
    target: TestAccount = tester,
    ws: TestWorkspace = workspace,
  ): Promise<string> => {
    const created = await request('POST', '/api/v1/defects', {
      payload: { projectId: ws.projectId, title: 'Checkout is broken', assigneeId: target.userId },
      token: ws.owner.accessToken,
      organizationId: ws.organizationId,
    });
    expect(created.statusCode).toBe(201);
    const row = await prisma.notification.findFirstOrThrow({
      where: { type: 'defect_assignment', recipientUserId: target.userId },
      orderBy: { createdAt: 'desc' },
    });
    return row.id;
  };

  const makeDue = (id: string) =>
    prisma.notification.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    outbox = app.get(MockEmailAdapter);
    notifications = app.get(NotificationsService);
    asApp = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    outbox.reset();
    workspace = await createWorkspace(app);
    tester = await workspace.addMember('tester');
    await prisma.notification.deleteMany();
    outbox.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await asApp.$disconnect();
    await app.close();
  });

  describe('retries', () => {
    it('schedules a transient failure and delivers it once it is due', async () => {
      transientOnce();
      const id = await assignDefect();

      const failed = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(failed).toMatchObject({ status: 'failed', attempts: 1, leaseUntil: null });
      expect(failed.nextAttemptAt).not.toBeNull();
      expect(failed.payload).not.toBeNull();

      // Not due yet: nothing is claimed.
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });

      await makeDue(id);
      expect(await notifications.drainOutbox()).toEqual({
        claimed: 1,
        sent: 1,
        failed: 0,
        skipped: 0,
      });
      const sent = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(sent).toMatchObject({
        status: 'sent',
        attempts: 2,
        nextAttemptAt: null,
        leaseUntil: null,
        failureReason: null,
      });
      expect(sent.payload).toBeNull();
      expect(outbox.find(id)?.subject).toContain('Checkout is broken');
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });
    });

    it('backs off exponentially and gives up after the attempt budget', async () => {
      const send = vi.spyOn(outbox, 'send').mockResolvedValue({
        accepted: false,
        messageId: null,
        reason: 'provider_unavailable',
      });
      const id = await assignDefect();
      const delays: number[] = [];
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        const before = await prisma.notification.findUniqueOrThrow({ where: { id } });
        const attemptedAt = before.attemptedAt?.getTime() ?? 0;
        delays.push((before.nextAttemptAt?.getTime() ?? 0) - attemptedAt);
        await makeDue(id);
        expect(await notifications.drainOutbox()).toMatchObject({ claimed: 1, failed: 1 });
      }
      const exhausted = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(exhausted).toMatchObject({ status: 'failed', attempts: 5, nextAttemptAt: null });
      // Kept so an operator can still retry by hand.
      expect(exhausted.payload).not.toBeNull();
      expect(send).toHaveBeenCalledTimes(5);
      // 60s, 120s, 240s, 480s (± the few ms between insert and update).
      delays.forEach((delay, index) => {
        expect(Math.round(delay / 60_000)).toBe(2 ** index);
      });
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });
    });

    it('never retries a hard bounce', async () => {
      vi.spyOn(outbox, 'send').mockResolvedValueOnce({
        accepted: false,
        messageId: null,
        reason: 'mailbox_unavailable',
      });
      const id = await assignDefect();
      expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'failed',
        nextAttemptAt: null,
      });
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });
    });

    it('gives up on a stored payload that no longer matches its template', async () => {
      transientOnce();
      const id = await assignDefect();
      await prisma.notification.update({
        where: { id },
        data: { payload: { assigneeName: 'T' }, nextAttemptAt: new Date(Date.now() - 1000) },
      });
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 1, failed: 1 });
      expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'failed',
        failureReason: 'payload_unreadable',
        nextAttemptAt: null,
      });
      expect(outbox.all()).toHaveLength(0);
    });

    it('recovers a row a crash left pending once its lease expires, but not before', async () => {
      const id = await assignDefect();
      await prisma.notification.update({
        where: { id },
        data: {
          status: 'pending',
          attempts: 0,
          payload: {
            assigneeName: 'T',
            assignedByName: 'O',
            organizationName: 'Org',
            projectName: 'P',
            defectTitle: 'D',
            severity: 'major',
            defectUrl: 'http://x/defects',
          },
          leaseUntil: new Date(Date.now() + 60_000),
        },
      });
      outbox.reset();
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });

      await prisma.notification.update({
        where: { id },
        data: { leaseUntil: new Date(Date.now() - 1000) },
      });
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 1, sent: 1 });
      expect(outbox.all()).toHaveLength(1);
    });

    it('delivers each due row exactly once when two passes run concurrently', async () => {
      const others: TestAccount[] = [];
      for (let i = 0; i < 4; i += 1) others.push(await workspace.addMember('tester', `t${i}`));
      await prisma.notification.deleteMany();
      vi.spyOn(outbox, 'send').mockResolvedValue({
        accepted: false,
        messageId: null,
        reason: 'provider_unavailable',
      });
      const ids: string[] = [];
      for (const account of others) ids.push(await assignDefect(account));
      vi.restoreAllMocks();
      outbox.reset();
      await prisma.notification.updateMany({
        where: { id: { in: ids } },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      const [a, b] = await Promise.all([notifications.drainOutbox(), notifications.drainOutbox()]);
      expect(a.claimed + b.claimed).toBe(4);
      expect(a.sent + b.sent).toBe(4);
      expect(outbox.all()).toHaveLength(4);
      const rows = await prisma.notification.findMany({ where: { id: { in: ids } } });
      expect(rows.every((row) => row.status === 'sent' && row.attempts === 2)).toBe(true);
    });

    it('clears the stored payload once an invitation is delivered', async () => {
      const invited = await request(
        'POST',
        '/api/v1/organizations/current/invitations',
        as(workspace.owner, { email: 'newcomer@example.test', role: 'viewer' }),
      );
      expect(invited.statusCode).toBe(201);
      const row = await prisma.notification.findFirstOrThrow({
        where: { type: 'organization_invitation' },
      });
      expect(row.status).toBe('sent');
      expect(row.payload).toBeNull();
      expect(JSON.stringify(row)).not.toContain(invited.json().token);
    });

    it('re-renders a failed invitation with its dates intact', async () => {
      transientOnce();
      await request(
        'POST',
        '/api/v1/organizations/current/invitations',
        as(workspace.owner, { email: 'retry@example.test', role: 'viewer' }),
      );
      const row = await prisma.notification.findFirstOrThrow({
        where: { type: 'organization_invitation' },
      });
      expect(row.status).toBe('failed');
      await makeDue(row.id);
      expect(await notifications.drainOutbox()).toMatchObject({ sent: 1 });
      expect(outbox.find(row.id)?.text).toMatch(/expires on \w+/);
      expect(outbox.find(row.id)?.text).not.toContain('Invalid Date');
    });
  });

  describe('access is re-checked at send time', () => {
    it('skips a retry for a recipient whose project grant was revoked', async () => {
      transientOnce();
      const id = await assignDefect();
      const revoked = await request(
        'DELETE',
        `/api/v1/projects/${workspace.projectId}/members/${tester.userId}`,
        as(workspace.owner),
      );
      expect(revoked.statusCode).toBe(204);
      await makeDue(id);
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 1, skipped: 1 });
      const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'skipped', skipReason: 'recipient_no_access' });
      expect(row.payload).toBeNull();
      expect(outbox.all()).toHaveLength(0);
    });

    it('skips a retry for a recipient who left the organization', async () => {
      transientOnce();
      const id = await assignDefect();
      const removed = await request(
        'DELETE',
        `/api/v1/organizations/current/members/${tester.userId}`,
        as(workspace.owner),
      );
      expect([200, 204]).toContain(removed.statusCode);
      await makeDue(id);
      await notifications.drainOutbox();
      expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'skipped',
        skipReason: 'recipient_no_access',
      });
      expect(outbox.all()).toHaveLength(0);
    });

    it('skips a retry when the recipient muted the category in the meantime', async () => {
      transientOnce();
      const id = await assignDefect();
      await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { defectAssignments: false },
        token: tester.accessToken,
      });
      await makeDue(id);
      await notifications.drainOutbox();
      expect(await prisma.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'skipped',
        skipReason: 'category_disabled',
      });
    });

    it('does not claim rows of a deleted organization', async () => {
      transientOnce();
      const id = await assignDefect();
      await makeDue(id);
      await prisma.organization.update({
        where: { id: workspace.organizationId },
        data: { deletedAt: new Date() },
      });
      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 0 });
    });
  });

  describe('tenancy', () => {
    it('delivers each tenant row inside its own organization', async () => {
      const beta = await createWorkspace(app, {
        emailPrefix: 'beta',
        slug: 'beta',
        projectKey: 'BET',
      });
      const betaTester = await beta.addMember('tester', 'beta-tester');
      await prisma.notification.deleteMany();
      vi.spyOn(outbox, 'send').mockResolvedValue({
        accepted: false,
        messageId: null,
        reason: 'provider_unavailable',
      });
      const alphaId = await assignDefect(tester, workspace);
      const betaId = await assignDefect(betaTester, beta);
      vi.restoreAllMocks();
      await prisma.notification.updateMany({
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

      expect(await notifications.drainOutbox()).toMatchObject({ claimed: 2, sent: 2 });
      const rows = await prisma.notification.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows.map((row) => [row.id, row.organizationId, row.status])).toEqual([
        [alphaId, workspace.organizationId, 'sent'],
        [betaId, beta.organizationId, 'sent'],
      ]);
      expect(outbox.find(alphaId)?.tags['organizationId']).toBe(workspace.organizationId);
      expect(outbox.find(betaId)?.tags['organizationId']).toBe(beta.organizationId);
    });

    it('lets the runtime role claim through the function only, and RLS still hides other tenants', async () => {
      const beta = await createWorkspace(app, {
        emailPrefix: 'beta',
        slug: 'beta',
        projectKey: 'BET',
      });
      const betaTester = await beta.addMember('tester', 'beta-tester');
      await prisma.notification.deleteMany();
      transientOnce();
      const betaId = await assignDefect(betaTester, beta);

      const visibleToAlpha = await asApp.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_organization', ${workspace.organizationId}, TRUE)`;
        return tx.notification.findMany({ where: { id: betaId } });
      });
      expect(visibleToAlpha).toHaveLength(0);

      await makeDue(betaId);
      const claimed = await asApp.$queryRaw<Array<Record<string, unknown>>>`
        SELECT * FROM claim_notification_deliveries(10, 60)`;
      expect(claimed).toEqual([{ id: betaId, organizationId: beta.organizationId }]);
      // Leased: a second claim gets nothing until the lease expires.
      expect(await asApp.$queryRaw`SELECT * FROM claim_notification_deliveries(10, 60)`).toEqual(
        [],
      );
    });
  });

  describe('manual retry', () => {
    it('lets an owner retry a failed row now, and audits it', async () => {
      transientOnce();
      const id = await assignDefect();
      const retried = await request(
        'POST',
        `/api/v1/notifications/${id}/retry`,
        as(workspace.owner),
      );
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({
        id,
        status: 'sent',
        attempts: 2,
        nextAttemptAt: null,
      });
      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'notification', entityId: id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.organizationId).toBe(workspace.organizationId);

      const again = await request('POST', `/api/v1/notifications/${id}/retry`, as(workspace.owner));
      expect(again.statusCode).toBe(409);
    });

    it('refuses a retry while a worker holds the lease', async () => {
      transientOnce();
      const id = await assignDefect();
      await prisma.notification.update({
        where: { id },
        data: { leaseUntil: new Date(Date.now() + 60_000) },
      });
      const retried = await request(
        'POST',
        `/api/v1/notifications/${id}/retry`,
        as(workspace.owner),
      );
      expect(retried.statusCode).toBe(409);
      expect(outbox.all()).toHaveLength(0);
    });

    it('is forbidden below admin and answers 404 for another tenant or an unknown id', async () => {
      transientOnce();
      const id = await assignDefect();
      const asTester = await request('POST', `/api/v1/notifications/${id}/retry`, as(tester));
      expect(asTester.statusCode).toBe(403);

      const beta = await createWorkspace(app, {
        emailPrefix: 'beta',
        slug: 'beta',
        projectKey: 'BET',
      });
      const crossTenant = await request('POST', `/api/v1/notifications/${id}/retry`, {
        token: beta.owner.accessToken,
        organizationId: beta.organizationId,
      });
      const unknown = await request('POST', '/api/v1/notifications/does-not-exist/retry', {
        token: beta.owner.accessToken,
        organizationId: beta.organizationId,
      });
      expect(crossTenant.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(crossTenant.json().message).toBe(unknown.json().message);
      // The owner of alpha cannot reach it through beta's header either.
      const wrongHeader = await request('POST', `/api/v1/notifications/${id}/retry`, {
        token: workspace.owner.accessToken,
        organizationId: beta.organizationId,
      });
      expect(wrongHeader.statusCode).toBe(403);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).status).toBe(
        'failed',
      );
    });

    it('exposes nextAttemptAt in the organization ledger', async () => {
      transientOnce();
      const id = await assignDefect();
      const ledger = await request(
        'GET',
        '/api/v1/notifications?scope=organization&status=failed',
        as(workspace.owner),
      );
      expect(ledger.statusCode).toBe(200);
      const view = ledger.json().data.find((item: { id: string }) => item.id === id);
      expect(view.nextAttemptAt).not.toBeNull();
      expect(view).not.toHaveProperty('payload');
    });
  });

  describe('test run completed with failures', () => {
    const setupRun = async (statuses: string[], assignee: TestAccount | null) => {
      const suite = await request(
        'POST',
        '/api/v1/test-suites',
        as(workspace.owner, { projectId: workspace.projectId, name: 'Checkout' }),
      );
      const caseIds: string[] = [];
      for (let i = 0; i < statuses.length; i += 1) {
        const created = await request(
          'POST',
          '/api/v1/test-cases',
          as(workspace.owner, { suiteId: suite.json().id, title: `Case ${i}` }),
        );
        caseIds.push(created.json().id);
      }
      const run = await request(
        'POST',
        '/api/v1/test-runs',
        as(workspace.owner, {
          projectId: workspace.projectId,
          name: 'Nightly',
          selection: { testCaseIds: caseIds },
        }),
      );
      const runId: string = run.json().id;
      const cases = (await request('GET', `/api/v1/test-runs/${runId}/cases`, as(workspace.owner)))
        .json()
        .data.map((item: { id: string }) => item.id);
      if (assignee !== null) {
        await request(
          'POST',
          `/api/v1/test-runs/${runId}/assignments`,
          as(workspace.owner, { runCaseIds: cases, assignedToId: assignee.userId }),
        );
      }
      for (let i = 0; i < statuses.length; i += 1) {
        const recorded = await request(
          'POST',
          `/api/v1/test-runs/${runId}/cases/${cases[i]}/results`,
          as(workspace.owner, { status: statuses[i] }),
        );
        expect(recorded.statusCode).toBe(201);
      }
      await prisma.notification.deleteMany();
      outbox.reset();
      return runId;
    };

    it('tells the owners of failed cases, not the actor', async () => {
      const runId = await setupRun(['failed', 'blocked', 'passed'], tester);
      const completed = await request(
        'POST',
        `/api/v1/test-runs/${runId}/complete`,
        as(workspace.owner),
      );
      expect(completed.statusCode).toBe(200);
      const rows = await prisma.notification.findMany({ where: { type: 'test_run_failed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        recipientUserId: tester.userId,
        status: 'sent',
        templateKey: 'test_run_failed.v1',
        organizationId: workspace.organizationId,
      });
      const captured = outbox.find(rows[0]?.id ?? '');
      expect(captured?.subject).toContain('completed with 1 failed case');
      expect(captured?.text).toContain('1 of 3 cases failed, 1 blocked');
    });

    it('sends nothing for a run without failures', async () => {
      const runId = await setupRun(['passed', 'blocked'], tester);
      await request('POST', `/api/v1/test-runs/${runId}/complete`, as(workspace.owner));
      expect(await prisma.notification.count({ where: { type: 'test_run_failed' } })).toBe(0);
    });

    it('respects the status-changes preference', async () => {
      const runId = await setupRun(['failed'], tester);
      await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { statusChanges: false },
        token: tester.accessToken,
      });
      await request('POST', `/api/v1/test-runs/${runId}/complete`, as(workspace.owner));
      expect(
        await prisma.notification.findFirstOrThrow({ where: { type: 'test_run_failed' } }),
      ).toMatchObject({ status: 'skipped', skipReason: 'category_disabled' });
    });

    it('does not announce a run to an assignee who lost the project before completion', async () => {
      const runId = await setupRun(['failed'], tester);
      await request(
        'DELETE',
        `/api/v1/projects/${workspace.projectId}/members/${tester.userId}`,
        as(workspace.owner),
      );
      await request('POST', `/api/v1/test-runs/${runId}/complete`, as(workspace.owner));
      expect(
        await prisma.notification.findFirstOrThrow({ where: { type: 'test_run_failed' } }),
      ).toMatchObject({ status: 'skipped', skipReason: 'recipient_no_access' });
      expect(outbox.all()).toHaveLength(0);
    });
  });
});
