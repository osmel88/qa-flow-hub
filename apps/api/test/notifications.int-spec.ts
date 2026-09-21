import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { NotificationView } from '@qa-flow-hub/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service';
import { MockEmailAdapter } from '../src/integrations/email-mock/email-mock.adapter';
import { createTestApp } from './utils/create-test-app';
import {
  TestAccount,
  TestWorkspace,
  createWorkspace,
  injector,
  registerAccount,
} from './utils/workspace';

/**
 * The pipeline under test: business endpoint → domain event → notifications
 * listener → preference decision → ledger row → mock provider → status.
 *
 * Nothing here reaches into the service. Every assertion is made through the
 * HTTP API or the database, because "an email was generated" is only worth
 * anything if the product can show it.
 */
describe('email notifications', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let outbox: MockEmailAdapter;
  let workspace: TestWorkspace;
  let tester: TestAccount;
  let asApp: PrismaClient;

  const request = injector(() => app);

  /** Same database, connected as the non-owning runtime role (see rls.int-spec). */
  const appRoleUrl = (): string => {
    const url = new URL(
      process.env['TEST_DATABASE_URL'] ??
        'postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public',
    );
    url.username = 'qaflow_app';
    url.password = process.env['TEST_APP_DATABASE_PASSWORD'] ?? 'qaflow_app_test';
    return url.toString();
  };

  const asOrganization = async <T>(
    organizationId: string | null,
    work: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> =>
    asApp.$transaction(async (tx) => {
      if (organizationId !== null) {
        await tx.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`;
      }
      return work(tx as unknown as PrismaClient);
    });

  const as = (account: TestAccount, payload?: object, organizationId?: string) => ({
    ...(payload === undefined ? {} : { payload }),
    token: account.accessToken,
    organizationId: organizationId ?? workspace.organizationId,
  });

  const ledger = async (
    account: TestAccount,
    query = '',
    organizationId?: string,
  ): Promise<NotificationView[]> => {
    const response = await request(
      'GET',
      `/api/v1/notifications${query}`,
      as(account, undefined, organizationId),
    );
    expect(response.statusCode).toBe(200);
    return response.json().data;
  };

  const nth = <T>(list: readonly T[], index: number): T => {
    const item = list[index];
    if (item === undefined) {
      throw new Error(`Expected element ${index} in a list of ${list.length}`);
    }
    return item;
  };

  const rows = (where: object = {}) =>
    prisma.notification.findMany({ where, orderBy: { createdAt: 'asc' } });

  const createRun = async (caseIds: string[]): Promise<{ runId: string; runCaseIds: string[] }> => {
    const run = await request(
      'POST',
      '/api/v1/test-runs',
      as(workspace.owner, {
        projectId: workspace.projectId,
        name: 'Regression',
        selection: { testCaseIds: caseIds },
      }),
    );
    expect(run.statusCode).toBe(201);
    const runId = run.json().id;
    const cases = await request('GET', `/api/v1/test-runs/${runId}/cases`, as(workspace.owner));
    return { runId, runCaseIds: cases.json().data.map((c: { id: string }) => c.id) };
  };

  const createCases = async (count: number): Promise<string[]> => {
    const suite = await request(
      'POST',
      '/api/v1/test-suites',
      as(workspace.owner, { projectId: workspace.projectId, name: 'Checkout' }),
    );
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const created = await request(
        'POST',
        '/api/v1/test-cases',
        as(workspace.owner, { suiteId: suite.json().id, title: `Case ${i + 1}` }),
      );
      ids.push(created.json().id);
    }
    return ids;
  };

  const assign = (runId: string, runCaseIds: string[], assignedToId: string | null) =>
    request(
      'POST',
      `/api/v1/test-runs/${runId}/assignments`,
      as(workspace.owner, { runCaseIds, assignedToId }),
    );

  const createDefect = (payload: object = {}, actor: TestAccount = workspace.owner) =>
    request(
      'POST',
      '/api/v1/defects',
      as(actor, {
        projectId: workspace.projectId,
        title: 'Payment button does nothing',
        ...payload,
      }),
    );

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    outbox = app.get(MockEmailAdapter);
    asApp = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
  });

  beforeEach(async () => {
    await prisma.truncateAllTables();
    outbox.reset();
    workspace = await createWorkspace(app);
    tester = await workspace.addMember('tester');
    // Inviting the tester already produced a mail; the tests start from zero.
    await prisma.notification.deleteMany();
    outbox.reset();
  });

  afterAll(async () => {
    await asApp.$disconnect();
    await app.close();
  });

  // --- Invitations -----------------------------------------------------------

  describe('organization invitation', () => {
    it('generates one sent email per issue and per resend, addressed to the invitee', async () => {
      const invited = await request(
        'POST',
        '/api/v1/organizations/current/invitations',
        as(workspace.owner, { email: 'newcomer@example.test', role: 'qa_lead' }),
      );
      expect(invited.statusCode).toBe(201);

      const issued = await rows({ type: 'organization_invitation' });
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({
        organizationId: workspace.organizationId,
        recipientEmail: 'newcomer@example.test',
        recipientUserId: null,
        status: 'sent',
        provider: 'mock',
        attempts: 1,
        templateKey: 'organization_invitation.v1',
      });
      expect(nth(issued, 0).deliveredAt).not.toBeNull();

      const captured = outbox.find(nth(issued, 0).id);
      expect(captured).not.toBeNull();
      expect(captured?.to).toBe('newcomer@example.test');
      expect(captured?.subject).toContain('Org acme');
      expect(captured?.text).toContain(invited.json().token);

      const resent = await request(
        'POST',
        `/api/v1/organizations/current/invitations/${invited.json().id}/resend`,
        as(workspace.owner),
      );
      expect(resent.statusCode).toBe(200);
      expect(await rows({ type: 'organization_invitation' })).toHaveLength(2);
      expect(outbox.all()).toHaveLength(2);
    });

    it('never records the invitation token in the ledger and redacts it from the outbox', async () => {
      const invited = await request(
        'POST',
        '/api/v1/organizations/current/invitations',
        as(workspace.owner, { email: 'newcomer@example.test', role: 'tester' }),
      );
      const token: string = invited.json().token;

      const row = nth(await rows({ type: 'organization_invitation' }), 0);
      expect(JSON.stringify(row)).not.toContain(token);

      const list = await request(
        'GET',
        '/api/v1/notifications?scope=organization',
        as(workspace.owner),
      );
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(token);
      expect(list.json().data[0].metadata).toEqual({
        entityType: 'organization_invitation',
        entityId: invited.json().id,
        role: 'tester',
        resendCount: '0',
        actorUserId: workspace.owner.userId,
      });

      const inspected = await request('GET', '/api/v1/notifications/outbox', as(workspace.owner));
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json().data).toHaveLength(1);
      expect(inspected.body).not.toContain(token);
      expect(inspected.json().data[0].text).toContain('?[redacted]');
    });
  });

  // --- Password changed -----------------------------------------------------

  describe('password changed', () => {
    it('is sent even when the user disabled email, and is not tied to an organization', async () => {
      const disabled = await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { emailEnabled: false },
        token: tester.accessToken,
      });
      expect(disabled.statusCode).toBe(200);

      const changed = await request('POST', '/api/v1/auth/change-password', {
        payload: { currentPassword: 'Str0ngPassword!', newPassword: 'An0therPassword!' },
        token: tester.accessToken,
      });
      expect(changed.statusCode).toBe(204);

      const row = nth(await rows({ type: 'password_changed' }), 0);
      expect(row).toMatchObject({
        organizationId: null,
        recipientUserId: tester.userId,
        recipientEmail: tester.email,
        status: 'sent',
      });
      expect(outbox.find(row.id)?.text).toContain('changed');
      expect(outbox.find(row.id)?.text).not.toContain('An0therPassword!');
    });
  });

  // --- Test run assignment ---------------------------------------------------

  describe('test run assignment', () => {
    it('emails the assignee once for the batch, with the case count, and not the actor', async () => {
      const caseIds = await createCases(2);
      const { runId, runCaseIds } = await createRun(caseIds);

      expect((await assign(runId, runCaseIds, tester.userId)).statusCode).toBe(200);

      const sent = await rows({ type: 'test_run_assignment' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        recipientUserId: tester.userId,
        status: 'sent',
        metadata: expect.objectContaining({ entityId: runId, assignedCases: '2' }),
      });
      expect(outbox.find(nth(sent, 0).id)?.text).toContain('2 test cases');

      // The owner assigning cases to themself is not news to them.
      expect((await assign(runId, runCaseIds, workspace.owner.userId)).statusCode).toBe(200);
      expect(await rows({ type: 'test_run_assignment' })).toHaveLength(1);
    });

    it('does not repeat the email when the same cases are assigned to the same person again', async () => {
      const caseIds = await createCases(2);
      const { runId, runCaseIds } = await createRun(caseIds);

      await assign(runId, runCaseIds, tester.userId);
      await assign(runId, [...runCaseIds].reverse(), tester.userId);
      expect(await rows({ type: 'test_run_assignment' })).toHaveLength(1);
      expect(outbox.all()).toHaveLength(1);

      // A different set of cases is a different fact.
      await assign(runId, [nth(runCaseIds, 0)], tester.userId);
      expect(await rows({ type: 'test_run_assignment' })).toHaveLength(2);
    });

    it('records a skipped row instead of sending when the category is disabled', async () => {
      await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { testRunAssignments: false },
        token: tester.accessToken,
      });
      const { runId, runCaseIds } = await createRun(await createCases(1));
      await assign(runId, runCaseIds, tester.userId);

      const row = nth(await rows({ type: 'test_run_assignment' }), 0);
      expect(row).toMatchObject({
        status: 'skipped',
        skipReason: 'category_disabled',
        attempts: 0,
      });
      expect(outbox.all()).toHaveLength(0);

      const mine = await ledger(tester);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ status: 'skipped', skipReason: 'category_disabled' });
    });

    it('skips every optional email when email is globally disabled', async () => {
      await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { emailEnabled: false },
        token: tester.accessToken,
      });
      const { runId, runCaseIds } = await createRun(await createCases(1));
      await assign(runId, runCaseIds, tester.userId);
      await createDefect({ assigneeId: tester.userId, severity: 'major', priority: 'high' });

      const skipped = await rows({ status: 'skipped' });
      expect(skipped.map((row) => [row.type, row.skipReason])).toEqual([
        ['test_run_assignment', 'email_disabled'],
        ['defect_assignment', 'email_disabled'],
      ]);
    });
  });

  // --- Defects ---------------------------------------------------------------

  describe('defect assignment and status', () => {
    it('emails the assignee on creation and on a change of hands, not on an unrelated edit', async () => {
      const created = await createDefect({
        assigneeId: tester.userId,
        severity: 'major',
        priority: 'high',
      });
      expect(created.statusCode).toBe(201);
      const defectId = created.json().id;

      let assigned = await rows({ type: 'defect_assignment' });
      expect(assigned).toHaveLength(1);
      expect(assigned[0]).toMatchObject({ recipientUserId: tester.userId, status: 'sent' });
      expect(outbox.find(nth(assigned, 0).id)?.subject).toContain(created.json().key);

      await request(
        'PATCH',
        `/api/v1/defects/${defectId}`,
        as(workspace.owner, { title: 'Payment button does nothing on Safari' }),
      );
      expect(await rows({ type: 'defect_assignment' })).toHaveLength(1);

      const lead = await workspace.addMember('qa_lead');
      const handed = await request(
        'PATCH',
        `/api/v1/defects/${defectId}`,
        as(workspace.owner, { assigneeId: lead.userId }),
      );
      expect(handed.statusCode).toBe(200);
      assigned = await rows({ type: 'defect_assignment' });
      expect(assigned).toHaveLength(2);
      expect(nth(assigned, 1).recipientUserId).toBe(lead.userId);
    });

    it('tells the assignee and the reporter about important transitions only, never the actor', async () => {
      const created = await createDefect({
        assigneeId: tester.userId,
        severity: 'major',
        priority: 'high',
      });
      const defectId = created.json().id;
      const move = (status: string, actor: TestAccount) =>
        request('POST', `/api/v1/defects/${defectId}/status`, as(actor, { status }));

      expect((await move('triaged', workspace.owner)).statusCode).toBe(200);
      expect((await move('in_progress', workspace.owner)).statusCode).toBe(200);
      expect(await rows({ type: 'defect_status_changed' })).toHaveLength(0);

      // The tester resolves it: the reporter (owner) hears, the tester does not.
      expect((await move('resolved', tester)).statusCode).toBe(200);
      let changed = await rows({ type: 'defect_status_changed' });
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        recipientUserId: workspace.owner.userId,
        status: 'sent',
        metadata: expect.objectContaining({ fromStatus: 'in_progress', toStatus: 'resolved' }),
      });

      // The owner reopens it: now the tester hears, the owner does not.
      expect((await move('reopened', workspace.owner)).statusCode).toBe(200);
      changed = await rows({ type: 'defect_status_changed' });
      expect(changed).toHaveLength(2);
      expect(nth(changed, 1).recipientUserId).toBe(tester.userId);
    });
  });

  // --- Provider failure -------------------------------------------------------

  describe('simulated provider failure', () => {
    it('marks the row failed with the provider reason and never fails the business request', async () => {
      const bouncing = await registerAccount(app, 'flaky+bounce@example.test');
      const invitation = await request(
        'POST',
        '/api/v1/organizations/current/invitations',
        as(workspace.owner, { email: bouncing.email, role: 'tester' }),
      );
      expect(invitation.statusCode).toBe(201);
      await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: invitation.json().token },
        token: bouncing.accessToken,
      });

      const invitationRow = nth(await rows({ type: 'organization_invitation' }), 0);
      expect(invitationRow).toMatchObject({
        status: 'failed',
        failureReason: 'mailbox_unavailable',
        provider: 'mock',
        attempts: 1,
      });
      expect(invitationRow.attemptedAt).not.toBeNull();
      expect(invitationRow.deliveredAt).toBeNull();
      expect(outbox.find(invitationRow.id)).toBeNull();

      // Failed messages are in the ledger for operators, but not in the outbox.
      const failed = await ledger(workspace.owner, '?scope=organization&status=failed');
      expect(failed).toHaveLength(1);
      expect(nth(failed, 0).failureReason).toBe('mailbox_unavailable');
    });
  });

  // --- Isolation and access ----------------------------------------------------

  describe('isolation', () => {
    it('never shows another organization its notifications, in the ledger or the outbox', async () => {
      const { runId, runCaseIds } = await createRun(await createCases(1));
      await assign(runId, runCaseIds, tester.userId);

      const other = await createWorkspace(app, { emailPrefix: 'rival', slug: 'rival' });
      expect(await ledger(other.owner, '?scope=organization', other.organizationId)).toEqual([]);
      const outboxOfOther = await request(
        'GET',
        '/api/v1/notifications/outbox',
        as(other.owner, undefined, other.organizationId),
      );
      expect(outboxOfOther.json().data).toEqual([]);

      // Row-level security agrees with the filters: as the runtime role, the
      // other tenant sees nothing even without a where clause, and account
      // level rows (no organization) are hidden from every tenant.
      await request('POST', '/api/v1/auth/change-password', {
        payload: { currentPassword: 'Str0ngPassword!', newPassword: 'An0therPassword!' },
        token: tester.accessToken,
      });
      expect(await asOrganization(other.organizationId, (tx) => tx.notification.count())).toBe(0);
      expect(await asOrganization(workspace.organizationId, (tx) => tx.notification.count())).toBe(
        1,
      );
      expect(await asOrganization(null, (tx) => tx.notification.count())).toBe(1);
      expect(await ledger(workspace.owner, '?scope=organization')).toHaveLength(1);
    });

    it('lets a member see only what was addressed to them', async () => {
      const lead = await workspace.addMember('qa_lead');
      const { runId, runCaseIds } = await createRun(await createCases(2));
      await assign(runId, [nth(runCaseIds, 0)], tester.userId);
      await assign(runId, [nth(runCaseIds, 1)], lead.userId);

      const mine = await ledger(tester);
      expect(mine).toHaveLength(1);
      expect(nth(mine, 0).recipientUserId).toBe(tester.userId);

      const everything = await request(
        'GET',
        '/api/v1/notifications?scope=organization',
        as(tester),
      );
      expect(everything.statusCode).toBe(403);
      expect((await request('GET', '/api/v1/notifications/outbox', as(tester))).statusCode).toBe(
        403,
      );

      // Both assignments plus the lead's own invitation mail.
      expect(await ledger(workspace.owner, '?scope=organization')).toHaveLength(3);
      expect(
        await ledger(workspace.owner, '?scope=organization&type=test_run_assignment'),
      ).toHaveLength(2);
    });
  });

  // --- Preferences and provider info --------------------------------------------

  describe('preferences', () => {
    it('default to everything on, persist per user across organizations and are audited', async () => {
      const defaults = await request('GET', '/api/v1/notifications/preferences', {
        token: tester.accessToken,
      });
      expect(defaults.json()).toEqual({
        emailEnabled: true,
        testRunAssignments: true,
        defectAssignments: true,
        statusChanges: true,
        updatedAt: null,
      });

      const updated = await request('PATCH', '/api/v1/notifications/preferences', {
        payload: { statusChanges: false },
        token: tester.accessToken,
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ statusChanges: false, emailEnabled: true });
      expect(updated.json().updatedAt).not.toBeNull();

      const rejected = await request('PATCH', '/api/v1/notifications/preferences', {
        payload: {},
        token: tester.accessToken,
      });
      expect(rejected.statusCode).toBe(400);

      const audit = await prisma.auditLog.findMany({
        where: { entityType: 'notification_preference', entityId: tester.userId },
      });
      expect(audit).toHaveLength(1);
      expect(nth(audit, 0).changes).toEqual({ statusChanges: { from: true, to: false } });
    });

    it('describes the provider as an inspectable mock', async () => {
      const provider = await request('GET', '/api/v1/notifications/provider', as(tester));
      expect(provider.json()).toEqual({
        provider: 'mock',
        mode: 'mock',
        inspectable: true,
        fromAddress: expect.stringContaining('@'),
      });
    });
  });
});
