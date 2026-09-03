#!/usr/bin/env bash
# InnSight PMS — Postgres backup script.
#
# Usage:
#   bash scripts/backup.sh                        # writes ./backups/<UTC-timestamp>.sql.gz
#   bash scripts/backup.sh /path/to/output.sql.gz # custom destination
#
# Cron example (daily at 02:00):
#   0 2 * * * cd /opt/innsight-pms && bash scripts/backup.sh >> backups/cron.log 2>&1
#
# To restore:
#   gunzip -c backups/<file>.sql.gz | docker compose exec -T postgres psql -U innsight

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"

OUT="${1:-$BACKUP_DIR/innsight-$(date -u +%Y%m%dT%H%M%SZ).sql.gz}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

echo "→ Backing up Postgres → $OUT"
docker compose exec -T postgres \
  pg_dumpall --clean --if-exists -U innsight \
  | gzip -9 > "$OUT"

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo "  ✓ written ($SIZE)"

# Prune old backups
echo "→ Pruning backups older than $RETAIN_DAYS days…"
find "$BACKUP_DIR" -name 'innsight-*.sql.gz' -mtime "+$RETAIN_DAYS" -print -delete | sed 's/^/  removed: /' || true

echo "✓ Backup complete."
