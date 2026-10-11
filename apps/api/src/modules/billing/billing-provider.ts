import type {
  InvoiceStatusName,
  OrganizationPlanName,
  PaidPlanName,
  SubscriptionStatusName,
} from '@qa-flow-hub/shared';

/**
 * The seam between qa-flow-hub and whoever charges the card.
 *
 * Shaped after what every serious provider (Stripe, Paddle, Chargebee) has in
 * common, not after one of them: a customer, a hosted checkout, a subscription
 * whose state the *provider* owns, and signed webhooks that tell us when that
 * state changed. The rule that follows from "the provider owns the state" is
 * the most important one in the module: methods here *ask* for a change and
 * return nothing; the local copy changes only when a verified webhook arrives.
 * A browser returning from checkout proves nothing — a webhook does.
 *
 * See ADR 0015 for the provider evaluation.
 */
export const BILLING_PROVIDER = Symbol('BillingProvider');

export type BillingProviderName = 'mock';

/** The provider's view of a subscription, carried whole by every event. */
export interface ProviderSubscriptionSnapshot {
  externalSubscriptionId: string;
  plan: PaidPlanName;
  status: SubscriptionStatusName;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: PaidPlanName | null;
  pastDueSince: string | null;
  canceledAt: string | null;
}

export interface ProviderInvoiceSnapshot {
  externalInvoiceId: string;
  number: string;
  status: InvoiceStatusName;
  plan: OrganizationPlanName | null;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedUrl: string | null;
  issuedAt: string;
}

interface BillingEventBase {
  /** The provider's event id: the idempotency key. */
  id: string;
  createdAt: string;
  /** Who the event is about, in the provider's terms. Mapped to a tenant locally. */
  externalCustomerId: string;
}

/**
 * Snapshot events, not deltas: each one carries the full object, so applying
 * the same event twice or two events in either order converges on a state the
 * provider actually had.
 */
export type BillingEvent =
  | (BillingEventBase & {
      type: 'subscription.updated';
      subscription: ProviderSubscriptionSnapshot;
    })
  | (BillingEventBase & { type: 'invoice.updated'; invoice: ProviderInvoiceSnapshot });

/** A webhook exactly as it travels: the bytes that were signed, and the headers. */
export interface WebhookDelivery {
  rawBody: Buffer;
  headers: Record<string, string>;
}

export interface BillingProvider {
  readonly name: BillingProviderName;

  createCustomer(input: {
    organizationId: string;
    email: string;
    name: string;
  }): Promise<{ externalCustomerId: string }>;

  /** A hosted payment page. Paying there produces webhooks, nothing else. */
  createCheckoutSession(input: {
    externalCustomerId: string;
    plan: PaidPlanName;
  }): Promise<{ sessionId: string; url: string }>;

  /** Immediate for an upgrade; at period end for a downgrade between paid plans. */
  changePlan(input: {
    externalSubscriptionId: string;
    plan: PaidPlanName;
    atPeriodEnd: boolean;
  }): Promise<void>;

  cancelAtPeriodEnd(externalSubscriptionId: string): Promise<void>;

  /** Undoes a scheduled cancellation before the period ends. */
  resume(externalSubscriptionId: string): Promise<void>;

  /**
   * Verifies the signature over the raw bytes *before* parsing, then parses.
   * Throws `InvalidWebhookError` for anything unsigned, stale, tampered or
   * malformed — and says nothing about which of those it was.
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): BillingEvent;

  /**
   * Webhooks the provider produced in-process and has not delivered yet. A
   * real provider calls our public endpoint over HTTP and returns `[]`; the
   * mock hands its signed deliveries to the same verification path instead.
   */
  drainOutbox(): WebhookDelivery[];
}
