-- S3-F7 Custom fields and the configurable defect workflow.
--
-- Additive only. Values live in a `customFields` JSONB column of each entity,
-- keyed by definition id, so they are written in the same row — and the same
-- transaction — as the entity. Definitions are archived, never deleted.

-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('requirement', 'test_case', 'defect');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'boolean', 'date', 'select', 'multi_select');

-- AlterTable
ALTER TABLE "requirements" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "test_cases" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "defects" ADD COLUMN     "customFields" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "CustomFieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defect_workflows" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "transitions" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "defect_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_field_definitions_organizationId_projectId_entityTyp_idx" ON "custom_field_definitions"("organizationId", "projectId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_projectId_entityType_key_key" ON "custom_field_definitions"("projectId", "entityType", "key");

-- CreateIndex
CREATE UNIQUE INDEX "defect_workflows_projectId_key" ON "defect_workflows"("projectId");

-- CreateIndex
CREATE INDEX "defect_workflows_organizationId_idx" ON "defect_workflows"("organizationId");

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defect_workflows" ADD CONSTRAINT "defect_workflows_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defect_workflows" ADD CONSTRAINT "defect_workflows_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Values must be JSON objects; anything else is a bug in the writer.
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_customFields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_customFields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "defects" ADD CONSTRAINT "defects_customFields_object" CHECK (jsonb_typeof("customFields") = 'object');
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_options_array" CHECK (jsonb_typeof("options") = 'array');
ALTER TABLE "defect_workflows" ADD CONSTRAINT "defect_workflows_transitions_array" CHECK (jsonb_typeof("transitions") = 'array');

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "custom_field_definitions"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

ALTER TABLE "defect_workflows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "defect_workflows"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Definitions are archived, not deleted; a workflow is replaced, not deleted.
REVOKE DELETE ON "custom_field_definitions" FROM qaflow_app;
REVOKE DELETE ON "defect_workflows" FROM qaflow_app;
