-- S4-F7 Kanban.
--
-- Additive only. `kanban_column_settings` holds the WIP limit of a status
-- column of a project's Kanban board. `work_items.startedAt` and
-- `statusChangedAt` feed cycle time, aging and time in status; a trigger keeps
-- them in step with `status` whatever code path writes it.

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN "startedAt" TIMESTAMP(3),
ADD COLUMN "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: the last update approximates the last status change; only items in
-- progress get a start (done items without one stay out of cycle time).
UPDATE "work_items"
SET "statusChangedAt" = "updatedAt",
    "startedAt" = CASE WHEN "status" IN ('in_progress', 'blocked', 'in_review') THEN "updatedAt" ELSE NULL END;

-- CreateTable
CREATE TABLE "kanban_column_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "WorkItemStatus" NOT NULL,
    "wipLimit" INTEGER,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_column_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kanban_column_settings_organizationId_projectId_idx" ON "kanban_column_settings"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_column_settings_projectId_status_key" ON "kanban_column_settings"("projectId", "status");

-- AddForeignKey
ALTER TABLE "kanban_column_settings" ADD CONSTRAINT "kanban_column_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_column_settings" ADD CONSTRAINT "kanban_column_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariants the service also checks.
ALTER TABLE "kanban_column_settings" ADD CONSTRAINT "kanban_column_settings_wip_range" CHECK ("wipLimit" IS NULL OR ("wipLimit" >= 1 AND "wipLimit" <= 999));
ALTER TABLE "kanban_column_settings" ADD CONSTRAINT "kanban_column_settings_board_status" CHECK ("status" NOT IN ('done', 'cancelled'));

-- Status timestamps -----------------------------------------------------------

CREATE OR REPLACE FUNCTION work_items_track_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."statusChangedAt" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    IF NEW."status" IN ('backlog', 'ready') THEN
      NEW."startedAt" := NULL;
    ELSIF NEW."startedAt" IS NULL AND NEW."status" <> 'cancelled' THEN
      NEW."startedAt" := NEW."statusChangedAt";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER work_items_track_status
  BEFORE INSERT OR UPDATE ON "work_items"
  FOR EACH ROW EXECUTE FUNCTION work_items_track_status();

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "kanban_column_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "kanban_column_settings"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

REVOKE DELETE ON "kanban_column_settings" FROM qaflow_app;
