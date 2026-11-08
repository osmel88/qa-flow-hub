-- S6-F5 Rollback.
--
-- Additive only. A rollback stays a new `deployment` row (trigger
-- `rollback`, rollbackOfId = the deployment it replaced); it now also records
-- the earlier deployment it went back to, the mandatory reason and whether
-- it was an emergency rollback that skipped gates and approvals. The target
-- foreign key carries projectId, so a target of another project or tenant is
-- refused by the database. Environments get a rollback check policy.

ALTER TABLE "development_artifacts"
  ADD COLUMN "rollbackTargetId" TEXT,
  ADD COLUMN "rollbackReason" TEXT,
  ADD COLUMN "rollbackEmergency" BOOLEAN;

ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_deployment_fields";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_deployment_fields" CHECK (
  "kind" = 'deployment'
  OR ("environmentId" IS NULL AND "buildId" IS NULL AND "rollbackOfId" IS NULL AND "actorId" IS NULL
      AND "rollbackTargetId" IS NULL AND "rollbackReason" IS NULL AND "rollbackEmergency" IS NULL)
);
-- Only a rollback points to a target, and never to itself.
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_rollback_target" CHECK (
  "rollbackTargetId" IS NULL OR ("rollbackOfId" IS NOT NULL AND "rollbackTargetId" <> "id")
);

CREATE INDEX "development_artifacts_rollbackTargetId_idx" ON "development_artifacts"("rollbackTargetId");
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_rollbackTargetId_projectId_fkey" FOREIGN KEY ("rollbackTargetId", "projectId") REFERENCES "development_artifacts"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "environments" ADD COLUMN "rollbackChecks" TEXT NOT NULL DEFAULT 'enforce';
ALTER TABLE "environments" ADD CONSTRAINT "environments_rollback_checks" CHECK ("rollbackChecks" IN ('enforce', 'skip'));
