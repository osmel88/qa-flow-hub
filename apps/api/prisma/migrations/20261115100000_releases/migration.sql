-- S3-F4 Releases.
--
-- Additive only. `releases` is a version a project ships; `test_runs.releaseId`
-- points at one. The foreign key is composite, (releaseId, projectId) →
-- releases(id, projectId), so a run can never reference a release of another
-- project (and therefore of another organization), whatever the API does.
-- Releases are never deleted: archiving one keeps every run and result.

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('planned', 'in_progress', 'released', 'archived');

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "releaseId" TEXT;

-- CreateTable
CREATE TABLE "releases" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "tag" TEXT,
    "description" TEXT,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'planned',
    "startDate" DATE,
    "targetDate" DATE,
    "releasedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "releases_organizationId_projectId_status_idx" ON "releases"("organizationId", "projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "releases_projectId_version_key" ON "releases"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "releases_id_projectId_key" ON "releases"("id", "projectId");

-- CreateIndex
CREATE INDEX "test_runs_releaseId_idx" ON "test_runs"("releaseId");

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "releases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "releases"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- History is archived, not deleted.
REVOKE DELETE ON "releases" FROM qaflow_app;
