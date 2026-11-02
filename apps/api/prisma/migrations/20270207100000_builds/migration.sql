-- S5-F4 Build.
--
-- A build stays the `build` development artifact of S5-F1 (one source of
-- truth for links, development status and RLS); this migration gives it the
-- fields of a CI run. Build-only columns must stay null on other kinds. The
-- build status `succeeded` becomes `passed`; deployments keep `succeeded`.

UPDATE "development_artifacts" SET "status" = 'passed' WHERE "kind" = 'build' AND "status" = 'succeeded';

ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_status";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_status" CHECK (
  "status" IS NULL
  OR ("kind" = 'branch' AND "status" IN ('active', 'merged', 'deleted'))
  OR ("kind" = 'pull_request' AND "status" IN ('draft', 'open', 'approved', 'merged', 'closed'))
  OR ("kind" = 'build' AND "status" IN ('queued', 'running', 'passed', 'failed', 'cancelled'))
  OR ("kind" = 'deployment' AND "status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'))
);

ALTER TABLE "development_artifacts"
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "trigger" TEXT,
  ADD COLUMN "releaseId" TEXT,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "logSummary" TEXT;

ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_build_fields" CHECK (
  "kind" = 'build'
  OR ("startedAt" IS NULL AND "finishedAt" IS NULL AND "trigger" IS NULL AND "releaseId" IS NULL
      AND "metadata" IS NULL AND "logSummary" IS NULL)
);
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_build_times" CHECK (
  "startedAt" IS NULL OR "finishedAt" IS NULL OR "finishedAt" >= "startedAt"
);
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_build_trigger" CHECK (
  "trigger" IS NULL OR "trigger" IN ('push', 'pull_request', 'manual', 'schedule', 'api', 'other')
);

CREATE INDEX "development_artifacts_organizationId_projectId_releaseId_idx" ON "development_artifacts"("organizationId", "projectId", "releaseId");

-- The release must be of the same project.
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
