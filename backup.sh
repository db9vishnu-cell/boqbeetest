#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
pg_dump "$DATABASE_URL" --format=custom --file="$BACKUP_DIR/boqbee_${STAMP}.dump"
find "$BACKUP_DIR" -type f -name 'boqbee_*.dump' -mtime +30 -delete
printf 'Backup written to %s/boqbee_%s.dump\n' "$BACKUP_DIR" "$STAMP"
