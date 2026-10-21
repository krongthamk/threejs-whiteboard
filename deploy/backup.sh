#!/bin/sh
set -eu
umask 077
cd /app

: "${RESTIC_REPOSITORY:?Configure an off-host RESTIC_REPOSITORY in deploy/backup.env}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"
: "${WHITEBOARD_BACKUP_HOST:?Set a stable unique WHITEBOARD_BACKUP_HOST}"
test -r "$RESTIC_PASSWORD_FILE" || { echo 'Backup password file is not readable by UID 1000.' >&2; exit 1; }

# This volume is dedicated to staging. Kernel locks are released on process exit,
# including crashes; a leftover file cannot permanently block future backups.
exec 9>/backups/job.lock
flock -n 9 || { echo 'Another backup/restore operation is running.' >&2; exit 1; }
work=/backups/whiteboard-managed
if mkdir "$work" 2>/dev/null; then
    touch "$work/.owned"
fi
test -f "$work/.owned" || { echo 'Refusing an unrecognized staging directory.' >&2; exit 1; }
snapshot="$work/snapshot"
retrieved="$work/retrieved"
verified="$work/verified"
cleanup() { rm -rf "$snapshot" "$retrieved" "$verified"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup

restore_snapshot() {
    restic restore "$1" --host "$WHITEBOARD_BACKUP_HOST" --tag threejs-whiteboard \
        --path "$snapshot" --target "$retrieved"
    # Restic retains the absolute source path beneath its target directory.
    node --import tsx packages/server/src/backup-cli.ts restore "$retrieved$snapshot" "$2"
}

case "${1:-backup}" in
    init)
        restic init
        ;;
    backup)
        # Never report a successful backup of a newly created empty database
        # when an operator accidentally selected the wrong data volume.
        if [ ! -f /data/live/whiteboard.sqlite ] || [ ! -f /data/live/session-secret ]; then
            echo 'The configured live database/session secret does not exist.' >&2; exit 1;
        fi
        node --import tsx packages/server/src/backup-cli.ts backup "$snapshot"
        node --import tsx packages/server/src/backup-cli.ts restore "$snapshot" "$verified"
        rm -rf "$verified"
        restic backup --host "$WHITEBOARD_BACKUP_HOST" --tag threejs-whiteboard "$snapshot"
        restic check
        # Scope retention to this deployment and stable snapshot path only.
        restic forget --host "$WHITEBOARD_BACKUP_HOST" --tag threejs-whiteboard --path "$snapshot" \
            --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
        date -u +%Y-%m-%dT%H:%M:%SZ > /backups/last-success.tmp
        mv /backups/last-success.tmp /backups/last-success
        ;;
    verify)
        restic check
        restore_snapshot latest "$verified"
        date -u +%Y-%m-%dT%H:%M:%SZ > /backups/last-verified.tmp
        mv /backups/last-verified.tmp /backups/last-verified
        ;;
    restore)
        # Restore only to the separate recovery volume, never over live data.
        test ! -e /restore/live || { echo 'Choose a fresh WHITEBOARD_RESTORE_VOLUME; /restore/live already exists.' >&2; exit 1; }
        restore_snapshot "${2:-latest}" /restore/live
        echo 'Verified restore is ready in the recovery volume. The running service was not changed.'
        ;;
    status)
        node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
for (const [name, maximumHours] of [['last-success', 26], ['last-verified', 8 * 24]]) {
  let timestamp;
  try { timestamp = Date.parse(readFileSync(`/backups/${name}`, 'utf8').trim()); } catch {}
  const age = Date.now() - timestamp;
  if (!Number.isFinite(age) || age < 0 || age > maximumHours * 3600000) {
    console.error(`Backup ${name} is missing or older than ${maximumHours} hours.`); process.exitCode = 1;
  } else console.log(JSON.stringify({ event: name, ageHours: age / 3600000 }));
}
JS
        ;;
    *) echo 'Usage: backup.sh init|backup|verify|restore [snapshot]|status' >&2; exit 2 ;;
esac
