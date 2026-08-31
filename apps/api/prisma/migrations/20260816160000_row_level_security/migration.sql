-- Row Level Security as a second layer of tenant isolation.
--
-- The first layer is `TenantAwareRepository`, which adds `organizationId` to
-- every where clause. It works, it is tested, and it is one forgotten line away
-- from a leak. This migration makes PostgreSQL refuse the leak too.
--
-- The split that makes it real: RLS does not apply to the owner of a table, so
-- the API connects at runtime as `qaflow_app`, a role that owns nothing and can
-- only read and write rows. Migrations, the seed and the test harness keep using
-- the owner. A policy that the application can bypass is decoration.

-- 1. The application role -----------------------------------------------------
-- Created without LOGIN and without a password on purpose: a password in a
-- migration is a committed secret. `npm run db:grant-app-role` (or the
-- deployment) sets it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qaflow_app') THEN
    CREATE ROLE qaflow_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO qaflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qaflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qaflow_app;

-- The audit log is append-only, and now that there is a role that does not own
-- the table, the guarantee can be a privilege and not just a trigger: this role
-- cannot UPDATE, DELETE or disable anything.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM qaflow_app;

-- Tables created by future migrations inherit the same grants, so a new table
-- is readable by the API without a follow-up migration — and a forgotten grant
-- does not become an outage.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qaflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO qaflow_app;

-- 2. Policies -----------------------------------------------------------------
-- `current_setting('app.current_organization', true)` returns NULL when the
-- setting was never applied, and NULL never equals anything, so a query without
-- an announced organization sees nothing. Failing closed is the whole point.
DO $$
DECLARE
  target text;
  tenant_tables text[] := ARRAY[
    'projects', 'project_members',
    'requirements', 'requirement_versions',
    'test_suites', 'test_sections', 'test_cases', 'test_steps',
    'test_runs', 'test_run_cases', 'test_results',
    'defects', 'attachment_metadata', 'traceability_links',
    'integration_connections', 'external_references'
  ];
BEGIN
  FOREACH target IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = current_setting(''app.current_organization'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization'', true))',
      target
    );
  END LOOP;
END
$$;

-- `audit_logs` needs its own policy: an entry may legitimately have no
-- organization (a login happens before one is chosen), and those entries must
-- be insertable without a setting while staying invisible to every tenant.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK (
    "organizationId" IS NULL
    OR "organizationId" = current_setting('app.current_organization', true)
  );

-- Tables deliberately left without RLS: `users`, `sessions`, `organizations`,
-- `organization_members` and `organization_invitations`. They are read before an
-- organization exists in the request — logging in, listing which organizations
-- you belong to, previewing an invitation — so a policy keyed on the active
-- organization could only be satisfied by turning it off in those paths, which
-- is worse than not having it. Their isolation stays where it is today: the
-- repository layer, covered by test/tenancy.int-spec.ts.
