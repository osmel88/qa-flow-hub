-- S2-F11 Billing & Subscriptions.
--
-- Four organization-scoped tables behind Row Level Security, a narrow lookup
-- for webhooks (which arrive with no tenant), and a backfill that keeps every
-- organization on the plan it has today.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'incomplete');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');

-- CreateEnum
CREATE TYPE "BillingProviderKind" AS ENUM ('mock');

-- CreateTable
CREATE TABLE "billing_customers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "BillingProviderKind" NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "BillingProviderKind" NOT NULL,
    "externalSubscriptionId" TEXT,
    "plan" "OrganizationPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlan" "OrganizationPlan",
    "pastDueSince" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "BillingProviderKind" NOT NULL,
    "externalInvoiceId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL,
    "plan" "OrganizationPlan",
    "amountDueCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "hostedUrl" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "BillingProviderKind" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "organizationId" TEXT,
    "payloadSha256" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_organizationId_key" ON "billing_customers"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customers_provider_externalCustomerId_key" ON "billing_customers"("provider", "externalCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organizationId_key" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_externalSubscriptionId_key" ON "subscriptions"("provider", "externalSubscriptionId");

-- CreateIndex
CREATE INDEX "invoices_organizationId_issuedAt_idx" ON "invoices"("organizationId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_provider_externalInvoiceId_key" ON "invoices"("provider", "externalInvoiceId");

-- CreateIndex
CREATE INDEX "billing_webhook_events_organizationId_idx" ON "billing_webhook_events"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_events_provider_externalEventId_key" ON "billing_webhook_events"("provider", "externalEventId");

-- AddForeignKey
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row Level Security -------------------------------------------------------

ALTER TABLE "billing_customers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_customers"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscriptions"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoices"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- A webhook whose customer resolves to no organization is still recorded (for
-- replay protection) with a NULL tenant, visible only when no tenant is set —
-- the same rule as account-level notifications.
ALTER TABLE "billing_webhook_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_webhook_events"
  USING (
    "organizationId" = current_setting('app.current_organization', true)
    OR (
      "organizationId" IS NULL
      AND coalesce(current_setting('app.current_organization', true), '') = ''
    )
  )
  WITH CHECK (
    "organizationId" = current_setting('app.current_organization', true)
    OR (
      "organizationId" IS NULL
      AND coalesce(current_setting('app.current_organization', true), '') = ''
    )
  );

-- Webhook tenant resolution ------------------------------------------------
--
-- A webhook names a provider customer, not an organization, and arrives before
-- any tenant is known, so RLS hides every billing_customers row from it. This
-- function answers exactly one question — which organization owns this
-- customer id — and nothing else: it cannot list customers, read emails or
-- write anything. SECURITY DEFINER runs it as the table owner; the fixed
-- search_path stops a caller from shadowing the table with their own.
CREATE FUNCTION billing_organization_for_customer(p_provider "BillingProviderKind", p_external_customer_id TEXT)
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT c."organizationId"
  FROM "billing_customers" c
  JOIN "organizations" o ON o."id" = c."organizationId" AND o."deletedAt" IS NULL
  WHERE c."provider" = p_provider AND c."externalCustomerId" = p_external_customer_id
$$;

REVOKE ALL ON FUNCTION billing_organization_for_customer("BillingProviderKind", TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_organization_for_customer("BillingProviderKind", TEXT) TO qaflow_app;

-- Backfill -----------------------------------------------------------------
--
-- Until now `organizations.plan` was set by hand. An organization already on a
-- paid plan keeps it: it gets an active mock subscription for one period, so
-- nobody's effective plan changes with this migration. Free organizations get
-- no subscription, which resolves to `free`.
INSERT INTO "subscriptions" (
  "id", "organizationId", "provider", "plan", "status",
  "currentPeriodStart", "currentPeriodEnd", "createdAt", "updatedAt"
)
SELECT
  'backfill_' || o."id", o."id", 'mock', o."plan", 'active',
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "organizations" o
WHERE o."plan" <> 'free' AND o."deletedAt" IS NULL;
