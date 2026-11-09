-- Test case versioning (S7-F4). Every content version of a case is an
-- immutable row; executions, results and frozen plan/cycle scope point at the
-- exact row they used.

CREATE TABLE "test_case_versions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "testCaseId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "preconditions" TEXT,
  "expectedResult" TEXT,
  "type" "TestCaseType" NOT NULL,
  "priority" "Priority" NOT NULL,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "parameters" JSONB NOT NULL DEFAULT '[]',
  "dataset" JSONB NOT NULL DEFAULT '[]',
  "changeReason" TEXT,
  "restoredFromVersion" INTEGER,
  "authorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "test_case_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "test_case_versions_version_positive" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "test_case_versions_testCaseId_version_key" ON "test_case_versions"("testCaseId", "version");
CREATE UNIQUE INDEX "test_case_versions_id_testCaseId_key" ON "test_case_versions"("id", "testCaseId");
CREATE INDEX "test_case_versions_organizationId_projectId_idx" ON "test_case_versions"("organizationId", "projectId");

ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_testCaseId_projectId_fkey" FOREIGN KEY ("testCaseId", "projectId") REFERENCES "test_cases"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "test_run_cases" ADD COLUMN "testCaseVersionId" TEXT;
ALTER TABLE "test_results" ADD COLUMN "caseVersion" INTEGER, ADD COLUMN "testCaseVersionId" TEXT;
ALTER TABLE "test_plan_scope_items" ADD COLUMN "testCaseVersionId" TEXT;
ALTER TABLE "test_cycle_scope_items" ADD COLUMN "testCaseVersionId" TEXT;

ALTER TABLE "test_run_cases" ADD CONSTRAINT "test_run_cases_testCaseVersionId_testCaseId_fkey" FOREIGN KEY ("testCaseVersionId", "testCaseId") REFERENCES "test_case_versions"("id", "testCaseId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_testCaseVersionId_fkey" FOREIGN KEY ("testCaseVersionId") REFERENCES "test_case_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "test_plan_scope_items" ADD CONSTRAINT "test_plan_scope_items_testCaseVersionId_testCaseId_fkey" FOREIGN KEY ("testCaseVersionId", "testCaseId") REFERENCES "test_case_versions"("id", "testCaseId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "test_cycle_scope_items" ADD CONSTRAINT "test_cycle_scope_items_testCaseVersionId_testCaseId_fkey" FOREIGN KEY ("testCaseVersionId", "testCaseId") REFERENCES "test_case_versions"("id", "testCaseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "test_case_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_case_versions"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Versions are history: the app can add them, never change or remove them.
REVOKE UPDATE, DELETE ON "test_case_versions" FROM qaflow_app;

-- Returns the version row of (case, version), recording it from the live case
-- when the case is at that version and nobody recorded it yet. `strict` raises
-- when the version cannot be found nor recorded.
CREATE OR REPLACE FUNCTION test_case_version_ensure(case_id TEXT, case_version INTEGER, strict BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  found TEXT;
BEGIN
  SELECT "id" INTO found FROM "test_case_versions"
    WHERE "testCaseId" = case_id AND "version" = case_version;
  IF found IS NOT NULL THEN
    RETURN found;
  END IF;
  INSERT INTO "test_case_versions" (
    "id", "organizationId", "projectId", "testCaseId", "version", "title", "description",
    "preconditions", "expectedResult", "type", "priority", "steps", "parameters", "dataset",
    "authorId"
  )
  SELECT gen_random_uuid()::text, c."organizationId", c."projectId", c."id", c."version",
    c."title", c."description", c."preconditions", c."expectedResult", c."type", c."priority",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'position', s."position", 'action', s."action",
        'expectedResult', s."expectedResult", 'data', s."data") ORDER BY s."position")
      FROM "test_steps" s WHERE s."testCaseId" = c."id"), '[]'::jsonb),
    c."parameters", c."dataset",
    CASE WHEN c."version" = 1 THEN c."createdById" END
  FROM "test_cases" c
  WHERE c."id" = case_id AND c."version" = case_version
  ON CONFLICT ("testCaseId", "version") DO NOTHING
  RETURNING "id" INTO found;
  IF found IS NULL THEN
    SELECT "id" INTO found FROM "test_case_versions"
      WHERE "testCaseId" = case_id AND "version" = case_version;
  END IF;
  IF found IS NULL AND strict THEN
    RAISE EXCEPTION 'test case % has no version %', case_id, case_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN found;
END;
$$;

-- Backfill -------------------------------------------------------------------

