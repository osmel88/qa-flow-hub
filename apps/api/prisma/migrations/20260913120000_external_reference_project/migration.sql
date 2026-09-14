-- S2-F5: a reference remembers the project of its entity, so the external
-- traceability view can list a project's references in one query and still
-- show the ones whose entity was deleted. Backfilled from the entity tables;
-- nothing provider-specific is added.
ALTER TABLE "external_references" ADD COLUMN "projectId" TEXT;

UPDATE "external_references" r SET "projectId" = e."projectId"
  FROM "requirements" e WHERE r."entityType" = 'requirement' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = e."projectId"
  FROM "defects" e WHERE r."entityType" = 'defect' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = e."projectId"
  FROM "test_suites" e WHERE r."entityType" = 'test_suite' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = e."projectId"
  FROM "test_cases" e WHERE r."entityType" = 'test_case' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = e."projectId"
  FROM "test_runs" e WHERE r."entityType" = 'test_run' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = run."projectId"
  FROM "test_results" e JOIN "test_runs" run ON run."id" = e."testRunId"
  WHERE r."entityType" = 'test_result' AND r."entityId" = e."id";
UPDATE "external_references" r SET "projectId" = r."entityId"
  WHERE r."entityType" = 'project';

CREATE INDEX "external_references_organizationId_projectId_provider_idx"
  ON "external_references"("organizationId", "projectId", "provider");
