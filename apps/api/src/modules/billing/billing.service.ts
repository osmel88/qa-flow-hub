import { Inject, Injectable } from '@nestjs/common';
import {
  AuditAction,
  BillingProviderKind,
  Invoice,
  OrganizationPlan,
  Subscription,
  SubscriptionStatus,
} from '@prisma/client';
import {
  BillingOverviewView,
  CheckoutSessionView,
  InvoiceView,
  LIMITED_RESOURCES,
  ListInvoicesQuery,
  MockCheckoutSessionView,
  OrganizationPlanName,
  PLAN_CATALOG,
  PLAN_RANK,
  PaidPlanName,
  Paginated,
  SubscriptionView,
  withinLimit,
} from '@qa-flow-hub/shared';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaTransaction } from '../../database/prisma.service';
import { ConflictError, NotFoundError } from '../../errors';
import { AuditService } from '../audit/audit.service';
import { BILLING_PROVIDER, BillingProvider } from './billing-provider';
import { BillingRepository } from './billing.repository';
import { BillingWebhooksService } from './billing-webhooks.service';
import { MockBillingProvider } from './mock/mock-billing.provider';
import { UsageLimitsService } from './usage-limits.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Statuses where a provider subscription exists and can be changed. */
const LIVE: ReadonlySet<SubscriptionStatus> = new Set([
  SubscriptionStatus.active,
  SubscriptionStatus.past_due,
]);

