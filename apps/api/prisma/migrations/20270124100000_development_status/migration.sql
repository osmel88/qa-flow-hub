-- S5-F2 Development status.
--
-- The development status of a work item is derived on read from its linked
-- artifacts, so nothing is stored for it. The only change: pull requests may
-- now be `approved`, which the status derivation distinguishes from open and
-- merged. The CHECK is replaced, not weakened: it keeps every other rule.

ALTER TABLE "development_artifacts" DROP CONSTRAINT "development_artifacts_status";
ALTER TABLE "development_artifacts" ADD CONSTRAINT "development_artifacts_status" CHECK (
  "status" IS NULL
  OR ("kind" = 'branch' AND "status" IN ('active', 'merged', 'deleted'))
  OR ("kind" = 'pull_request' AND "status" IN ('draft', 'open', 'approved', 'merged', 'closed'))
  OR ("kind" = 'build' AND "status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
  OR ("kind" = 'deployment' AND "status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'))
);
