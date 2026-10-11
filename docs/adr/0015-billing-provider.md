# 0015 — Billing behind a `BillingProvider` port, mock first

Status: accepted
Date: 2026-10-11
Related: [0013](0013-row-level-security-with-non-owning-role.md),
[0014](0014-external-secret-manager.md)

## Context

S2-F11 turns `Organization.plan` from a field an owner could edit into the
consequence of a paid subscription. Money, tax and card data must not live in
this codebase; what must live here is the mapping between a provider's
objects and a tenant, the subscription state the product reacts to, and the
limits each plan grants.

Constraints:

- **The plan must not be self-service-editable.** `PATCH /organizations/current`
  used to accept `plan`, so an owner could move to `business` without paying.
- **Webhooks are the source of truth**, and they arrive unauthenticated over
  the public internet. They must be authenticated over the exact bytes sent,
  deduplicated and idempotent, and must never trust an organization id in the
  payload.
- **Tests and E2E must run without network access or a provider account.**
- **No card data, ever** (PCI scope stays with the provider).

## Options evaluated

| Provider       | Model                       | Tax / VAT                                    | Fit                                                                                                        |
| -------------- | --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stripe Billing | Payment processor + billing | Stripe Tax (extra fee); we remain the seller | Best API and webhook tooling, test clocks for lifecycle tests, largest ecosystem. We own tax registration. |
| Paddle         | Merchant of record          | Included; Paddle is the seller               | Removes sales-tax/VAT compliance; higher fee, less control over checkout and invoices.                     |
| Lemon Squeezy  | Merchant of record          | Included                                     | Simple, aimed at small SaaS; thinner API for seat/usage changes and B2B invoicing.                         |
| Chargebee      | Billing layer over gateways | Via integrations                             | Strong for complex B2B (quotes, dunning, revenue recognition); another vendor on top of a gateway.         |

## Decision

1. A **`BillingProvider` port** (`apps/api/src/modules/billing/billing-provider.ts`)
   with customer creation, checkout, plan change, cancel/resume and webhook
   parsing. The rest of the module only sees normalized `BillingEvent`s.
2. A **deterministic mock provider** for development, tests and E2E. It keeps
   its own customers, subscriptions and invoices in memory and delivers
   HMAC-SHA256 signed webhooks (`t=<unix>,v1=<hex>` over `"<t>.<raw body>"`,
   300 s tolerance) through the same public endpoint a real provider uses.
3. **Stripe is the intended first real provider**, in a later phase: it fits a
   B2B product that invoices organizations and its test clocks map onto the
   lifecycle tests we already have. Paddle remains the alternative if selling
   internationally makes merchant-of-record tax handling worth the fee.
4. **Production refuses to boot with `BILLING_PROVIDER=mock`** (fail closed).
5. The plan **catalog lives in code** (`packages/shared/src/billing`);
   `Organization.plan` stays as a cache written only by the billing module.
   The effective plan is always recomputed from the subscription and the
   clock, so an expired trial or grace period needs no background job.

## Consequences

- No provider account, SDK or network call is needed until the real provider
  arrives; the mock is exercised end to end by integration and E2E tests.
- Adding Stripe means one class implementing the port, its signature scheme
  and event mapping, plus a `BILLING_PROVIDER` enum value; the state machine,
  limits, RLS and UI do not change.
- Prices in the catalog are display values; with a real provider they must
  match the provider's price objects (a startup check is part of that phase).
- Until then the platform cannot be deployed to production with billing —
  deliberately.
