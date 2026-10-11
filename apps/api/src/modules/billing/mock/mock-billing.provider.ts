import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  INVOICE_STATUSES,
  ORGANIZATION_PLANS,
  PAID_PLANS,
  PLAN_CATALOG,
  PaidPlanName,
  SUBSCRIPTION_STATUSES,
} from '@qa-flow-hub/shared';
import { z } from 'zod';
import { AppConfigService } from '../../../config/app-config.service';
import {
  ConflictError,
  IntegrationProviderError,
  InvalidWebhookError,
  NotFoundError,
} from '../../../errors';
import {
  BillingEvent,
  BillingProvider,
  ProviderInvoiceSnapshot,
  WebhookDelivery,
} from '../billing-provider';
import { SIGNATURE_HEADER, signWebhook, verifyWebhookSignature } from '../webhook-signature';
import { MockBillingStore, MockCheckoutSession, MockSubscription } from './mock-billing.store';

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const PROVIDER = 'billing-mock';

const isoOrNull = z.string().datetime().nullable();

const subscriptionSnapshot = z
  .object({
    externalSubscriptionId: z.string().min(1).max(200),
    plan: z.enum(PAID_PLANS),
    status: z.enum(SUBSCRIPTION_STATUSES),
    currentPeriodStart: isoOrNull,
    currentPeriodEnd: isoOrNull,
    cancelAtPeriodEnd: z.boolean(),
    pendingPlan: z.enum(PAID_PLANS).nullable(),
    pastDueSince: isoOrNull,
    canceledAt: isoOrNull,
  })
  .strict();

const invoiceSnapshot = z
  .object({
    externalInvoiceId: z.string().min(1).max(200),
    number: z.string().min(1).max(100),
    status: z.enum(INVOICE_STATUSES),
    plan: z.enum(ORGANIZATION_PLANS).nullable(),
    amountDueCents: z.number().int().min(0),
    amountPaidCents: z.number().int().min(0),
    currency: z.string().length(3),
    periodStart: isoOrNull,
    periodEnd: isoOrNull,
    hostedUrl: z.string().url().nullable(),
    issuedAt: z.string().datetime(),
  })
  .strict();

const base = {
  id: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  externalCustomerId: z.string().min(1).max(200),
};

const eventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('subscription.updated'),
      subscription: subscriptionSnapshot,
    })
    .strict(),
  z.object({ ...base, type: z.literal('invoice.updated'), invoice: invoiceSnapshot }).strict(),
]);

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * A billing provider that never leaves the process, for development, CI and
 * E2E. It keeps the parts that matter for correctness honest: it owns the
 * subscription state, it only ever reports changes as HMAC-signed webhooks,
 * and those webhooks go through the very same verification as a real one.
 *
 * Beyond the port it offers three simulation hooks — read a checkout session,
 * pay or fail it, and end the current period — exposed by the billing module
 * only while this provider is selected, which production refuses.
 */
