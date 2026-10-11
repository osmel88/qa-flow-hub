import { describe, expect, it } from 'vitest';
import {
  PLAN_CATALOG,
  SubscriptionSnapshot,
  changePlanSchema,
  checkoutSchema,
  resolveEffectivePlan,
  withinLimit,
} from './billing.contracts';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number): Date => new Date(NOW.getTime() + offsetDays * DAY);

const snapshot = (overrides: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({
  plan: 'team',
  status: 'active',
  trialEndsAt: null,
  currentPeriodEnd: null,
  pastDueSince: null,
  ...overrides,
});

describe('plan catalog', () => {
  it('carries the approved limits', () => {
    const GB = 1024 ** 3;
    expect(PLAN_CATALOG.free.limits).toEqual({ projects: 3, members: 5, storage: GB });
    expect(PLAN_CATALOG.team.limits).toEqual({ projects: 25, members: 50, storage: 50 * GB });
    expect(PLAN_CATALOG.business.limits).toEqual({
      projects: null,
      members: null,
      storage: 500 * GB,
    });
  });

  it('only sells paid plans at checkout, but allows any plan as a change target', () => {
    expect(checkoutSchema.safeParse({ plan: 'free' }).success).toBe(false);
    expect(checkoutSchema.safeParse({ plan: 'team' }).success).toBe(true);
    expect(changePlanSchema.safeParse({ plan: 'free' }).success).toBe(true);
    expect(changePlanSchema.safeParse({ plan: 'enterprise' }).success).toBe(false);
  });
});

describe('withinLimit', () => {
  it('admits up to the limit and refuses beyond it; null is unlimited', () => {
    expect(withinLimit(3, 2)).toBe(true);
    expect(withinLimit(3, 3)).toBe(false);
    expect(withinLimit(3, 3, 0)).toBe(true);
    expect(withinLimit(3, 4, 0)).toBe(false);
    expect(withinLimit(100, 90, 11)).toBe(false);
    expect(withinLimit(null, 1_000_000)).toBe(true);
  });
});

describe('resolveEffectivePlan', () => {
  it('is Free without a subscription', () => {
    expect(resolveEffectivePlan(null, NOW)).toEqual({
      plan: 'free',
      reason: 'no_subscription',
      until: null,
    });
  });

  it('honours a trial until it ends, to the millisecond', () => {
    const end = at(3);
    expect(resolveEffectivePlan(snapshot({ status: 'trialing', trialEndsAt: end }), NOW)).toEqual({
      plan: 'team',
      reason: 'trial',
      until: end,
    });
    expect(
      resolveEffectivePlan(snapshot({ status: 'trialing', trialEndsAt: NOW }), NOW).reason,
    ).toBe('trial_expired');
    expect(
      resolveEffectivePlan(snapshot({ status: 'trialing', trialEndsAt: null }), NOW).plan,
    ).toBe('free');
  });

  it('keeps an active plan until the period ends, so a missing renewal cannot keep it forever', () => {
    expect(resolveEffectivePlan(snapshot({ currentPeriodEnd: at(10) }), NOW).plan).toBe('team');
    expect(resolveEffectivePlan(snapshot({ currentPeriodEnd: at(-1) }), NOW)).toEqual({
      plan: 'free',
      reason: 'period_ended',
      until: null,
    });
  });

  it('grants the configured grace after the first failed payment', () => {
    const pastDue = snapshot({ status: 'past_due', plan: 'business', pastDueSince: at(-6) });
    expect(resolveEffectivePlan(pastDue, NOW, 7)).toEqual({
      plan: 'business',
      reason: 'past_due_grace',
      until: at(1),
    });
    expect(
      resolveEffectivePlan(snapshot({ status: 'past_due', pastDueSince: at(-7) }), NOW, 7).reason,
    ).toBe('past_due_expired');
    expect(resolveEffectivePlan(pastDue, NOW, 0).plan).toBe('free');
  });

  it('is Free when canceled or incomplete, whatever the dates say', () => {
    const future = { currentPeriodEnd: at(20), trialEndsAt: at(20) };
    expect(resolveEffectivePlan(snapshot({ status: 'canceled', ...future }), NOW).reason).toBe(
      'canceled',
    );
    expect(resolveEffectivePlan(snapshot({ status: 'incomplete', ...future }), NOW).reason).toBe(
      'incomplete',
    );
  });
});
