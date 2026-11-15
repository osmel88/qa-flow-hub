-- S7-F5 Exploratory testing.
--
-- Additive only. A session belongs to a project and optionally to an
-- environment, release, test plan and test cycle of the same project (every
-- foreign key carries projectId). Its timeline is append-only, and a
-- completed or cancelled session is immutable: triggers refuse any change
-- other than archiving, whichever code path tries.

CREATE UNIQUE INDEX "defects_id_projectId_key" ON "defects"("id", "projectId");

CREATE TABLE "exploratory_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "charter" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "ownerId" TEXT,
    "environmentId" TEXT,
    "releaseId" TEXT,
    "testPlanId" TEXT,
    "testCycleId" TEXT,
    "timeboxMinutes" INTEGER,
    "notes" TEXT,
    "risks" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedSeconds" INTEGER NOT NULL DEFAULT 0,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exploratory_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exploratory_sessions_status" CHECK ("status" IN ('planned', 'active', 'paused', 'completed', 'cancelled', 'archived')),
    CONSTRAINT "exploratory_sessions_paused" CHECK (("status" = 'paused') = ("pausedAt" IS NOT NULL)),
    CONSTRAINT "exploratory_sessions_timebox" CHECK ("timeboxMinutes" IS NULL OR "timeboxMinutes" BETWEEN 5 AND 480),
    CONSTRAINT "exploratory_sessions_paused_seconds" CHECK ("pausedSeconds" >= 0)
);

CREATE TABLE "exploratory_session_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "findingId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exploratory_session_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exploratory_session_events_type" CHECK ("type" IN ('created', 'updated', 'started', 'paused', 'resumed', 'completed', 'cancelled', 'archived', 'note', 'finding', 'defect_created', 'defect_linked', 'defect_unlinked', 'work_item_linked', 'work_item_unlinked'))
);

CREATE TABLE "exploratory_findings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'bug',
    "severity" "DefectSeverity" NOT NULL DEFAULT 'major',
    "defectId" TEXT,
    "defectCreated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exploratory_findings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exploratory_findings_kind" CHECK ("kind" IN ('bug', 'risk', 'question', 'improvement')),
    CONSTRAINT "exploratory_findings_created" CHECK (NOT "defectCreated" OR "defectId" IS NOT NULL)
);

CREATE TABLE "exploratory_session_work_items" (
    "sessionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exploratory_session_work_items_pkey" PRIMARY KEY ("sessionId", "workItemId")
);

CREATE TABLE "exploratory_session_defects" (
    "sessionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "defectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "exploratory_session_defects_pkey" PRIMARY KEY ("sessionId", "defectId")
);

CREATE UNIQUE INDEX "exploratory_sessions_id_projectId_key" ON "exploratory_sessions"("id", "projectId");
CREATE INDEX "exploratory_sessions_organizationId_projectId_status_idx" ON "exploratory_sessions"("organizationId", "projectId", "status");
CREATE INDEX "exploratory_sessions_ownerId_idx" ON "exploratory_sessions"("ownerId");
-- A tester runs one session at a time per project.
CREATE UNIQUE INDEX "exploratory_sessions_one_active" ON "exploratory_sessions"("projectId", "ownerId") WHERE "status" = 'active';
CREATE INDEX "exploratory_session_events_sessionId_createdAt_idx" ON "exploratory_session_events"("sessionId", "createdAt");
CREATE INDEX "exploratory_findings_sessionId_createdAt_idx" ON "exploratory_findings"("sessionId", "createdAt");
CREATE INDEX "exploratory_findings_defectId_idx" ON "exploratory_findings"("defectId");
CREATE INDEX "exploratory_session_work_items_workItemId_idx" ON "exploratory_session_work_items"("workItemId");
CREATE INDEX "exploratory_session_defects_defectId_idx" ON "exploratory_session_defects"("defectId");

ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_environmentId_projectId_fkey" FOREIGN KEY ("environmentId", "projectId") REFERENCES "environments"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_releaseId_projectId_fkey" FOREIGN KEY ("releaseId", "projectId") REFERENCES "releases"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_testPlanId_projectId_fkey" FOREIGN KEY ("testPlanId", "projectId") REFERENCES "test_plans"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "exploratory_sessions" ADD CONSTRAINT "exploratory_sessions_testCycleId_projectId_fkey" FOREIGN KEY ("testCycleId", "projectId") REFERENCES "test_cycles"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "exploratory_session_events" ADD CONSTRAINT "exploratory_session_events_sessionId_projectId_fkey" FOREIGN KEY ("sessionId", "projectId") REFERENCES "exploratory_sessions"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_findings" ADD CONSTRAINT "exploratory_findings_sessionId_projectId_fkey" FOREIGN KEY ("sessionId", "projectId") REFERENCES "exploratory_sessions"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_findings" ADD CONSTRAINT "exploratory_findings_defectId_projectId_fkey" FOREIGN KEY ("defectId", "projectId") REFERENCES "defects"("id", "projectId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "exploratory_session_work_items" ADD CONSTRAINT "exploratory_session_work_items_sessionId_projectId_fkey" FOREIGN KEY ("sessionId", "projectId") REFERENCES "exploratory_sessions"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_session_work_items" ADD CONSTRAINT "exploratory_session_work_items_workItemId_projectId_fkey" FOREIGN KEY ("workItemId", "projectId") REFERENCES "work_items"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_session_defects" ADD CONSTRAINT "exploratory_session_defects_sessionId_projectId_fkey" FOREIGN KEY ("sessionId", "projectId") REFERENCES "exploratory_sessions"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exploratory_session_defects" ADD CONSTRAINT "exploratory_session_defects_defectId_projectId_fkey" FOREIGN KEY ("defectId", "projectId") REFERENCES "defects"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row Level Security ---------------------------------------------------------

