#!/usr/bin/env bash
# Nightly backup: a compressed custom-format dump of the WardBook database.
# Keeps BACKUP_KEEP_DAYS days (default 30). Run from cron, for example:
#   15 2 * * *  cd /opt/wardbook && ./scripts/backup.sh >> /var/log/wardbook-backup.log 2>&1
# Store the backup directory on an encrypted disk, and copy it off the server
# to a second location your hospital approves.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
: "${OWNER_DATABASE_URL:?OWNER_DATABASE_URL is not set}"
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/wardbook-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --dbname="$OWNER_DATABASE_URL" --file="$FILE.part"
mv "$FILE.part" "$FILE"
chmod 600 "$FILE"
find "$DIR" -name 'wardbook-*.dump' -type f -mtime +"$KEEP" -delete
echo "$(date -u +%FT%TZ) backup written: $FILE ($(du -h "$FILE" | cut -f1))"
