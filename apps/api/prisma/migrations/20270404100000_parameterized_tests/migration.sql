-- Parameterized test cases (S7-F3). The definition lives on the case and is
-- versioned with it; a run expands one execution per dataset row and freezes
-- the values it ran with.

ALTER TABLE "test_cases"
  ADD COLUMN "parameters" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "dataset" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "test_run_cases"
  ADD COLUMN "iterationKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "iterationLabel" TEXT,
  ADD COLUMN "iterationIndex" INTEGER,
  ADD COLUMN "parameterValues" JSONB,
  ADD CONSTRAINT "test_run_cases_iteration"
    CHECK (("iterationKey" = '') = ("parameterValues" IS NULL));

-- A case appears once per dataset row instead of once per run.
CREATE UNIQUE INDEX "test_run_cases_testRunId_testCaseId_iterationKey_key"
  ON "test_run_cases"("testRunId", "testCaseId", "iterationKey");
DROP INDEX "test_run_cases_testRunId_testCaseId_key";

-- What was executed is history: neither the case snapshot nor the dataset row
-- of an execution can change once the run included it, from any code path.
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
    OR NEW."parameterValues" IS DISTINCT FROM OLD."parameterValues" THEN
    RAISE EXCEPTION 'test_run_cases: the executed snapshot is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_run_cases_snapshot_frozen
  BEFORE UPDATE ON "test_run_cases"
  FOR EACH ROW EXECUTE FUNCTION test_run_cases_frozen();