/**
 * Billing use cases for the active organization. Everything that changes a
 * provider-backed subscription is a *request* to the provider; our rows move
 * when its webhook arrives (BillingWebhooksService). The one local-only state
 * is the trial, which the provider never heard of.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly billing: BillingRepository,
    private readonly limits: UsageLimitsService,
    private readonly webhooks: BillingWebhooksService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** Called inside the transaction that creates the organization. */
  startTrial(organizationId: string, tx: PrismaTransaction, now: Date = new Date()): Promise<void> {
    const trialEndsAt = new Date(now.getTime() + this.config.billing.trialDays * DAY_MS);
    return this.billing.startTrial(organizationId, OrganizationPlan.team, trialEndsAt, tx);
  }

  /** Brings the cached `Organization.plan` up to date with the clock. */
  async syncCachedPlan(): Promise<void> {
    const subscription = await this.billing.findSubscription();
    await this.billing.cachePlan(this.limits.effectivePlanOf(subscription).plan);
  }

  async overview(): Promise<BillingOverviewView> {
    const subscription = await this.billing.findSubscription();
    const effective = this.limits.effectivePlanOf(subscription);
    // The cached plan on the organization catches up lazily: a trial expires
    // by the clock, and no job runner exists to write that down.
    await this.billing.cachePlan(effective.plan);
    const usage = await this.limits.usage();
    const limits = PLAN_CATALOG[effective.plan].limits;

    return {
      effectivePlan: effective.plan,
      reason: effective.reason,
      until: iso(effective.until),
      subscription: subscription === null ? null : this.toSubscriptionView(subscription),
      limits,
      usage,
      overLimit: LIMITED_RESOURCES.filter(
        (resource) => !withinLimit(limits[resource], usage[resource], 0),
      ),
      plans: Object.values(PLAN_CATALOG),
      provider: this.provider.name,
    };
  }

  async listInvoices(query: ListInvoicesQuery): Promise<Paginated<InvoiceView>> {
    const page = await this.billing.listInvoices(query);
    return { data: page.data.map((invoice) => this.toInvoiceView(invoice)), meta: page.meta };
  }

  async checkout(plan: PaidPlanName, email: string): Promise<CheckoutSessionView> {
    const subscription = await this.billing.findSubscription();
    if (subscription?.externalSubscriptionId != null && LIVE.has(subscription.status)) {
      throw new ConflictError(
        'The organization already has a paid subscription; change its plan instead',
      );
    }

    const customer = await this.ensureCustomer(email);
    const session = await this.provider.createCheckoutSession({
      externalCustomerId: customer,
      plan,
    });
    await this.audit.record({
      action: AuditAction.create,
      entityType: 'checkout_session',
      entityId: session.sessionId,
      summary: `Started checkout for the ${PLAN_CATALOG[plan].label} plan`,
      changes: { plan },
    });
    return { sessionId: session.sessionId, url: session.url, plan };
  }

  /**
   * Upgrade: immediate, because the customer pays for it now. Downgrade:
   * at the end of the period already paid for. To `free`: a cancellation at
   * period end. Choosing the current plan with a downgrade scheduled undoes it.
   */
  async changePlan(plan: OrganizationPlanName): Promise<BillingOverviewView> {
    const subscription = await this.requireLiveSubscription();
    const externalId = subscription.externalSubscriptionId as string;

    if (plan === 'free') {
      await this.provider.cancelAtPeriodEnd(externalId);
    } else if (plan === subscription.plan) {
      if (subscription.pendingPlan === null && !subscription.cancelAtPeriodEnd) {
        throw new ConflictError(
          `The organization is already on the ${PLAN_CATALOG[plan].label} plan`,
        );
      }
      await this.provider.changePlan({
        externalSubscriptionId: externalId,
        plan,
        atPeriodEnd: true,
      });
    } else {
      const upgrade = PLAN_RANK[plan] > PLAN_RANK[subscription.plan];
      await this.provider.changePlan({
        externalSubscriptionId: externalId,
        plan,
        atPeriodEnd: !upgrade,
      });
    }

    await this.deliverPending();
    return this.overview();
  }

  /** Idempotent: canceling twice is not an error. */
  async cancel(): Promise<BillingOverviewView> {
    const subscription = await this.billing.findSubscription();
    if (subscription === null || subscription.status === SubscriptionStatus.canceled) {
      return this.overview();
    }

    if (subscription.status === SubscriptionStatus.trialing) {
      const { count } = await this.billing.cancelTrial(new Date());
      if (count === 0) {
        // A checkout was confirmed meanwhile: cancel what exists now instead.
        return this.cancel();
      }
      await this.audit.record({
        action: AuditAction.update,
        entityType: 'subscription',
        entityId: subscription.id,
        summary: 'Canceled the trial',
        changes: { from: { status: subscription.status }, to: { status: 'canceled' } },
      });
      return this.overview();
    }

    if (subscription.externalSubscriptionId !== null && LIVE.has(subscription.status)) {
      if (!subscription.cancelAtPeriodEnd) {
        await this.provider.cancelAtPeriodEnd(subscription.externalSubscriptionId);
        await this.deliverPending();
      }
    }
    return this.overview();
  }

  async resume(): Promise<BillingOverviewView> {
    const subscription = await this.requireLiveSubscription();
    if (!subscription.cancelAtPeriodEnd) {
      throw new ConflictError('The subscription is not scheduled for cancellation');
    }
    await this.provider.resume(subscription.externalSubscriptionId as string);
    await this.deliverPending();
    return this.overview();
  }

  // -------------------------------------------------------------------------
  // Mock simulation (only reachable while the mock provider is configured)
  // -------------------------------------------------------------------------

  async mockSession(sessionId: string): Promise<MockCheckoutSessionView> {
    const session = this.mock().session(sessionId, await this.requireCustomerId());
    return {
      sessionId: session.sessionId,
      plan: session.plan,
      amountCents: PLAN_CATALOG[session.plan].monthlyPriceCents,
      currency: PLAN_CATALOG[session.plan].currency,
      status: session.status,
    };
  }

  async completeMockCheckout(
    sessionId: string,
    outcome: 'succeeded' | 'failed',
  ): Promise<BillingOverviewView> {
    const subscription = await this.billing.findSubscription();
    if (subscription?.externalSubscriptionId != null && LIVE.has(subscription.status)) {
      throw new ConflictError('The organization already has a paid subscription');
    }
    this.mock().completeCheckout(sessionId, await this.requireCustomerId(), outcome);
    await this.deliverPending();
    return this.overview();
  }

  async endMockPeriod(outcome: 'succeeded' | 'failed'): Promise<BillingOverviewView> {
    const subscription = await this.billing.findSubscription();
    if (subscription?.externalSubscriptionId == null) {
      throw new ConflictError('The organization has no provider subscription');
    }
    this.mock().endPeriod(subscription.externalSubscriptionId, outcome);
    await this.deliverPending();
    return this.overview();
  }

  get isMock(): boolean {
    return this.provider instanceof MockBillingProvider;
  }

  private mock(): MockBillingProvider {
    if (!(this.provider instanceof MockBillingProvider)) {
      throw new NotFoundError('Route');
    }
    return this.provider;
  }

  /**
   * In-process deliveries go through the public webhook path — signature,
   * tenant mapping and idempotency included — not a shortcut around it.
   */
  private async deliverPending(): Promise<void> {
    for (const delivery of this.provider.drainOutbox()) {
      await this.webhooks.handle(this.provider.name, delivery.rawBody, delivery.headers);
    }
  }

  private async ensureCustomer(email: string): Promise<string> {
    const existing = await this.billing.findCustomer();
    if (existing !== null) {
      return existing.externalCustomerId;
    }
    const { externalCustomerId } = await this.provider.createCustomer({
      organizationId: this.organizationIdForProvider(),
      email,
      name: await this.billing.organizationName(),
    });
    const customer = await this.billing.createCustomer({
      provider: BillingProviderKind[this.provider.name],
      externalCustomerId,
      email,
    });
    await this.audit.record({
      action: AuditAction.create,
      entityType: 'billing_customer',
      entityId: customer.id,
      summary: 'Registered the organization with the billing provider',
      changes: { provider: this.provider.name },
    });
    return externalCustomerId;
  }

  private organizationIdForProvider(): string {
    return this.billing.currentOrganizationId;
  }

  private async requireCustomerId(): Promise<string> {
    const customer = await this.billing.findCustomer();
    if (customer === null) {
      throw new NotFoundError('Checkout session');
    }
    return customer.externalCustomerId;
  }

  private async requireLiveSubscription(): Promise<Subscription> {
    const subscription = await this.billing.findSubscription();
    if (
      subscription === null ||
      subscription.externalSubscriptionId === null ||
      !LIVE.has(subscription.status)
    ) {
      throw new ConflictError('The organization has no paid subscription; start a checkout');
    }
    return subscription;
  }

  private toSubscriptionView(subscription: Subscription): SubscriptionView {
    return {
      plan: subscription.plan,
      status: subscription.status,
      provider: subscription.provider,
      trialEndsAt: iso(subscription.trialEndsAt),
      currentPeriodStart: iso(subscription.currentPeriodStart),
      currentPeriodEnd: iso(subscription.currentPeriodEnd),
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      pendingPlan: subscription.pendingPlan,
      pastDueSince: iso(subscription.pastDueSince),
      canceledAt: iso(subscription.canceledAt),
    };
  }

  private toInvoiceView(invoice: Invoice): InvoiceView {
    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      plan: invoice.plan,
      amountDueCents: invoice.amountDueCents,
      amountPaidCents: invoice.amountPaidCents,
      currency: invoice.currency,
      periodStart: iso(invoice.periodStart),
      periodEnd: iso(invoice.periodEnd),
      hostedUrl: invoice.hostedUrl,
      issuedAt: invoice.issuedAt.toISOString(),
    };
  }
}