-- Older versions that were executed are recovered from the run snapshot,
-- which never stored the description nor the dataset.
INSERT INTO "test_case_versions" (
  "id", "organizationId", "projectId", "testCaseId", "version", "title", "preconditions",
  "expectedResult", "type", "priority", "steps", "parameters", "changeReason", "createdAt"
)
SELECT DISTINCT ON (rc."testCaseId", rc."caseVersion")
  gen_random_uuid()::text, c."organizationId", c."projectId", rc."testCaseId", rc."caseVersion",
  rc."caseSnapshot"->>'title', rc."caseSnapshot"->>'preconditions',
  rc."caseSnapshot"->>'expectedResult', (rc."caseSnapshot"->>'type')::"TestCaseType",
  (rc."caseSnapshot"->>'priority')::"Priority",
  COALESCE(rc."caseSnapshot"->'steps', '[]'::jsonb),
  COALESCE(rc."caseSnapshot"->'parameters', '[]'::jsonb),
  'Recovered from a run snapshot', rc."createdAt"
FROM "test_run_cases" rc
JOIN "test_cases" c ON c."id" = rc."testCaseId"
WHERE rc."caseVersion" <> c."version"
ORDER BY rc."testCaseId", rc."caseVersion", rc."createdAt";

SELECT test_case_version_ensure("id", "version", true) FROM "test_cases";

UPDATE "test_run_cases" rc SET "testCaseVersionId" = v."id"
FROM "test_case_versions" v
WHERE v."testCaseId" = rc."testCaseId" AND v."version" = rc."caseVersion";

UPDATE "test_results" r SET "caseVersion" = rc."caseVersion", "testCaseVersionId" = rc."testCaseVersionId"
FROM "test_run_cases" rc
WHERE rc."id" = r."testRunCaseId";

UPDATE "test_plan_scope_items" si SET "testCaseVersionId" = v."id"
FROM "test_case_versions" v
WHERE v."testCaseId" = si."testCaseId" AND v."version" = si."caseVersion";

UPDATE "test_cycle_scope_items" si SET "testCaseVersionId" = v."id"
FROM "test_case_versions" v
WHERE v."testCaseId" = si."testCaseId" AND v."version" = si."caseVersion";

-- Triggers -------------------------------------------------------------------

-- Any path that creates a case or moves its version (imports, seeds, scripts)
-- ends the transaction with that version recorded.
CREATE OR REPLACE FUNCTION test_cases_version_recorded() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "test_cases" WHERE "id" = NEW."id" AND "version" = NEW."version") THEN
    PERFORM test_case_version_ensure(NEW."id", NEW."version", true);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER test_cases_version_recorded
  AFTER INSERT OR UPDATE OF "version" ON "test_cases"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION test_cases_version_recorded();

-- Executions must name an existing version; frozen scope does when it can.
CREATE OR REPLACE FUNCTION test_run_cases_link_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."testCaseVersionId" IS NULL THEN
    NEW."testCaseVersionId" := test_case_version_ensure(NEW."testCaseId", NEW."caseVersion", true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION scope_items_link_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."testCaseVersionId" IS NULL THEN
    NEW."testCaseVersionId" := test_case_version_ensure(NEW."testCaseId", NEW."caseVersion", false);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION test_results_link_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT "caseVersion", "testCaseVersionId" INTO NEW."caseVersion", NEW."testCaseVersionId"
    FROM "test_run_cases" WHERE "id" = NEW."testRunCaseId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_run_cases_link_version
  BEFORE INSERT ON "test_run_cases"
  FOR EACH ROW EXECUTE FUNCTION test_run_cases_link_version();
CREATE TRIGGER test_plan_scope_items_link_version
  BEFORE INSERT ON "test_plan_scope_items"
  FOR EACH ROW EXECUTE FUNCTION scope_items_link_version();
CREATE TRIGGER test_cycle_scope_items_link_version
  BEFORE INSERT ON "test_cycle_scope_items"
  FOR EACH ROW EXECUTE FUNCTION scope_items_link_version();
CREATE TRIGGER test_results_link_version
  BEFORE INSERT ON "test_results"
  FOR EACH ROW EXECUTE FUNCTION test_results_link_version();

-- The executed version joins the frozen columns of an execution.
CREATE OR REPLACE FUNCTION test_run_cases_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."testRunId" IS DISTINCT FROM OLD."testRunId"
    OR NEW."testCaseId" IS DISTINCT FROM OLD."testCaseId"
    OR NEW."caseSnapshot" IS DISTINCT FROM OLD."caseSnapshot"
    OR NEW."caseVersion" IS DISTINCT FROM OLD."caseVersion"
    OR NEW."iterationKey" IS DISTINCT FROM OLD."iterationKey"
    OR NEW."iterationLabel" IS DISTINCT FROM OLD."iterationLabel"
    OR NEW."iterationIndex" IS DISTINCT FROM OLD."iterationIndex"
    OR NEW."parameterValues" IS DISTINCT FROM OLD."parameterValues"
    OR NEW."testCaseVersionId" IS DISTINCT FROM OLD."testCaseVersionId" THEN
    RAISE EXCEPTION 'test_run_cases: the executed snapshot is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
