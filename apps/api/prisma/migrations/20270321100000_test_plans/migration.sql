-- S7-F1 Test plans.
--
-- Additive only. `test_plans` is the planning layer above suites and runs.
-- Join tables hold its environments, suites, direct cases and runs; every
-- foreign key carries projectId, so a suite, case, run, release or
-- environment of another project or tenant is refused by the database.
-- `test_plan_scope_items` is the frozen scope: one row per case and scope
-- version, written when the plan starts (or its scope is refreshed) and
-- never edited, so the plan keeps its history when suites or cases change.

CREATE UNIQUE INDEX "test_suites_id_projectId_key" ON "test_suites"("id", "projectId");
CREATE UNIQUE INDEX "test_cases_id_projectId_key" ON "test_cases"("id", "projectId");
CREATE UNIQUE INDEX "test_runs_id_projectId_key" ON "test_runs"("id", "projectId");

CREATE TABLE "test_plans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ownerId" TEXT,
    "releaseId" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "scopeVersion" INTEGER NOT NULL DEFAULT 0,
    "frozenAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_plans_status" CHECK ("status" IN ('draft', 'active', 'completed', 'cancelled', 'archived')),
    CONSTRAINT "test_plans_dates" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate"),
    CONSTRAINT "test_plans_frozen" CHECK (("scopeVersion" = 0) = ("frozenAt" IS NULL))
);

CREATE TABLE "test_plan_environments" (
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "test_plan_environments_pkey" PRIMARY KEY ("planId", "environmentId")
);

CREATE TABLE "test_plan_suites" (
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    CONSTRAINT "test_plan_suites_pkey" PRIMARY KEY ("planId", "suiteId")
);

CREATE TABLE "test_plan_cases" (
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    CONSTRAINT "test_plan_cases_pkey" PRIMARY KEY ("planId", "testCaseId")
);

CREATE TABLE "test_plan_runs" (
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_plan_runs_pkey" PRIMARY KEY ("planId", "testRunId")
);

CREATE TABLE "test_plan_scope_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "scopeVersion" INTEGER NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "caseTitle" TEXT NOT NULL,
    "caseVersion" INTEGER NOT NULL,
    "suiteId" TEXT,
    "suiteName" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_plan_scope_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_plan_scope_items_source" CHECK ("source" IN ('direct', 'suite'))
);

CREATE UNIQUE INDEX "test_plans_id_projectId_key" ON "test_plans"("id", "projectId");
CREATE UNIQUE INDEX "test_plans_live_name" ON "test_plans"("projectId", lower("name"));
CREATE INDEX "test_plans_organizationId_projectId_status_idx" ON "test_plans"("organizationId", "projectId", "status");
CREATE INDEX "test_plans_releaseId_idx" ON "test_plans"("releaseId");
CREATE INDEX "test_plans_ownerId_idx" ON "test_plans"("ownerId");
CREATE INDEX "test_plan_environments_environmentId_idx" ON "test_plan_environments"("environmentId");
CREATE INDEX "test_plan_suites_suiteId_idx" ON "test_plan_suites"("suiteId");
CREATE INDEX "test_plan_cases_testCaseId_idx" ON "test_plan_cases"("testCaseId");
-- A run executes at most one plan.
CREATE UNIQUE INDEX "test_plan_runs_testRunId_key" ON "test_plan_runs"("testRunId");
CREATE UNIQUE INDEX "test_plan_scope_items_planId_scopeVersion_testCaseId_key" ON "test_plan_scope_items"("planId", "scopeVersion", "testCaseId");
CREATE INDEX "test_plan_scope_items_testCaseId_idx" ON "test_plan_scope_items"("testCaseId");

ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "test_plan_environments" ADD CONSTRAINT "test_plan_environments_planId_projectId_fkey" FOREIGN KEY ("planId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_environments" ADD CONSTRAINT "test_plan_environments_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_suites" ADD CONSTRAINT "test_plan_suites_planId_projectId_fkey" FOREIGN KEY ("planId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_suites" ADD CONSTRAINT "test_plan_suites_suiteId_projectId_fkey" FOREIGN KEY ("suiteId", "projectId") REFERENCES "test_suites"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_cases" ADD CONSTRAINT "test_plan_cases_planId_projectId_fkey" FOREIGN KEY ("planId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_cases" ADD CONSTRAINT "test_plan_cases_testCaseId_projectId_fkey" FOREIGN KEY ("testCaseId", "projectId") REFERENCES "test_cases"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_runs" ADD CONSTRAINT "test_plan_runs_planId_projectId_fkey" FOREIGN KEY ("planId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_runs" ADD CONSTRAINT "test_plan_runs_testRunId_projectId_fkey" FOREIGN KEY ("testRunId", "projectId") REFERENCES "test_runs"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_scope_items" ADD CONSTRAINT "test_plan_scope_items_planId_projectId_fkey" FOREIGN KEY ("planId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_plan_scope_items" ADD CONSTRAINT "test_plan_scope_items_testCaseId_projectId_fkey" FOREIGN KEY ("testCaseId", "projectId") REFERENCES "test_cases"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "test_plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plans"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_plan_environments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plan_environments"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_plan_suites" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plan_suites"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_plan_cases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plan_cases"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_plan_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plan_runs"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_plan_scope_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_plan_scope_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Plans are archived, never deleted; frozen scope is append-only.
REVOKE DELETE ON "test_plans" FROM qaflow_app;
REVOKE UPDATE, DELETE ON "test_plan_scope_items" FROM qaflow_app;
