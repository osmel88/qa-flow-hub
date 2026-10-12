-- S3-F1 Import & Export.
--
-- One organization-scoped table that stores each import dry run and its commit.
-- Additive only: no existing table changes. The uploaded file is never stored;
-- the row keeps its name, size and SHA-256, the report and the normalized plan.

-- CreateEnum
CREATE TYPE "ImportFormat" AS ENUM ('qaflow_csv', 'testrail_csv');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('ready', 'invalid', 'committed', 'expired');

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT,
    "format" "ImportFormat" NOT NULL,
    "status" "ImportJobStatus" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "targetSuiteId" TEXT,
    "targetSuiteName" TEXT,
    "summary" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "issueCount" INTEGER NOT NULL,
    "plan" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_organizationId_projectId_createdAt_idx" ON "import_jobs"("organizationId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "import_jobs_projectId_status_idx" ON "import_jobs"("projectId", "status");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Row Level Security ---------------------------------------------------------

ALTER TABLE "import_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "import_jobs"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- The default privileges grant DELETE on every new table. Jobs are history:
-- expiry clears the plan and flips the status, it never removes the row.
REVOKE DELETE ON "import_jobs" FROM qaflow_app;
