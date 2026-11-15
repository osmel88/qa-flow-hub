-- S7-F6 Flaky test detection.
--
-- Additive only. The detected status of a test case is derived on read from
-- its recent results, so nothing derived is stored. This migration adds the
-- append-only record of manual marks (confirm / dismiss / clear) and an index
-- that serves the per-case window over executions.

CREATE TABLE "test_case_flaky_marks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "markedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_case_flaky_marks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_case_flaky_marks_state" CHECK ("state" IN ('flaky', 'not_flaky', 'cleared'))
);

CREATE INDEX "test_case_flaky_marks_organizationId_projectId_testCaseId_c_idx"
  ON "test_case_flaky_marks"("organizationId", "projectId", "testCaseId", "createdAt");

ALTER TABLE "test_case_flaky_marks" ADD CONSTRAINT "test_case_flaky_marks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_case_flaky_marks" ADD CONSTRAINT "test_case_flaky_marks_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The case must be of the same project: a cross-project mark cannot exist.
ALTER TABLE "test_case_flaky_marks" ADD CONSTRAINT "test_case_flaky_marks_testCaseId_projectId_fkey"
  FOREIGN KEY ("testCaseId", "projectId") REFERENCES "test_cases"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_case_flaky_marks" ADD CONSTRAINT "test_case_flaky_marks_markedById_fkey"
  FOREIGN KEY ("markedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Executions of one case across runs, newest first (the detection window).
CREATE INDEX "test_run_cases_organizationId_testCaseId_idx"
  ON "test_run_cases"("organizationId", "testCaseId");

ALTER TABLE "test_case_flaky_marks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_case_flaky_marks"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Marks are history: the app may add them, never rewrite or delete them.
REVOKE UPDATE, DELETE ON "test_case_flaky_marks" FROM qaflow_app;
