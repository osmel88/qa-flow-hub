-- S4-F4 Requirement ↔ Work Item.
--
-- Additive only. A work item `implements` a requirement. Both foreign keys
-- carry projectId, so a link across projects or tenants is refused by the
-- database itself; requirements gain the (id, projectId) unique key they need
-- as a target. Unlinking deletes the row (links have no history of their own;
-- link and unlink are in the audit log).

-- CreateEnum
CREATE TYPE "RequirementLinkType" AS ENUM ('implements');

-- CreateTable
CREATE TABLE "requirement_work_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "linkType" "RequirementLinkType" NOT NULL DEFAULT 'implements',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_work_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_work_items_organizationId_projectId_idx" ON "requirement_work_items"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "requirement_work_items_workItemId_idx" ON "requirement_work_items"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_work_items_requirementId_workItemId_linkType_key" ON "requirement_work_items"("requirementId", "workItemId", "linkType");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_id_projectId_key" ON "requirements"("id", "projectId");

-- AddForeignKey
ALTER TABLE "requirement_work_items" ADD CONSTRAINT "requirement_work_items_requirementId_projectId_fkey" FOREIGN KEY ("requirementId", "projectId") REFERENCES "requirements"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_work_items" ADD CONSTRAINT "requirement_work_items_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "work_items"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------
ALTER TABLE "requirement_work_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "requirement_work_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