ALTER TABLE "exploratory_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exploratory_sessions"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "exploratory_session_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exploratory_session_events"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "exploratory_findings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exploratory_findings"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "exploratory_session_work_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exploratory_session_work_items"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
ALTER TABLE "exploratory_session_defects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "exploratory_session_defects"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));

-- Sessions are archived, never deleted; the timeline is append-only and
-- findings are never removed.
REVOKE DELETE ON "exploratory_sessions" FROM qaflow_app;
REVOKE UPDATE, DELETE ON "exploratory_session_events" FROM qaflow_app;
REVOKE DELETE ON "exploratory_findings" FROM qaflow_app;

-- Immutability ---------------------------------------------------------------

-- A completed or cancelled session can only be archived; an archived one is
-- final. Only status, archivedAt, version and updatedAt may move.
CREATE OR REPLACE FUNCTION exploratory_sessions_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'archived'
    OR (OLD."status" IN ('completed', 'cancelled') AND (
      NEW."status" <> 'archived'
      OR (to_jsonb(NEW) - ARRAY['status', 'archivedAt', 'version', 'updatedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'archivedAt', 'version', 'updatedAt']))) THEN
    RAISE EXCEPTION 'exploratory_sessions: a % session is immutable', OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER exploratory_sessions_frozen
  BEFORE UPDATE ON "exploratory_sessions"
  FOR EACH ROW EXECUTE FUNCTION exploratory_sessions_frozen();

CREATE OR REPLACE FUNCTION exploratory_session_status(session_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT "status" FROM "exploratory_sessions" WHERE "id" = session_id
$$;

-- Findings are recorded and linked to defects while the session runs or is
-- paused; links to work items and defects change while it is open.
CREATE OR REPLACE FUNCTION exploratory_children_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_session TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."sessionId" ELSE NEW."sessionId" END;
  current_status TEXT := exploratory_session_status(row_session);
BEGIN
  IF TG_TABLE_NAME = 'exploratory_findings' THEN
    IF current_status NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'exploratory_findings: the session is %', current_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'exploratory_session_events' THEN
    IF current_status = 'archived' AND NEW."type" <> 'archived'
      OR current_status IN ('completed', 'cancelled')
        AND NEW."type" NOT IN ('completed', 'cancelled', 'archived') THEN
      RAISE EXCEPTION 'exploratory_session_events: the session is %', current_status
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF current_status NOT IN ('planned', 'active', 'paused') THEN
    RAISE EXCEPTION '%: the session is %', TG_TABLE_NAME, current_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER exploratory_findings_frozen
  BEFORE INSERT OR UPDATE ON "exploratory_findings"
  FOR EACH ROW EXECUTE FUNCTION exploratory_children_frozen();
CREATE TRIGGER exploratory_session_events_frozen
  BEFORE INSERT ON "exploratory_session_events"
  FOR EACH ROW EXECUTE FUNCTION exploratory_children_frozen();
CREATE TRIGGER exploratory_session_work_items_frozen
  BEFORE INSERT OR DELETE ON "exploratory_session_work_items"
  FOR EACH ROW EXECUTE FUNCTION exploratory_children_frozen();
CREATE TRIGGER exploratory_session_defects_frozen
  BEFORE INSERT OR DELETE ON "exploratory_session_defects"
  FOR EACH ROW EXECUTE FUNCTION exploratory_children_frozen();
