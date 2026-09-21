-- Email notifications (S2-F6).
--
-- `notifications` is the delivery ledger: one row per message the product
-- decided to send or to skip, without the rendered body (it may carry a
-- one-time link). `notification_preferences` is per user, not per tenant.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('organization_invitation', 'password_changed', 'test_run_assignment', 'defect_assignment', 'defect_status_changed');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'email',
    "templateKey" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
    "dedupeKey" TEXT NOT NULL,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attemptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "skipReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "testRunAssignments" BOOLEAN NOT NULL DEFAULT true,
    "defectAssignments" BOOLEAN NOT NULL DEFAULT true,
    "statusChanges" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_organizationId_createdAt_idx" ON "notifications"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organizationId_recipientUserId_createdAt_idx" ON "notifications"("organizationId", "recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organizationId_type_status_idx" ON "notifications"("organizationId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_key" ON "notification_preferences"("userId");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row Level Security, with the audit-log shape plus one clause: an
-- account-level message (password changed) has no organization, must be
-- insertable without one, must stay invisible to every tenant, and — unlike an
-- audit entry — is updated afterwards with its delivery status. Those rows are
-- therefore visible only when no tenant is set (the transaction-local setting
-- reads back as NULL or '' depending on whether the connection ever set it).
-- `notification_preferences` is left without RLS on purpose, like `users`: it
-- is read before an organization is chosen and belongs to the person.
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (
    "organizationId" = current_setting('app.current_organization', true)
    OR (
      "organizationId" IS NULL
      AND coalesce(current_setting('app.current_organization', true), '') = ''
    )
  )
  WITH CHECK (
    "organizationId" IS NULL
    OR "organizationId" = current_setting('app.current_organization', true)
  );
