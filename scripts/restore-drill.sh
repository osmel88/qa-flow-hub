#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restore drill: proves a backup can be restored, without touching the live
# database.
#
#   DATABASE_MIGRATION_URL=postgresql://owner:...@host:5432/qa_flow_hub \
#     scripts/restore-drill.sh [dump-file]
#
# 1. Verifies the dump's SHA-256.
# 2. Creates a scratch database `<db>_restore_drill` on the same server and
#    restores the dump into it as the owner.
# 3. Checks what a restore must preserve for the application to be safe:
#    - every migration in apps/api/prisma/migrations is recorded as applied;
#    - Row Level Security is enabled on the same tables, with the same
#      policies, as in the source database — a restore that lost it would hand
#      every tenant's rows to every other;
#    - the runtime role `qaflow_app` still has its grants (roles are
#      cluster-wide and not in the dump; the drill reports when it is missing);
#    - row counts of the main tables, for a human to compare with production.
# 4. Drops the scratch database unless KEEP_DRILL_DB=1.
#
# Exits non-zero on any failed check. Run it on a schedule: an untested
# backup is a hope, not a backup.
# ---------------------------------------------------------------------------
set -euo pipefail

: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL to the owner connection string}"
BACKUP_DIR="${BACKUP_DIR:-./var/backups}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DUMP="${1:-$(ls -1t "$BACKUP_DIR"/qa-flow-hub-*.dump 2> /dev/null | head -n 1 || true)}"
[[ -n "$DUMP" && -f "$DUMP" ]] || { echo "No dump found (looked in $BACKUP_DIR)" >&2; exit 1; }
DUMP_DIR="$(cd "$(dirname "$DUMP")" && pwd)"
DUMP_FILE="$(basename "$DUMP")"

if [[ -f "$DUMP_DIR/$DUMP_FILE.sha256" ]]; then
  (cd "$DUMP_DIR" && sha256sum --check --quiet "$DUMP_FILE.sha256")
  echo "Checksum OK: $DUMP_FILE"
else
  echo "No checksum next to $DUMP_FILE" >&2
  exit 1
fi

BASE_URL="${DATABASE_MIGRATION_URL%%\?*}"
SOURCE_DB="${BASE_URL##*/}"
SERVER_URL="${BASE_URL%/*}"
DRILL_DB="${SOURCE_DB}_restore_drill"
DRILL_URL="${SERVER_URL}/${DRILL_DB}"

pg() {
  local tool="$1"
  shift
  if command -v "$tool" > /dev/null 2>&1; then
    "$tool" "$@"
  else
    docker run --rm -i --network host -v "$DUMP_DIR:/backup" -w /backup "$PG_IMAGE" "$tool" "$@"
  fi
}
if command -v pg_restore > /dev/null 2>&1; then DUMP_PATH="$DUMP_DIR/$DUMP_FILE"; else DUMP_PATH="/backup/$DUMP_FILE"; fi

sql() { pg psql --no-psqlrc --quiet --tuples-only --no-align --set ON_ERROR_STOP=1 "$@"; }

cleanup() {
  if [[ "${KEEP_DRILL_DB:-0}" != "1" ]]; then
    sql "${SERVER_URL}/postgres" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" > /dev/null
  fi
}
trap cleanup EXIT

START=$(date +%s)
sql "${SERVER_URL}/postgres" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" > /dev/null
sql "${SERVER_URL}/postgres" -c "CREATE DATABASE \"$DRILL_DB\"" > /dev/null
pg pg_restore --no-password --exit-on-error --dbname="$DRILL_URL" "$DUMP_PATH"
echo "Restored into $DRILL_DB in $(( $(date +%s) - START ))s"

FAILED=0
check() {
  if [[ "$2" == "ok" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — $2" >&2; FAILED=1; fi
}

EXPECTED=$(find "$REPO_ROOT/apps/api/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
APPLIED=$(sql "$DRILL_URL" -c 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
[[ "$APPLIED" -ge "$EXPECTED" ]] && check "migrations: $APPLIED applied, $EXPECTED in the repository" ok \
  || check "migrations" "$APPLIED applied, $EXPECTED expected"

# Compared with the source, not with a fixed rule: `organization_members` and
# `organization_invitations` are deliberately outside RLS (they are read before
# a tenant is known; see the row_level_security migration).
RLS_QUERY="
  SELECT coalesce(string_agg(c.relname || ':' || p.polname, ',' ORDER BY c.relname, p.polname), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity"
SOURCE_RLS=$(sql "$BASE_URL" -c "$RLS_QUERY")
DRILL_RLS=$(sql "$DRILL_URL" -c "$RLS_QUERY")
RLS_TABLES=$(sql "$DRILL_URL" -c "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity")
if [[ -z "$DRILL_RLS" ]]; then
  check "row level security" "no table has RLS enabled after the restore"
elif [[ "$SOURCE_RLS" == "$DRILL_RLS" ]]; then
  check "row level security: $RLS_TABLES tables and their policies identical to the source" ok
else
  check "row level security" "tables or policies differ from the source database"
fi

ROLE=$(sql "$DRILL_URL" -c "SELECT count(*) FROM pg_roles WHERE rolname = 'qaflow_app'")
if [[ "$ROLE" == "1" ]]; then
  GRANTED=$(sql "$DRILL_URL" -c "SELECT has_table_privilege('qaflow_app', 'public.organizations', 'SELECT')::text")
  [[ "$GRANTED" == "true" ]] && check "runtime role qaflow_app has its grants" ok \
    || check "runtime role" "qaflow_app exists but lost its grants; run db:grant-app-role"
else
  check "runtime role" "qaflow_app does not exist on this server; recreate it before pointing the API here"
fi

echo "  Row counts:"
sql "$DRILL_URL" -c "
  SELECT format('    %-24s %s', t, (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text)
  FROM unnest(ARRAY['organizations','users','projects','requirements','test_cases',
                    'test_runs','test_results','defects','attachments','audit_logs']) AS t
  WHERE to_regclass('public.' || t) IS NOT NULL"

echo "Drill finished in $(( $(date +%s) - START ))s"
exit "$FAILED"
