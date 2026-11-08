-- S6-F3 Quality gates.
--
-- Additive only. A `quality_gates` row is a named set of rules of a project,
-- optionally scoped to one environment; `quality_gate_rules` holds one rule
-- per type with its threshold. Results are never stored: they are evaluated
-- against current data on every read. `quality_gate_overrides` records manual
-- overrides (release + environment + mandatory reason) and is append-only for
-- the application. Composite foreign keys with projectId keep environments,
-- releases and gates inside one project.

CREATE TABLE "quality_gates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "quality_gates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quality_gate_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "gateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_gate_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_gate_rules_type" CHECK ("type" IN (
      'min_pass_rate', 'max_failed_tests', 'max_blocked_tests', 'min_requirement_coverage',
      'max_open_critical_defects', 'max_open_high_defects', 'build_must_pass',
      'completed_test_run_required', 'code_review_approval_required'
    )),
    CONSTRAINT "quality_gate_rules_threshold" CHECK ("threshold" IS NULL OR "threshold" >= 0)
);

CREATE TABLE "quality_gate_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "gateStatus" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quality_gate_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quality_gate_overrides_reason" CHECK (length(btrim("reason")) >= 10)
);

CREATE UNIQUE INDEX "quality_gates_id_projectId_key" ON "quality_gates"("id", "projectId");
CREATE INDEX "quality_gates_organizationId_projectId_idx" ON "quality_gates"("organizationId", "projectId");
CREATE INDEX "quality_gates_environmentId_idx" ON "quality_gates"("environmentId");
CREATE UNIQUE INDEX "quality_gates_live_name" ON "quality_gates"("projectId", lower("name")) WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "quality_gate_rules_gateId_type_key" ON "quality_gate_rules"("gateId", "type");
CREATE INDEX "quality_gate_overrides_releaseId_environmentId_idx" ON "quality_gate_overrides"("releaseId", "environmentId");

ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_gates" ADD CONSTRAINT "quality_gates_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_gate_rules" ADD CONSTRAINT "quality_gate_rules_gateId_projectId_fkey" FOREIGN KEY ("gateId", "projectId") REFERENCES "quality_gates"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_gate_overrides" ADD CONSTRAINT "quality_gate_overrides_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quality_gate_overrides" ADD CONSTRAINT "quality_gate_overrides_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "quality_gates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quality_gates"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE DELETE ON "quality_gates" FROM qaflow_app;

-- Rules are replaced as a whole when a gate is edited.
ALTER TABLE "quality_gate_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quality_gate_rules"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Overrides are append-only for the application.
ALTER TABLE "quality_gate_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quality_gate_overrides"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
REVOKE UPDATE, DELETE ON "quality_gate_overrides" FROM qaflow_app;