@Injectable()
export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock' as const;

  constructor(
    private readonly store: MockBillingStore,
    private readonly config: AppConfigService,
  ) {}

  createCustomer(input: {
    organizationId: string;
    email: string;
    name: string;
  }): Promise<{ externalCustomerId: string }> {
    const externalCustomerId = id('cus_mock');
    this.store.customers.set(externalCustomerId, {
      externalCustomerId,
      organizationId: input.organizationId,
      email: input.email,
    });
    return Promise.resolve({ externalCustomerId });
  }

  createCheckoutSession(input: {
    externalCustomerId: string;
    plan: PaidPlanName;
  }): Promise<{ sessionId: string; url: string }> {
    if (!this.store.customers.has(input.externalCustomerId)) {
      throw new IntegrationProviderError(PROVIDER, 'unknown customer');
    }
    const sessionId = id('cs_mock');
    this.store.sessions.set(sessionId, {
      sessionId,
      externalCustomerId: input.externalCustomerId,
      plan: input.plan,
      status: 'open',
    });
    return Promise.resolve({
      sessionId,
      url: `${this.config.webBaseUrl}/billing/checkout/${sessionId}`,
    });
  }

  changePlan(input: {
    externalSubscriptionId: string;
    plan: PaidPlanName;
    atPeriodEnd: boolean;
  }): Promise<void> {
    const subscription = this.subscription(input.externalSubscriptionId);
    const now = new Date();
    if (input.atPeriodEnd) {
      subscription.pendingPlan = input.plan === subscription.plan ? null : input.plan;
      subscription.cancelAtPeriodEnd = false;
    } else {
      const difference =
        PLAN_CATALOG[input.plan].monthlyPriceCents -
        PLAN_CATALOG[subscription.plan].monthlyPriceCents;
      subscription.plan = input.plan;
      subscription.pendingPlan = null;
      subscription.cancelAtPeriodEnd = false;
      this.emitInvoice(subscription, Math.max(difference, 0), 'paid', now);
    }
    this.emitSubscription(subscription, now);
    return Promise.resolve();
  }

  cancelAtPeriodEnd(externalSubscriptionId: string): Promise<void> {
    const subscription = this.subscription(externalSubscriptionId);
    subscription.cancelAtPeriodEnd = true;
    subscription.pendingPlan = null;
    this.emitSubscription(subscription, new Date());
    return Promise.resolve();
  }

  resume(externalSubscriptionId: string): Promise<void> {
    const subscription = this.subscription(externalSubscriptionId);
    subscription.cancelAtPeriodEnd = false;
    this.emitSubscription(subscription, new Date());
    return Promise.resolve();
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): BillingEvent {
    const header = headers[SIGNATURE_HEADER];
    const verdict = verifyWebhookSignature(
      this.config.billing.webhookSecret,
      rawBody,
      typeof header === 'string' ? header : undefined,
      now,
    );
    if (verdict !== 'valid') {
      throw new InvalidWebhookError(verdict);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookError('malformed body');
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) {
      throw new InvalidWebhookError('unexpected shape');
    }
    return parsed.data;
  }

  drainOutbox(): WebhookDelivery[] {
    const pending = this.store.outbox;
    this.store.outbox = [];
    return pending;
  }

  // -------------------------------------------------------------------------
  // Simulation hooks (mock only)
  // -------------------------------------------------------------------------

  /** The checkout session of one customer — never someone else's. */
  session(sessionId: string, externalCustomerId: string): MockCheckoutSession {
    const session = this.store.sessions.get(sessionId);
    if (session === undefined || session.externalCustomerId !== externalCustomerId) {
      throw new NotFoundError('Checkout session');
    }
    return session;
  }

  /** The card is "charged": a paid invoice and an active subscription, or a failure. */
  completeCheckout(
    sessionId: string,
    externalCustomerId: string,
    outcome: 'succeeded' | 'failed',
  ): void {
    const session = this.session(sessionId, externalCustomerId);
    if (session.status !== 'open') {
      throw new ConflictError('The checkout session is no longer open');
    }
    session.status = outcome === 'succeeded' ? 'completed' : 'failed';

    const now = new Date();
    const subscription: MockSubscription = {
      externalSubscriptionId: id('sub_mock'),
      externalCustomerId,
      plan: session.plan,
      status: outcome === 'succeeded' ? 'active' : 'incomplete',
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: new Date(now.getTime() + PERIOD_MS).toISOString(),
      cancelAtPeriodEnd: false,
      pendingPlan: null,
      pastDueSince: null,
      canceledAt: null,
    };
    this.store.subscriptions.set(subscription.externalSubscriptionId, subscription);
    this.emitInvoice(
      subscription,
      PLAN_CATALOG[session.plan].monthlyPriceCents,
      outcome === 'succeeded' ? 'paid' : 'open',
      now,
    );
    this.emitSubscription(subscription, now);
  }

  /**
   * The current period ends now. A scheduled cancellation takes effect, a
   * scheduled downgrade is applied, and the renewal invoice is paid or fails.
   */
  endPeriod(externalSubscriptionId: string, outcome: 'succeeded' | 'failed'): void {
    const subscription = this.subscription(externalSubscriptionId);
    if (subscription.status === 'canceled' || subscription.status === 'incomplete') {
      throw new ConflictError('The subscription has no period to renew');
    }

    const now = new Date();
    if (subscription.cancelAtPeriodEnd) {
      subscription.status = 'canceled';
      subscription.canceledAt = now.toISOString();
      subscription.cancelAtPeriodEnd = false;
      this.emitSubscription(subscription, now);
      return;
    }

    subscription.plan = subscription.pendingPlan ?? subscription.plan;
    subscription.pendingPlan = null;
    subscription.currentPeriodStart = now.toISOString();
    subscription.currentPeriodEnd = new Date(now.getTime() + PERIOD_MS).toISOString();
    if (outcome === 'succeeded') {
      subscription.status = 'active';
      subscription.pastDueSince = null;
    } else {
      subscription.status = 'past_due';
      subscription.pastDueSince ??= now.toISOString();
    }
    this.emitInvoice(
      subscription,
      PLAN_CATALOG[subscription.plan].monthlyPriceCents,
      outcome === 'succeeded' ? 'paid' : 'open',
      now,
    );
    this.emitSubscription(subscription, now);
  }

  private subscription(externalSubscriptionId: string): MockSubscription {
    const subscription = this.store.subscriptions.get(externalSubscriptionId);
    if (subscription === undefined) {
      throw new IntegrationProviderError(PROVIDER, 'unknown subscription');
    }
    return subscription;
  }

  private emitSubscription(subscription: MockSubscription, now: Date): void {
    const { externalCustomerId, ...snapshot } = subscription;
    this.emit({
      id: id('evt_mock'),
      type: 'subscription.updated',
      createdAt: now.toISOString(),
      externalCustomerId,
      subscription: snapshot,
    });
  }

  private emitInvoice(
    subscription: MockSubscription,
    amountCents: number,
    status: 'paid' | 'open',
    now: Date,
  ): void {
    this.store.invoiceSequence += 1;
    const invoice: ProviderInvoiceSnapshot = {
      externalInvoiceId: id('in_mock'),
      number: `MOCK-${String(this.store.invoiceSequence).padStart(6, '0')}`,
      status,
      plan: subscription.plan,
      amountDueCents: amountCents,
      amountPaidCents: status === 'paid' ? amountCents : 0,
      currency: 'usd',
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      hostedUrl: null,
      issuedAt: now.toISOString(),
    };
    this.emit({
      id: id('evt_mock'),
      type: 'invoice.updated',
      createdAt: now.toISOString(),
      externalCustomerId: subscription.externalCustomerId,
      invoice,
    });
  }

  private emit(event: BillingEvent): void {
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const signature = signWebhook(
      this.config.billing.webhookSecret,
      rawBody,
      Math.floor(Date.now() / 1000),
    );
    const delivery: WebhookDelivery = {
      rawBody,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
    };
    this.store.outbox.push(delivery);
    this.store.delivered.push(delivery);
  }
}
