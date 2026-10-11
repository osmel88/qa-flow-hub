import { z } from 'zod';
import { paginationQuerySchema } from '../common/pagination.js';
import { ORGANIZATION_PLANS } from '../organizations/organization.contracts.js';

export type OrganizationPlanName = (typeof ORGANIZATION_PLANS)[number];

/** Plans a customer can pay for; `free` is what is left when nothing is paid. */
export const PAID_PLANS = ['team', 'business'] as const;
export type PaidPlanName = (typeof PAID_PLANS)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
] as const;
export type SubscriptionStatusName = (typeof SUBSCRIPTION_STATUSES)[number];

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;
export type InvoiceStatusName = (typeof INVOICE_STATUSES)[number];

/** The dimensions a plan limits. Each one is counted in the database, never estimated. */
export const LIMITED_RESOURCES = ['projects', 'members', 'storage'] as const;
export type LimitedResource = (typeof LIMITED_RESOURCES)[number];

export interface PlanLimits {
  /** Active and archived projects (archiving does not free a slot; deleting does). */
  projects: number | null;
  /** Active members plus pending invitations. */
  members: number | null;
  /** Bytes of evidence stored (live attachments). */
  storage: number | null;
}

export interface PlanDescriptor {
  plan: OrganizationPlanName;
  label: string;
  /** Display price only. The amount actually charged lives in the provider. */
  monthlyPriceCents: number;
  currency: 'usd';
  limits: PlanLimits;
}

const GB = 1024 ** 3;

/**
 * The plan catalog. Code, not a table (S2-F11 decision 1A): limits are part of
 * the product contract, versioned and reviewed like `ROLE_PERMISSIONS`, and
 * prices are owned by the billing provider. `null` means unlimited.
 */
export const PLAN_CATALOG: Readonly<Record<OrganizationPlanName, PlanDescriptor>> = {
  free: {
    plan: 'free',
    label: 'Free',
    monthlyPriceCents: 0,
    currency: 'usd',
    limits: { projects: 3, members: 5, storage: 1 * GB },
  },
  team: {
    plan: 'team',
    label: 'Team',
    monthlyPriceCents: 4900,
    currency: 'usd',
    limits: { projects: 25, members: 50, storage: 50 * GB },
  },
  business: {
    plan: 'business',
    label: 'Business',
    monthlyPriceCents: 19900,
    currency: 'usd',
    limits: { projects: null, members: null, storage: 500 * GB },
  },
};

/** Plan order, cheapest first: an upgrade moves right, a downgrade left. */
export const PLAN_RANK: Readonly<Record<OrganizationPlanName, number>> = {
  free: 0,
  team: 1,
  business: 2,
};

export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_PAST_DUE_GRACE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of a subscription that decides which plan an organization gets. */
export interface SubscriptionSnapshot {
  plan: OrganizationPlanName;
  status: SubscriptionStatusName;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
}

export interface EffectivePlan {
  plan: OrganizationPlanName;
  /** Why the organization has this plan, for the UI and for support. */
  reason:
    | 'no_subscription'
    | 'trial'
    | 'trial_expired'
    | 'active'
    | 'period_ended'
    | 'past_due_grace'
    | 'past_due_expired'
    | 'canceled'
    | 'incomplete';
  /** When the current reason stops applying, if it is time-bound. */
  until: Date | null;
}

/**
 * Which plan an organization is entitled to *now*. Pure and evaluated on
 * every read: there is no job runner (debt 3), so a trial that ended at 03:00
 * is over at 03:00 for every request, not when a cron job gets to it.
 *
 * - `trialing`: the subscribed plan until `trialEndsAt`, then `free`.
 * - `active`: the plan until `currentPeriodEnd` (a missing renewal webhook
 *   must not keep a plan alive forever), then `free`.
 * - `past_due`: the plan for `graceDays` after the first failed payment.
 * - `canceled`, `incomplete`: `free`.
 */
export function resolveEffectivePlan(
  subscription: SubscriptionSnapshot | null,
  now: Date,
  graceDays: number = DEFAULT_PAST_DUE_GRACE_DAYS,
): EffectivePlan {
  if (subscription === null) {
    return { plan: 'free', reason: 'no_subscription', until: null };
  }

  switch (subscription.status) {
    case 'trialing': {
      const end = subscription.trialEndsAt;
      return end !== null && end.getTime() > now.getTime()
        ? { plan: subscription.plan, reason: 'trial', until: end }
        : { plan: 'free', reason: 'trial_expired', until: null };
    }
    case 'active': {
      const end = subscription.currentPeriodEnd;
      return end === null || end.getTime() > now.getTime()
        ? { plan: subscription.plan, reason: 'active', until: end }
        : { plan: 'free', reason: 'period_ended', until: null };
    }
    case 'past_due': {
      const since = subscription.pastDueSince ?? now;
      const end = new Date(since.getTime() + graceDays * DAY_MS);
      return end.getTime() > now.getTime()
        ? { plan: subscription.plan, reason: 'past_due_grace', until: end }
        : { plan: 'free', reason: 'past_due_expired', until: null };
    }
    case 'canceled':
      return { plan: 'free', reason: 'canceled', until: null };
    case 'incomplete':
      return { plan: 'free', reason: 'incomplete', until: null };
  }
}

/** Whether adding `adding` units to `used` stays within `limit` (`null` = unlimited). */
export function withinLimit(limit: number | null, used: number, adding = 1): boolean {
  return limit === null || used + adding <= limit;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const checkoutSchema = z.object({ plan: z.enum(PAID_PLANS) });
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const changePlanSchema = z.object({ plan: z.enum(ORGANIZATION_PLANS) });
export type ChangePlanInput = z.infer<typeof changePlanSchema>;

export const listInvoicesQuerySchema = paginationQuerySchema;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

/** What the mock checkout page sends back: the simulated card outcome. */
export const completeMockCheckoutSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
});
export type CompleteMockCheckoutInput = z.infer<typeof completeMockCheckoutSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface PlanUsage {
  projects: number;
  members: number;
  storage: number;
}

export interface SubscriptionView {
  plan: OrganizationPlanName;
  status: SubscriptionStatusName;
  provider: string;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingPlan: OrganizationPlanName | null;
  pastDueSince: string | null;
  canceledAt: string | null;
}

export interface BillingOverviewView {
  effectivePlan: OrganizationPlanName;
  reason: EffectivePlan['reason'];
  /** When the current reason expires (trial end, grace end, period end). */
  until: string | null;
  subscription: SubscriptionView | null;
  limits: PlanLimits;
  usage: PlanUsage;
  /** Resources already above the effective plan's limit (nothing is deleted). */
  overLimit: LimitedResource[];
  plans: PlanDescriptor[];
  provider: string;
}

export interface InvoiceView {
  id: string;
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

export interface CheckoutSessionView {
  sessionId: string;
  /** Where the browser goes to pay. For the mock, a page of this web client. */
  url: string;
  plan: PaidPlanName;
}

export interface MockCheckoutSessionView {
  sessionId: string;
  plan: PaidPlanName;
  amountCents: number;
  currency: string;
  status: 'open' | 'completed' | 'failed';
}
