-- S5-F5 Deployment.
--
-- A deployment stays the `deployment` development artifact of S5-F1 (one
-- source of truth for links, development status and RLS). This migration
-- adds a minimal per-project `environments` table (no Stage 6 features), the
-- deployment fields (environment, build, rollback of) and the run fields the
-- build already has. Status `in_progress` becomes `deploying`; `cancelled` is
-- new. One live rollback per original deployment (partial unique index).

UPDATE "development_artifacts" SET "status" = 'deploying' WHERE "kind" = 'deployment' AND "status" = 'in_progress';

ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_status";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_status" CHECK (
  "status" IS NULL
  OR ("kind" = 'branch' AND "status" IN ('active', 'merged', 'deleted'))
  OR ("kind" = 'pull_request' AND "status" IN ('draft', 'open', 'approved', 'merged', 'closed'))
  OR ("kind" = 'build' AND "status" IN ('queued', 'running', 'passed', 'failed', 'cancelled'))
  OR ("kind" = 'deployment' AND "status" IN ('pending', 'deploying', 'succeeded', 'failed', 'rolled_back', 'cancelled'))
);

CREATE TABLE "environments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "environments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "environments_kind" CHECK ("kind" IN ('development', 'testing', 'staging', 'production', 'other'))
);
CREATE UNIQUE INDEX "environments_id_projectId_key" ON "environments"("id", "projectId");
CREATE INDEX "environments_organizationId_projectId_idx" ON "environments"("organizationId", "projectId");
CREATE UNIQUE INDEX "environments_live_name" ON "environments"("projectId", lower("name")) WHERE "deletedAt" IS NULL;
ALTER TABLE "environments" ADD CONSTRAINT "environments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "environments" ADD CONSTRAINT "environments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "environments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "environments"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE DELETE ON "environments" FROM qaflow_app;

ALTER TABLE "development_artifacts"
  ADD COLUMN "environmentId" TEXT,
  ADD COLUMN "buildId" TEXT,
  ADD COLUMN "rollbackOfId" TEXT,
  ADD COLUMN "actorId" TEXT;

-- Run fields are shared by builds and deployments now.
ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_build_fields";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_run_fields" CHECK (
  "kind" IN ('build', 'deployment')
  OR ("startedAt" IS NULL AND "finishedAt" IS NULL AND "trigger" IS NULL AND "releaseId" IS NULL
      AND "metadata" IS NULL AND "logSummary" IS NULL)
);
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_deployment_fields" CHECK (
  "kind" = 'deployment'
  OR ("environmentId" IS NULL AND "buildId" IS NULL AND "rollbackOfId" IS NULL AND "actorId" IS NULL)
);
-- Triggers are checked per kind: deployments add `pipeline` and `rollback`.
ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_build_trigger";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_trigger" CHECK (
  "trigger" IS NULL
  OR ("kind" = 'build' AND "trigger" IN ('push', 'pull_request', 'manual', 'schedule', 'api', 'other'))
  OR ("kind" = 'deployment' AND "trigger" IN ('manual', 'pipeline', 'schedule', 'api', 'rollback', 'other'))
);
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_not_own_rollback" CHECK ("rollbackOfId" IS NULL OR "rollbackOfId" <> "id");

CREATE INDEX "development_artifacts_environmentId_idx" ON "development_artifacts"("environmentId");
CREATE INDEX "development_artifacts_buildId_idx" ON "development_artifacts"("buildId");
CREATE UNIQUE INDEX "development_artifacts_live_rollback" ON "development_artifacts"("rollbackOfId") WHERE "deletedAt" IS NULL AND "rollbackOfId" IS NOT NULL;

-- Environment, build and original deployment must be of the same project.
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_buildId_projectId_fkey" FOREIGN KEY ("buildId", "projectId") REFERENCES "development_artifacts"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_rollbackOfId_projectId_fkey" FOREIGN KEY ("rollbackOfId", "projectId") REFERENCES "development_artifacts"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
