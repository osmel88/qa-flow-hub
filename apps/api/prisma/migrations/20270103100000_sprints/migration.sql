-- S4-F5 Sprints.
--
-- Additive only. `sprints` are time boxes of a project's backlog and
-- `work_items.sprintId` plans an item into one. The composite foreign key
-- (sprintId, projectId) → sprints(id, projectId) refuses a sprint of another
-- project or tenant. A partial unique index keeps at most one active sprint
-- per project, whatever the API does. Sprints are never deleted (cancel).

-- CreateEnum
CREATE TYPE "SprintStatus" AS ENUM ('planned', 'active', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "sprints" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "status" "SprintStatus" NOT NULL DEFAULT 'planned',
    "startDate" DATE,
    "endDate" DATE,
    "capacity" DOUBLE PRECISION,
    "committedEstimate" DOUBLE PRECISION,
    "completedEstimate" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sprints_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "work_items" ADD COLUMN "sprintId" TEXT;

-- CreateIndex
CREATE INDEX "sprints_organizationId_projectId_status_idx" ON "sprints"("organizationId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sprints_id_projectId_key" ON "sprints"("id", "projectId");

-- CreateIndex
CREATE INDEX "work_items_sprintId_idx" ON "work_items"("sprintId");

-- One active sprint per project.
CREATE UNIQUE INDEX "sprints_one_active_per_project" ON "sprints"("projectId") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_sprintId_projectId_fkey" FOREIGN KEY ("sprintId", "projectId") REFERENCES "sprints"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Invariants the service also checks.
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_dates_in_order" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_capacity_range" CHECK ("capacity" IS NULL OR ("capacity" >= 0 AND "capacity" <= 10000));

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sprints"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

REVOKE DELETE ON "sprints" FROM qaflow_app;
