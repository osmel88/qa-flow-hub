-- S4-F1 Work items.
--
-- Additive only. `work_items` is the backlog of a project. `parentId` and
-- `releaseId` use composite foreign keys, (x, projectId) → (id, projectId), so
-- an item can never hang from an item or a release of another project (and
-- therefore of another organization), whatever the API does. Items are soft
-- deleted; the app role has no DELETE.

-- CreateEnum
CREATE TYPE "WorkItemType" AS ENUM ('epic', 'feature', 'story', 'task', 'bug', 'improvement', 'spike');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "workItemCounter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "work_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "WorkItemType" NOT NULL DEFAULT 'story',
    "status" "WorkItemStatus" NOT NULL DEFAULT 'backlog',
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "estimate" DOUBLE PRECISION,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parentId" TEXT,
    "releaseId" TEXT,
    "assigneeId" TEXT,
    "reporterId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_items_organizationId_projectId_status_idx" ON "work_items"("organizationId", "projectId", "status");

-- CreateIndex
CREATE INDEX "work_items_organizationId_assigneeId_status_idx" ON "work_items"("organizationId", "assigneeId", "status");

-- CreateIndex
CREATE INDEX "work_items_parentId_idx" ON "work_items"("parentId");

-- CreateIndex
CREATE INDEX "work_items_releaseId_idx" ON "work_items"("releaseId");

-- CreateIndex
CREATE INDEX "work_items_labels_idx" ON "work_items" USING GIN ("labels");

-- CreateIndex
CREATE UNIQUE INDEX "work_items_organizationId_projectId_key_key" ON "work_items"("organizationId", "projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "work_items_id_projectId_key" ON "work_items"("id", "projectId");

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_parentId_projectId_fkey" FOREIGN KEY ("parentId", "projectId") REFERENCES "work_items"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invariants the service also checks; the database keeps raw writers honest.
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_estimate_range" CHECK ("estimate" IS NULL OR ("estimate" >= 0 AND "estimate" <= 1000));
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_labels_bounded" CHECK ("labels" IS NULL OR cardinality("labels") <= 20);
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "work_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "work_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Deleting is logical (deletedAt); history is never removed by the app.
REVOKE DELETE ON "work_items" FROM qaflow_app;
