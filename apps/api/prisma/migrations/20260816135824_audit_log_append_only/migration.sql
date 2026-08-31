-- The audit log is append-only. Until now that was true only because no code
-- path wrote an UPDATE or a DELETE, which is a promise about the codebase, not
-- about the database: anybody holding the application's credentials could edit
-- or erase the evidence of what they did. These triggers move the rule into
-- PostgreSQL, where it also applies to a psql session and to a future code path
-- that forgets.

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- TRUNCATE is the cheapest way to erase every trace at once, and row-level
-- triggers do not see it, so it needs a statement-level trigger of its own.
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
