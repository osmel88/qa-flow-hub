import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../src/config/app-config.service';
import { SIGNATURE_HEADER, signWebhook } from '../src/modules/billing/webhook-signature';
import { createTestApp } from './utils/create-test-app';
import {
  TestAccount,
  TestWorkspace,
  createWorkspace,
  injector,
  registerAccount,
} from './utils/workspace';

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

/**
 * Billing end to end, with the API connected as `qaflow_app` so every billing
 * table is read and written under Row Level Security, the way production runs.
 * The database is reached as the owner only to move clocks (trial end, grace)
 * and to assert what was — or was not — written.
 */
describe('billing and subscriptions', () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let acme: TestWorkspace;
  let secret: string;

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

  const overview = async (workspace: TestWorkspace = acme) =>
    (
      await request(
        'GET',
        '/api/v1/billing',
        as(workspace.owner, undefined, workspace.organizationId),
      )
    ).json();

  const subscribe = async (
    plan: 'team' | 'business',
    outcome: 'succeeded' | 'failed' = 'succeeded',
    workspace: TestWorkspace = acme,
  ) => {
    const ctx = (payload?: object) => as(workspace.owner, payload, workspace.organizationId);
    const checkout = await request('POST', '/api/v1/billing/checkout', ctx({ plan }));
    expect(checkout.statusCode).toBe(201);
    const { sessionId } = checkout.json();
    const completed = await request(
      'POST',
      `/api/v1/billing/mock/checkout/${sessionId}/complete`,
      ctx({ outcome }),
    );
    expect(completed.statusCode).toBe(200);
    return { sessionId, overview: completed.json() };
  };

  const endPeriod = async (outcome: 'succeeded' | 'failed' = 'succeeded') =>
    request('POST', '/api/v1/billing/mock/end-period', as(acme.owner, { outcome }));

  const postWebhook = (body: string, signature?: string, provider = 'mock') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhooks/${provider}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { [SIGNATURE_HEADER]: signature }),
      },
    });

  const signed = (event: object, at = Math.floor(Date.now() / 1000)) => {
    const body = JSON.stringify(event);
    return { body, signature: signWebhook(secret, body, at) };
  };

  const subscriptionEvent = (
    externalCustomerId: string,
    overrides: Record<string, unknown> = {},
    eventOverrides: Record<string, unknown> = {},
  ) => ({
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    type: 'subscription.updated',
    createdAt: new Date().toISOString(),
    externalCustomerId,
    subscription: {
      externalSubscriptionId: `sub_test_${Math.random().toString(36).slice(2)}`,
      plan: 'business',
      status: 'active',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      cancelAtPeriodEnd: false,
      pendingPlan: null,
      pastDueSince: null,
      canceledAt: null,
      ...overrides,
    },
    ...eventOverrides,
  });

  const createProject = (key: string, workspace: TestWorkspace = acme) =>
    request(
      'POST',
      '/api/v1/projects',
      as(workspace.owner, { name: `Project ${key}`, key }, workspace.organizationId),
    );

  const invite = (email: string, workspace: TestWorkspace = acme) =>
    request(
      'POST',
      '/api/v1/organizations/current/invitations',
      as(workspace.owner, { email, role: 'tester' }, workspace.organizationId),
    );

  /** Ends the trial the way the clock would, without a job runner. */
  const expireTrial = async (organizationId: string = acme.organizationId) => {
    await owner.subscription.update({
      where: { organizationId },
      data: { trialEndsAt: new Date(Date.now() - DAY_MS) },
    });
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl() } } });
    app = await createTestApp({ databaseUrl: appRoleUrl() });
    secret = app.get(AppConfigService).billing.webhookSecret;
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

  describe('plan ownership', () => {
    it('no longer lets PATCH /organizations/current set the plan', async () => {
      const response = await request(
        'PATCH',
        '/api/v1/organizations/current',
        as(acme.owner, { plan: 'business' }),
      );
      expect(response.statusCode).toBe(400);
      const row = await owner.organization.findUniqueOrThrow({
        where: { id: acme.organizationId },
      });
      expect(row.plan).toBe('free');
    });
  });

  describe('trial', () => {
    it('starts every new organization on a 14-day Team trial', async () => {
      const view = await overview();
      expect(view.effectivePlan).toBe('team');
      expect(view.reason).toBe('trial');
      expect(view.subscription.status).toBe('trialing');
      const days = (new Date(view.subscription.trialEndsAt).getTime() - Date.now()) / DAY_MS;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThanOrEqual(14);
      expect(view.limits).toEqual({ projects: 25, members: 50, storage: 50 * GB });
      expect(view.usage).toEqual({ projects: 1, members: 1, storage: 0 });
      const cached = await owner.organization.findUniqueOrThrow({
        where: { id: acme.organizationId },
      });
      expect(cached.plan).toBe('team');
    });

    it('falls back to Free when the trial has ended, with no job runner involved', async () => {
      await expireTrial();
      const view = await overview();
      expect(view.effectivePlan).toBe('free');
      expect(view.reason).toBe('trial_expired');
      const cached = await owner.organization.findUniqueOrThrow({
        where: { id: acme.organizationId },
      });
      expect(cached.plan).toBe('free');
    });

    it('cancels a trial idempotently and records when', async () => {
      const first = await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      expect(first.statusCode).toBe(200);
      expect(first.json().effectivePlan).toBe('free');
      const canceledAt = first.json().subscription.canceledAt;
      expect(canceledAt).not.toBeNull();

      const second = await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      expect(second.statusCode).toBe(200);
      expect(second.json().subscription.canceledAt).toBe(canceledAt);
      const audits = await owner.auditLog.count({
        where: { organizationId: acme.organizationId, entityType: 'subscription' },
      });
      expect(audits).toBe(1);
    });
  });

  describe('checkout and webhooks', () => {
    it('activates a paid plan only once the provider confirms it', async () => {
      const checkout = await request(
        'POST',
        '/api/v1/billing/checkout',
        as(acme.owner, { plan: 'business' }),
      );
      expect(checkout.statusCode).toBe(201);
      expect(checkout.json().url).toContain(`/billing/checkout/${checkout.json().sessionId}`);
      // Starting a checkout changes nothing: there is no payment yet.
      expect((await overview()).effectivePlan).toBe('team');

      const session = await request(
        'GET',
        `/api/v1/billing/mock/checkout/${checkout.json().sessionId}`,
        as(acme.owner),
      );
      expect(session.json()).toMatchObject({
        plan: 'business',
        amountCents: 19900,
        status: 'open',
      });

      const completed = await request(
        'POST',
        `/api/v1/billing/mock/checkout/${checkout.json().sessionId}/complete`,
        as(acme.owner, { outcome: 'succeeded' }),
      );
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        effectivePlan: 'business',
        reason: 'active',
        subscription: { status: 'active', plan: 'business', trialEndsAt: null },
      });

      const invoices = await request('GET', '/api/v1/billing/invoices', as(acme.owner));
      expect(invoices.json().data).toHaveLength(1);
      expect(invoices.json().data[0]).toMatchObject({
        status: 'paid',
        amountPaidCents: 19900,
        plan: 'business',
      });

      const customers = await owner.billingCustomer.findMany();
      expect(customers).toHaveLength(1);
      expect(customers[0]?.organizationId).toBe(acme.organizationId);
      const events = await owner.billingWebhookEvent.findMany();
      expect(events.every((event) => event.organizationId === acme.organizationId)).toBe(true);
    });

    it('leaves a failed payment incomplete, on Free once the trial is gone', async () => {
      await expireTrial();
      const { overview: view } = await subscribe('team', 'failed');
      expect(view.subscription.status).toBe('incomplete');
      expect(view.effectivePlan).toBe('free');
      const invoices = await request('GET', '/api/v1/billing/invoices', as(acme.owner));
      expect(invoices.json().data[0].status).toBe('open');
    });

    it('refuses a second checkout while a paid subscription is live', async () => {
      await subscribe('team');
      const again = await request(
        'POST',
        '/api/v1/billing/checkout',
        as(acme.owner, { plan: 'business' }),
      );
      expect(again.statusCode).toBe(409);
    });

    it('upgrades immediately and downgrades at the end of the period', async () => {
      await subscribe('team');
      const upgraded = await request(
        'POST',
        '/api/v1/billing/plan',
        as(acme.owner, { plan: 'business' }),
      );
      expect(upgraded.statusCode).toBe(200);
      expect(upgraded.json().effectivePlan).toBe('business');

      const downgraded = await request(
        'POST',
        '/api/v1/billing/plan',
        as(acme.owner, { plan: 'team' }),
      );
      expect(downgraded.json()).toMatchObject({
        effectivePlan: 'business',
        subscription: { plan: 'business', pendingPlan: 'team' },
      });

      const renewed = await endPeriod();
      expect(renewed.json()).toMatchObject({
        effectivePlan: 'team',
        subscription: { plan: 'team', pendingPlan: null, status: 'active' },
      });
    });

    it('cancels at period end, can resume, and returns to Free when the period ends', async () => {
      await subscribe('team');
      const canceled = await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      expect(canceled.json()).toMatchObject({
        effectivePlan: 'team',
        subscription: { cancelAtPeriodEnd: true, status: 'active' },
      });
      // Idempotent: a second cancel asks the provider nothing.
      const eventsBefore = await owner.billingWebhookEvent.count();
      await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      expect(await owner.billingWebhookEvent.count()).toBe(eventsBefore);

      const resumed = await request('POST', '/api/v1/billing/resume', as(acme.owner));
      expect(resumed.json().subscription.cancelAtPeriodEnd).toBe(false);

      await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      const ended = await endPeriod();
      expect(ended.json()).toMatchObject({
        effectivePlan: 'free',
        reason: 'canceled',
        subscription: { status: 'canceled' },
      });
      expect(ended.json().subscription.canceledAt).not.toBeNull();
    });

    it('keeps the plan for 7 days past due, then falls back to Free', async () => {
      await subscribe('business');
      const failed = await endPeriod('failed');
      expect(failed.json()).toMatchObject({
        effectivePlan: 'business',
        reason: 'past_due_grace',
        subscription: { status: 'past_due' },
      });

      await owner.subscription.update({
        where: { organizationId: acme.organizationId },
        data: { pastDueSince: new Date(Date.now() - 8 * DAY_MS) },
      });
      const view = await overview();
      expect(view.effectivePlan).toBe('free');
      expect(view.reason).toBe('past_due_expired');
    });

    it('paginates invoices newest first', async () => {
      await subscribe('team');
      await endPeriod();
      await endPeriod();
      const first = await request(
        'GET',
        '/api/v1/billing/invoices?page=1&pageSize=2',
        as(acme.owner),
      );
      expect(first.json().meta).toMatchObject({ total: 3, totalPages: 2, page: 1 });
      expect(first.json().data).toHaveLength(2);
      const second = await request(
        'GET',
        '/api/v1/billing/invoices?page=2&pageSize=2',
        as(acme.owner),
      );
      expect(second.json().data).toHaveLength(1);
      const numbers = [...first.json().data, ...second.json().data].map(
        (invoice: { issuedAt: string }) => invoice.issuedAt,
      );
      expect([...numbers].sort().reverse()).toEqual(numbers);
    });

    it('applies a signed webhook once and treats a replay as a duplicate', async () => {
      await subscribe('team');
      const customer = await owner.billingCustomer.findFirstOrThrow();
      const sub = await owner.subscription.findFirstOrThrow({
        where: { organizationId: acme.organizationId },
      });
      const event = subscriptionEvent(customer.externalCustomerId, {
        externalSubscriptionId: sub.externalSubscriptionId,
        plan: 'business',
      });
      const { body, signature } = signed(event);

      const first = await postWebhook(body, signature);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ received: true, outcome: 'processed' });
      expect((await overview()).effectivePlan).toBe('business');

      const audits = await owner.auditLog.count({ where: { entityType: 'subscription' } });
      const replay = await postWebhook(body, signature);
      expect(replay.json().outcome).toBe('duplicate');
      expect(await owner.auditLog.count({ where: { entityType: 'subscription' } })).toBe(audits);
      expect(await owner.billingWebhookEvent.count({ where: { externalEventId: event.id } })).toBe(
        1,
      );

      // Concurrent duplicates: exactly one is processed.
      const concurrent = subscriptionEvent(customer.externalCustomerId, {
        externalSubscriptionId: sub.externalSubscriptionId,
        plan: 'team',
      });
      const delivery = signed(concurrent);
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => postWebhook(delivery.body, delivery.signature)),
      );
      expect(outcomes.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(outcomes.filter((response) => response.json().outcome === 'processed')).toHaveLength(
        1,
      );
    });

    it('ignores a snapshot older than the one already applied', async () => {
      await subscribe('team');
      const customer = await owner.billingCustomer.findFirstOrThrow();
      const sub = await owner.subscription.findFirstOrThrow({
        where: { organizationId: acme.organizationId },
      });
      const stale = subscriptionEvent(
        customer.externalCustomerId,
        { externalSubscriptionId: sub.externalSubscriptionId, status: 'canceled' },
        { createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      );
      const { body, signature } = signed(stale);
      expect((await postWebhook(body, signature)).json().outcome).toBe('processed');
      expect((await overview()).subscription.status).toBe('active');
    });

    it('rejects bad signatures, stale timestamps and mutated bodies without writing anything', async () => {
      await subscribe('team');
      const customer = await owner.billingCustomer.findFirstOrThrow();
      const event = subscriptionEvent(customer.externalCustomerId);
      const { body, signature } = signed(event);
      const before = {
        events: await owner.billingWebhookEvent.count(),
        audits: await owner.auditLog.count(),
        subscription: await owner.subscription.findFirstOrThrow(),
      };

      const cases = [
        postWebhook(body),
        postWebhook(body, 'garbage'),
        postWebhook(
          body,
          signWebhook('another-secret-of-sufficient-length!!', body, Math.floor(Date.now() / 1000)),
        ),
        postWebhook(body, signed(event, Math.floor(Date.now() / 1000) - 600).signature),
        postWebhook(body.replace('"business"', '"team"'), signature),
        postWebhook(`${body} `, signature),
      ];
      for (const response of await Promise.all(cases)) {
        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain('mismatch');
      }
      expect((await postWebhook(body, signature, 'stripe')).statusCode).toBe(404);
      expect((await postWebhook('', signature)).statusCode).toBe(400);

      expect(await owner.billingWebhookEvent.count()).toBe(before.events);
      expect(await owner.auditLog.count()).toBe(before.audits);
      expect(await owner.subscription.findFirstOrThrow()).toEqual(before.subscription);
    });

    it('never trusts an organization id in the payload, and ignores unknown customers', async () => {
      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      const event = {
        ...subscriptionEvent('cus_mock_nobody'),
        organizationId: globex.organizationId,
      };
      // Unknown keys are refused outright: the payload cannot name a tenant.
      const extra = signed(event);
      expect((await postWebhook(extra.body, extra.signature)).statusCode).toBe(400);

      const unknown = signed(subscriptionEvent('cus_mock_nobody'));
      const response = await postWebhook(unknown.body, unknown.signature);
      expect(response.json().outcome).toBe('ignored');
      const recorded = await owner.billingWebhookEvent.findMany();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.organizationId).toBeNull();
      expect((await overview(globex)).subscription.status).toBe('trialing');
      expect((await postWebhook(unknown.body, unknown.signature)).json().outcome).toBe('duplicate');
    });

    it('refuses a webhook that would attach another tenant’s subscription id', async () => {
      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      await subscribe('team');
      await subscribe('team', 'succeeded', globex);
      const acmeCustomer = await owner.billingCustomer.findUniqueOrThrow({
        where: { organizationId: acme.organizationId },
      });
      const globexSubscription = await owner.subscription.findUniqueOrThrow({
        where: { organizationId: globex.organizationId },
      });
      const hijack = signed(
        subscriptionEvent(acmeCustomer.externalCustomerId, {
          externalSubscriptionId: globexSubscription.externalSubscriptionId,
        }),
      );
      expect((await postWebhook(hijack.body, hijack.signature)).statusCode).toBe(400);
      expect(
        await owner.subscription.findUniqueOrThrow({
          where: { organizationId: globex.organizationId },
        }),
      ).toEqual(globexSubscription);
    });

    it('ignores webhooks for a deleted organization', async () => {
      await subscribe('team');
      const customer = await owner.billingCustomer.findFirstOrThrow();
      await owner.organization.update({
        where: { id: acme.organizationId },
        data: { deletedAt: new Date() },
      });
      const { body, signature } = signed(subscriptionEvent(customer.externalCustomerId));
      expect((await postWebhook(body, signature)).json().outcome).toBe('ignored');
    });
  });

  describe('permissions and isolation', () => {
    it('lets owners change billing, admins read it, and refuses everyone else', async () => {
      const admin = await acme.addMember('organization_admin', 'admin');
      const lead = await acme.addMember('qa_lead', 'lead');
      const viewer = await acme.addMember('viewer', 'viewer');

      expect((await request('GET', '/api/v1/billing', as(admin))).statusCode).toBe(200);
      expect((await request('GET', '/api/v1/billing/invoices', as(admin))).statusCode).toBe(200);
      for (const [method, url, payload] of [
        ['POST', '/api/v1/billing/checkout', { plan: 'team' }],
        ['POST', '/api/v1/billing/plan', { plan: 'business' }],
        ['POST', '/api/v1/billing/cancel', undefined],
        ['POST', '/api/v1/billing/resume', undefined],
        ['POST', '/api/v1/billing/mock/end-period', { outcome: 'succeeded' }],
      ] as const) {
        expect((await request(method, url, as(admin, payload))).statusCode).toBe(403);
      }
      for (const account of [lead, viewer]) {
        expect((await request('GET', '/api/v1/billing', as(account))).statusCode).toBe(403);
        expect((await request('GET', '/api/v1/billing/invoices', as(account))).statusCode).toBe(
          403,
        );
        expect((await request('POST', '/api/v1/billing/cancel', as(account))).statusCode).toBe(403);
      }
      expect((await request('GET', '/api/v1/billing')).statusCode).toBe(401);
    });

    it('never shows or touches another organization’s billing', async () => {
      const globex = await createWorkspace(app, { emailPrefix: 'globex-owner', slug: 'globex' });
      const { sessionId } = await subscribe('business');

      // Another tenant's owner, with their own header: they see their own trial only.
      const theirs = await overview(globex);
      expect(theirs.effectivePlan).toBe('team');
      const invoices = await request(
        'GET',
        '/api/v1/billing/invoices',
        as(globex.owner, undefined, globex.organizationId),
      );
      expect(invoices.json().data).toHaveLength(0);

      // A foreign checkout session is invisible, even with its id.
      await subscribe('team', 'succeeded', globex);
      const peek = await request(
        'GET',
        `/api/v1/billing/mock/checkout/${sessionId}`,
        as(globex.owner, undefined, globex.organizationId),
      );
      expect(peek.statusCode).toBe(404);

      // And the acme header is refused for a non-member.
      const foreign = await request(
        'GET',
        '/api/v1/billing',
        as(globex.owner, undefined, acme.organizationId),
      );
      expect([403, 404]).toContain(foreign.statusCode);
    });

    it('hides billing rows from the runtime role without a tenant (RLS)', async () => {
      await subscribe('team');
      const runtime = new PrismaClient({ datasources: { db: { url: appRoleUrl() } } });
      try {
        expect(await runtime.subscription.count()).toBe(0);
        expect(await runtime.invoice.count()).toBe(0);
        expect(await runtime.billingCustomer.count()).toBe(0);
        expect(await runtime.billingWebhookEvent.count()).toBe(0);
        const scoped = await runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization', ${acme.organizationId}, TRUE)`;
          return tx.invoice.count();
        });
        expect(scoped).toBe(1);
        const wrong = await runtime.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_organization', 'someone-else', TRUE)`;
          return tx.subscription.count();
        });
        expect(wrong).toBe(0);
      } finally {
        await runtime.$disconnect();
      }
    });

    it('audits every billing change', async () => {
      await subscribe('team');
      await request('POST', '/api/v1/billing/cancel', as(acme.owner));
      const entries = await owner.auditLog.findMany({
        where: { organizationId: acme.organizationId },
        select: { entityType: true },
      });
      const types = new Set(entries.map((entry) => entry.entityType));
      for (const type of ['billing_customer', 'checkout_session', 'subscription', 'invoice']) {
        expect(types.has(type)).toBe(true);
      }
    });
  });

  describe('plan limits', () => {
    it('refuses the project beyond the Free limit with 402 and keeps the existing ones', async () => {
      await expireTrial();
      expect((await createProject('P2')).statusCode).toBe(201);
      expect((await createProject('P3')).statusCode).toBe(201);
      const refused = await createProject('P4');
      expect(refused.statusCode).toBe(402);
      expect(refused.json().error).toMatchObject({
        code: 'PLAN_LIMIT_REACHED',
        details: [{ path: 'projects', message: 'limit 3, used 3, plan free' }],
      });
      expect(await owner.project.count({ where: { organizationId: acme.organizationId } })).toBe(3);
    });

    it('keeps data above the limit after a downgrade and only blocks what is new', async () => {
      for (const key of ['P2', 'P3', 'P4', 'P5']) {
        expect((await createProject(key)).statusCode).toBe(201);
      }
      await expireTrial();
      const view = await overview();
      expect(view.overLimit).toEqual(['projects']);
      const list = await request('GET', '/api/v1/projects', as(acme.owner));
      expect(list.json().meta.total).toBe(5);
      expect((await createProject('P6')).statusCode).toBe(402);
      // Not read-only: existing projects stay editable.
      const project = list.json().data[0];
      const patched = await request(
        'PATCH',
        `/api/v1/projects/${project.id}`,
        as(acme.owner, { name: 'Renamed' }),
      );
      expect(patched.statusCode).toBe(200);
    });

    it('admits exactly the remaining slots under concurrency', async () => {
      await expireTrial();
      const responses = await Promise.all(
        ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((key) => createProject(key)),
      );
      const codes = responses.map((response) => response.statusCode).sort();
      expect(codes.filter((code) => code === 201)).toHaveLength(2);
      expect(codes.filter((code) => code === 402)).toHaveLength(4);
      expect(await owner.project.count({ where: { organizationId: acme.organizationId } })).toBe(3);
    });

    it('counts pending invitations as seats, and checks again on acceptance', async () => {
      await expireTrial();
      for (let index = 1; index <= 4; index += 1) {
        expect((await invite(`seat${index}@example.test`)).statusCode).toBe(201);
      }
      const refused = await invite('seat5@example.test');
      expect(refused.statusCode).toBe(402);
      expect(refused.json().error.code).toBe('PLAN_LIMIT_REACHED');

      // Concurrent invitations at the edge: one seat left after a revoke, one wins.
      const pending = await owner.organizationInvitation.findFirstOrThrow({
        where: { email: 'seat4@example.test' },
      });
      await request(
        'DELETE',
        `/api/v1/organizations/current/invitations/${pending.id}`,
        as(acme.owner),
      );
      const burst = await Promise.all(
        ['b1', 'b2', 'b3', 'b4'].map((name) => invite(`${name}@example.test`)),
      );
      expect(burst.filter((response) => response.statusCode === 201)).toHaveLength(1);
    });

    it('refuses to accept an invitation once the seats are gone', async () => {
      // Sent on the trial (Team), accepted after it ended (Free, 5 seats).
      const tokens: string[] = [];
      for (let index = 1; index <= 6; index += 1) {
        const response = await invite(`late${index}@example.test`);
        tokens.push(response.json().token as string);
      }
      await expireTrial();
      const member = await registerAccount(app, 'late1@example.test');
      const accepted = await request('POST', '/api/v1/organizations/invitations/accept', {
        payload: { token: tokens[0] as string },
        token: member.accessToken,
      });
      expect(accepted.statusCode).toBe(402);
      const invitation = await owner.organizationInvitation.findFirstOrThrow({
        where: { email: 'late1@example.test' },
      });
      expect(invitation.status).toBe('pending');
      expect(
        await owner.organizationMember.count({ where: { organizationId: acme.organizationId } }),
      ).toBe(1);
    });

    it('refuses evidence beyond the storage limit and stores nothing', async () => {
      await expireTrial();
      const uploader = await owner.user.findFirstOrThrow({ where: { email: acme.owner.email } });
      await owner.attachmentMetadata.create({
        data: {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
          entityType: 'project',
          entityId: acme.projectId,
          fileName: 'huge.log',
          contentType: 'text/plain',
          sizeBytes: GB - 10,
          checksum: 'x'.repeat(64),
          storageProvider: 'local',
          storageKey: 'seeded/huge.log',
          uploadedById: uploader.id,
        },
      });
      const defect = await request(
        'POST',
        '/api/v1/defects',
        as(acme.owner, { projectId: acme.projectId, title: 'Checkout fails' }),
      );
      expect(defect.statusCode).toBe(201);

      const boundary = 'qa-billing-boundary';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="run.log"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from('2026-10-11 ERROR something failed with more than ten bytes\n'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/attachments?entityType=defect&entityId=${defect.json().id}`,
        payload,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${acme.owner.accessToken}`,
          'x-organization-id': acme.organizationId,
        },
      });
      expect(response.statusCode).toBe(402);
      expect(response.json().error.details[0].path).toBe('storage');
      expect(await owner.attachmentMetadata.count()).toBe(1);
    });
  });
});
