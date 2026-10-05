#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Logical backup of the qa-flow-hub database.
#
#   DATABASE_MIGRATION_URL=postgresql://owner:...@host:5432/qa_flow_hub \
#     scripts/db-backup.sh [backup-dir]
#
# - Connects as the OWNER (DATABASE_MIGRATION_URL), never as `qaflow_app`:
#   the runtime role is subject to Row Level Security, so its dump would only
#   contain the rows of whatever tenant the session happened to name — none.
# - Writes a custom-format dump (`pg_dump -Fc`): compressed, restorable table
#   by table, and checked with `pg_restore --list` before it counts as a backup.
# - Writes a SHA-256 next to it and deletes dumps older than RETENTION_DAYS.
# - Uses the host's pg_dump when present; otherwise the postgres:16 image
#   through Docker, so the client always matches the server's major version.
#
# Evidence files (STORAGE_LOCAL_ROOT / the `api-storage` volume) are NOT in
# the database. Back them up in the same window; see docs/deployment.md.
# ---------------------------------------------------------------------------
set -euo pipefail

: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL to the owner connection string}"
BACKUP_DIR="${1:-${BACKUP_DIR:-./var/backups}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"

# Prisma's `?schema=public` is not a libpq parameter; pg_dump would reject it.
DB_URL="${DATABASE_MIGRATION_URL%%\?*}"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="qa-flow-hub-${STAMP}.dump"

pg() {
  local tool="$1"
  shift
  if command -v "$tool" > /dev/null 2>&1; then
    "$tool" "$@"
  else
    docker run --rm --network host -v "$BACKUP_DIR:/backup" -w /backup "$PG_IMAGE" "$tool" "$@"
  fi
}

# Inside Docker the dump directory is /backup; on the host it is BACKUP_DIR.
if command -v pg_dump > /dev/null 2>&1; then TARGET="$BACKUP_DIR/$FILE"; else TARGET="/backup/$FILE"; fi

echo "Dumping to $BACKUP_DIR/$FILE"
pg pg_dump --format=custom --compress=9 --no-password --file="$TARGET" "$DB_URL"

# A dump that cannot be listed is not a backup.
pg pg_restore --list "$TARGET" > /dev/null

(cd "$BACKUP_DIR" && sha256sum "$FILE" > "$FILE.sha256")
echo "Backup verified: $FILE ($(du -h "$BACKUP_DIR/$FILE" | cut -f1))"

find "$BACKUP_DIR" -maxdepth 1 -name 'qa-flow-hub-*.dump*' -mtime "+$RETENTION_DAYS" -print -delete
