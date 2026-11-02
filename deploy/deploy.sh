#!/usr/bin/env bash
# Sample deploy script for the VPS.  Place it in the directory that contains
# compose.yml and run it from GitHub Actions (via SSH) or by hand.
#
#   1. Back up the database with pg_dump
#   2. docker compose pull hollo
#   3. docker compose up -d hollo
set -euo pipefail

# Directory containing compose.yml (defaults to the directory of this script).
COMPOSE_DIR="${COMPOSE_DIR:-$(dirname "$(readlink -f "$0")")}"
# Compose service name and credentials of PostgreSQL.
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-hollo}"
PG_DB="${PG_DB:-hollo}"
# Number of backups to keep.
BACKUP_KEEP="${BACKUP_KEEP:-14}"

cd "$COMPOSE_DIR"
mkdir -p backups

timestamp="$(date +%Y%m%d-%H%M%S)"
backup="backups/hollo-$timestamp.sql"

echo "==> Backing up database to $COMPOSE_DIR/$backup"
docker compose exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" "$PG_DB" \
  > "$backup.partial"
if ! tail -n 5 "$backup.partial" | grep -q "PostgreSQL database dump complete"
then
  echo "ERROR: pg_dump output looks incomplete; aborting deploy." >&2
  echo "       (kept as $backup.partial for inspection)" >&2
  exit 1
fi
mv "$backup.partial" "$backup"

echo "==> Removing old backups (keeping the latest $BACKUP_KEEP)"
# shellcheck disable=SC2012
ls -1t backups/hollo-*.sql 2>/dev/null \
  | tail -n +"$((BACKUP_KEEP + 1))" \
  | while read -r old; do rm -f -- "$old"; done

echo "==> Pulling image (HOLLO_TAG=${HOLLO_TAG:-stable})"
docker compose pull hollo

echo "==> Restarting hollo"
docker compose up -d hollo

docker compose ps
