-- S6-F1 — Environment becomes a full per-project entity. The minimal table of
-- S5-F5 is migrated in place, so every existing deployment keeps its
-- environment: kinds `testing` → `qa` and `other` → `custom`, production is
-- protected, and the order follows creation.

ALTER TABLE "environments" DROP CONSTRAINT "environments_kind";

ALTER TABLE "environments"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "url" TEXT,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "environments" ALTER COLUMN "kind" SET DEFAULT 'custom';

-- backfill:start
UPDATE "environments" SET "kind" = 'qa' WHERE "kind" = 'testing';
UPDATE "environments" SET "kind" = 'custom' WHERE "kind" = 'other';
UPDATE "environments" SET "protected" = true WHERE "kind" = 'production';
UPDATE "environments" AS e
SET "position" = ranked."rank"
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "projectId" ORDER BY "createdAt", "id") - 1)::int AS "rank"
  FROM "environments"
) AS ranked
WHERE e."id" = ranked."id";
-- backfill:end

ALTER TABLE "environments" ADD CONSTRAINT "environments_kind"
  CHECK ("kind" IN ('development', 'qa', 'staging', 'production', 'custom'));
ALTER TABLE "environments" ADD CONSTRAINT "environments_status"
  CHECK ("status" IN ('active', 'inactive', 'archived'));
ALTER TABLE "environments" ADD CONSTRAINT "environments_archived_at"
  CHECK (("status" = 'archived') = ("archivedAt" IS NOT NULL));
ALTER TABLE "environments" ADD CONSTRAINT "environments_position"
  CHECK ("position" >= 0 AND "position" <= 999);
ALTER TABLE "environments" ADD CONSTRAINT "environments_url"
  CHECK ("url" IS NULL OR "url" ~* '^https?://');

CREATE INDEX "environments_projectId_status_position_idx"
  ON "environments"("projectId", "status", "position");
