-- Webhooks are not ordered: remember the newest provider event applied to each
-- invoice so an older snapshot cannot undo a newer one (same rule as
-- subscriptions.lastEventAt). Additive and nullable: no backfill needed.
ALTER TABLE "invoices" ADD COLUMN "lastEventAt" TIMESTAMP(3);
