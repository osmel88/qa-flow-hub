-- S3-F5: notification outbox. The ledger becomes the queue: a row keeps the
-- template variables it was rendered from until it is delivered or skipped,
-- a lease stops two workers (or a worker and the request) from sending it
-- twice, and `nextAttemptAt` schedules the retry with backoff.

-- Not used in this transaction, so adding the value here is allowed.
ALTER TYPE "NotificationType" ADD VALUE 'test_run_failed';

ALTER TABLE "notifications"
  ADD COLUMN "payload" JSONB,
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "notifications_status_nextAttemptAt_idx" ON "notifications"("status", "nextAttemptAt");

-- The worker serves every organization, but RLS hides each tenant's rows
-- from the others. This is the only path that crosses tenants: it leases due
-- rows and returns their id and organization, nothing else. Sending happens
-- afterwards, under RLS, inside the row's own organization.
CREATE FUNCTION claim_notification_deliveries(p_batch INTEGER, p_lease_seconds INTEGER)
  RETURNS TABLE (id TEXT, "organizationId" TEXT)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  UPDATE "notifications" n
  SET "leaseUntil" = now() + make_interval(secs => p_lease_seconds)
  WHERE n."id" IN (
    SELECT c."id"
    FROM "notifications" c
    LEFT JOIN "organizations" o ON o."id" = c."organizationId"
    WHERE c."payload" IS NOT NULL
      AND (c."organizationId" IS NULL OR o."deletedAt" IS NULL)
      AND (c."leaseUntil" IS NULL OR c."leaseUntil" < now())
      AND (
        c."status" = 'pending'
        OR (c."status" = 'failed' AND c."nextAttemptAt" IS NOT NULL AND c."nextAttemptAt" <= now())
      )
    ORDER BY coalesce(c."nextAttemptAt", c."createdAt") ASC, c."id" ASC
    LIMIT greatest(p_batch, 0)
    FOR UPDATE OF c SKIP LOCKED
  )
  RETURNING n."id", n."organizationId"
$$;

REVOKE ALL ON FUNCTION claim_notification_deliveries(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_notification_deliveries(INTEGER, INTEGER) TO qaflow_app;
