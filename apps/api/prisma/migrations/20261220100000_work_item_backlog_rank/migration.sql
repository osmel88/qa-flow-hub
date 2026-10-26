-- S4-F2 Backlog.
--
-- Additive only. `rank` is the position of a work item in its project's
-- backlog, ascending, in steps of 1024 so that moving an item rewrites a single
-- row. Existing items are ranked by creation order.

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN     "rank" INTEGER NOT NULL DEFAULT 0;

-- Backfill: oldest first, per project.
UPDATE "work_items" AS w
SET "rank" = ranked.position * 1024
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt", "id") AS position
  FROM "work_items"
) AS ranked
WHERE w."id" = ranked."id";

-- CreateIndex
CREATE INDEX "work_items_organizationId_projectId_rank_idx" ON "work_items"("organizationId", "projectId", "rank");
