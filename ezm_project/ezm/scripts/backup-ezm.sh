#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/EZM/ezm_project/ezm}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/ezm-backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-90}"
SERVICE_NAME="${SERVICE_NAME:-ezm}"

mkdir -p "$BACKUP_DIR"
cd "$PROJECT_DIR"

container_id="$(docker compose ps -q "$SERVICE_NAME")"
if [ -z "$container_id" ]; then
  echo "EZM backup failed: container for service '$SERVICE_NAME' is not running" >&2
  exit 1
fi

timestamp="$(date +'%Y-%m-%d_%H-%M')"
tmp_file="$BACKUP_DIR/.ezm_${timestamp}.sqlite3.tmp"
backup_file="$BACKUP_DIR/ezm_${timestamp}.sqlite3"

docker compose exec -T "$SERVICE_NAME" python3 - <<'PY'
import os
import sqlite3

src = os.environ.get("EZM_DB_PATH", "/data/ezm.sqlite3")
dst = "/tmp/ezm_backup.sqlite3"

with sqlite3.connect(src) as source:
    with sqlite3.connect(dst) as target:
        source.backup(target)
PY

docker cp "$container_id:/tmp/ezm_backup.sqlite3" "$tmp_file"
docker compose exec -T "$SERVICE_NAME" rm -f /tmp/ezm_backup.sqlite3 >/dev/null 2>&1 || true

mv "$tmp_file" "$backup_file"

find "$BACKUP_DIR" -maxdepth 1 -type f -name ".ezm_*.tmp" -delete
ls -1t "$BACKUP_DIR"/ezm_*.sqlite3 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm --

echo "EZM backup created: $backup_file"
