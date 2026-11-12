#!/usr/bin/env bash
# Monthly restore check: restores the newest backup into a scratch database, counts the
# records, then drops the scratch database. Needs ADMIN_DATABASE_URL (a superuser).
# A backup that has never been restored is not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is not set}"
DIR="${BACKUP_DIR:-./backups}"
LATEST="$(ls -1t "$DIR"/wardbook-*.dump 2>/dev/null | head -n1 || true)"
[ -n "$LATEST" ] || { echo "No backups found in $DIR"; exit 1; }
SCRATCH="wardbook_restore_check"
psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" -c "CREATE DATABASE $SCRATCH"
TARGET="${ADMIN_DATABASE_URL%/*}/$SCRATCH"
pg_restore --no-owner --exit-on-error --dbname="$TARGET" "$LATEST"
psql "$TARGET" -At -c "SELECT 'hospitals: ' || count(*) FROM hospitals" \
                    -c "SELECT 'patients: ' || count(*) FROM patients" \
                    -c "SELECT 'notes: ' || count(*) FROM notes" \
                    -c "SELECT 'audit entries: ' || count(*) FROM audit_log"
psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE $SCRATCH WITH (FORCE)"
echo "Restore check passed for $LATEST"
