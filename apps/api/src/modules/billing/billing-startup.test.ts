import { describe, expect, it } from 'vitest';
import { billingStartupProblem } from './billing-startup';

const billing = {
  provider: 'mock' as const,
  webhookSecret: 'development-only-billing-webhook-secret-not-for-production',
  trialDays: 14,
  pastDueGraceDays: 7,
  webhookRateLimitMax: 120,
};

describe('billingStartupProblem', () => {
  it('lets development and test run on the mock provider', () => {
    expect(billingStartupProblem({ isProduction: false, billing })).toBeNull();
  });

  it('refuses the mock provider in production, whatever the secret', () => {
    const strong = { ...billing, webhookSecret: 'Hq7Lw2Zp9Rt4Vn8Bc1Yh6Js3Dg5Ae0Kx' };
    expect(billingStartupProblem({ isProduction: true, billing: strong })).toMatch(
      /BILLING_PROVIDER=mock/,
    );
    expect(billingStartupProblem({ isProduction: true, billing })).toMatch(/BILLING_PROVIDER=mock/);
  });
});
