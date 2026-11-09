-- S7-F2 Test cycles.
--
-- Additive only. A cycle is a planned execution inside a test plan, for an
-- optional environment and release. Starting it copies the plan's scope into
-- `test_cycle_scope_items` (append-only), so later plan changes never alter
-- it. Every foreign key carries projectId; a run belongs to at most one cycle.

CREATE TABLE "test_cycles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testPlanId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "ownerId" TEXT,
    "environmentId" TEXT,
    "releaseId" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "frozenAt" TIMESTAMP(3),
    "planScopeVersion" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "test_cycles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_cycles_status" CHECK ("status" IN ('planned', 'active', 'completed', 'cancelled', 'archived')),
    CONSTRAINT "test_cycles_dates" CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate"),
    CONSTRAINT "test_cycles_frozen" CHECK (("frozenAt" IS NULL) = ("planScopeVersion" IS NULL))
);

CREATE TABLE "test_cycle_runs" (
    "cycleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_cycle_runs_pkey" PRIMARY KEY ("cycleId", "testRunId")
);

CREATE TABLE "test_cycle_scope_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "caseTitle" TEXT NOT NULL,
    "caseVersion" INTEGER NOT NULL,
    "suiteId" TEXT,
    "suiteName" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_cycle_scope_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_cycle_scope_items_source" CHECK ("source" IN ('direct', 'suite'))
);

CREATE UNIQUE INDEX "test_cycles_id_projectId_key" ON "test_cycles"("id", "projectId");
CREATE UNIQUE INDEX "test_cycles_live_name" ON "test_cycles"("testPlanId", lower("name"));
CREATE INDEX "test_cycles_organizationId_projectId_status_idx" ON "test_cycles"("organizationId", "projectId", "status");
CREATE INDEX "test_cycles_testPlanId_idx" ON "test_cycles"("testPlanId");
CREATE UNIQUE INDEX "test_cycle_runs_testRunId_key" ON "test_cycle_runs"("testRunId");
CREATE UNIQUE INDEX "test_cycle_scope_items_cycleId_testCaseId_key" ON "test_cycle_scope_items"("cycleId", "testCaseId");
CREATE INDEX "test_cycle_scope_items_testCaseId_idx" ON "test_cycle_scope_items"("testCaseId");

ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_testPlanId_projectId_fkey" FOREIGN KEY ("testPlanId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "test_cycles" ADD CONSTRAINT "test_cycles_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "test_cycle_runs" ADD CONSTRAINT "test_cycle_runs_cycleId_projectId_fkey" FOREIGN KEY ("cycleId", "projectId") REFERENCES "test_cycles"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycle_runs" ADD CONSTRAINT "test_cycle_runs_testRunId_projectId_fkey" FOREIGN KEY ("testRunId", "projectId") REFERENCES "test_runs"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycle_scope_items" ADD CONSTRAINT "test_cycle_scope_items_cycleId_projectId_fkey" FOREIGN KEY ("cycleId", "projectId") REFERENCES "test_cycles"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "test_cycle_scope_items" ADD CONSTRAINT "test_cycle_scope_items_testCaseId_projectId_fkey" FOREIGN KEY ("testCaseId", "projectId") REFERENCES "test_cases"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "test_cycles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_cycles"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_cycle_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_cycle_runs"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "test_cycle_scope_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "test_cycle_scope_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Cycles are archived, never deleted; frozen scope is append-only.
REVOKE DELETE ON "test_cycles" FROM qaflow_app;
REVOKE UPDATE, DELETE ON "test_cycle_scope_items" FROM qaflow_app;
