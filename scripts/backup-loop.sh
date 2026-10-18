#!/bin/sh
# Daily database backup, run by the `backup` service in docker-compose.yml
# inside the postgres image, whose pg_dump always matches the server.
#
# Each run writes /backups/wedmoments-<UTC time>.dump and a manifest beside it
# (row counts and SHA-256), keeps the newest BACKUP_KEEP, and never keeps a
# dump pg_restore cannot read. `npm run db:restore-check` restores one into a
# throwaway database and compares it with its manifest. The counts are taken
# just before the dump rather than in its snapshot, so the manifest says
# "consistent": false and the check reports small differences instead of
# failing on them; `npm run db:backup` takes both in one snapshot.
#
# Connection: PGHOST, PGUSER, PGPASSWORD, PGDATABASE from the service's
# environment. BACKUP_ONCE=1 runs a single backup and exits, for a backup by
# hand: `docker compose run --rm -e BACKUP_ONCE=1 backup`.
# See docs/OPERATIONS.md, section 6.
set -u
# Dumps and manifests readable by their owner only: they hold every guest's data.
umask 077

# A whole number of at least 1, or the default (N-177). BACKUP_KEEP=0, which
# many tools read as "keep all", pruned with `tail -n +1` and removed every
# dump, the new one included; a value that is not a number counted as 0.
whole_number_or() {
  case "$1" in
    '' | *[!0-9]*) echo "$2" ;;
    *) if [ "$1" -ge 1 ]; then echo "$1"; else echo "$2"; fi ;;
  esac
}

KEEP=$(whole_number_or "${BACKUP_KEEP:-14}" 14)
INTERVAL_HOURS=$(whole_number_or "${BACKUP_INTERVAL_HOURS:-24}" 24)
# N-178 — a failed backup is tried again this often, this many times, before
# the loop waits for the next interval. It used to wait the whole interval.
RETRY_MINUTES=$(whole_number_or "${BACKUP_RETRY_MINUTES:-15}" 15)
ATTEMPTS=$(whole_number_or "${BACKUP_ATTEMPTS:-4}" 4)
DIR="${BACKUP_TARGET_DIR:-/backups}"

[ "$KEEP" = "${BACKUP_KEEP:-14}" ] || echo "[backup] BACKUP_KEEP=\"${BACKUP_KEEP:-}\" is not a whole number of at least 1; keeping $KEEP" >&2

COUNTS_SQL="select json_build_object(
  'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'database', current_database(),
  'serverVersion', current_setting('server_version'),
  'consistent', false,
  'tables', (select coalesce(json_object_agg(table_name,
      (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint), '{}')
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'),
  'latestMigration', (select max(filename) from schema_migrations))"

# Keep the newest $KEEP dumps and their manifests.
prune() {
  ls -1 "$DIR"/wedmoments-*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" "$old.json"
    echo "[backup] removed $old"
  done
}

# N-187 — the service runs as root, so under umask 077 the files were
# root:root 0600, and an operator copying them off the machine needed sudo.
# BACKUP_UID (and BACKUP_GID) hand them to that user; they stay 0600.
hand_over() {
  [ -n "${BACKUP_UID:-}" ] || return 0
  chown "$BACKUP_UID:${BACKUP_GID:-$BACKUP_UID}" "$@"
}

# N-178 — seconds until the newest dump is one interval old, or 0. The loop
# used to back up as it started, so every redeploy or restart added a dump,
# and pruning by count let a day of restarts push out the earlier days.
seconds_until_due() {
  newest=$(ls -1t "$DIR"/wedmoments-*.dump 2>/dev/null | head -n 1)
  if [ -z "$newest" ]; then echo 0; return; fi
  left=$((INTERVAL_HOURS * 3600 - ($(date +%s) - $(stat -c %Y "$newest"))))
  if [ "$left" -gt 0 ]; then echo "$left"; else echo 0; fi
}

backup_once() {
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  file="$DIR/wedmoments-$stamp.dump"

  counts=$(psql -X -At -c "$COUNTS_SQL") || return 1
  pg_dump --format=custom --no-owner --no-privileges -f "$file.partial" || return 1
  pg_restore --list "$file.partial" > /dev/null || return 1

  # The manifest is written before the dump is kept, so a kept dump always
  # has one. psql substitutes variables only in what it reads, not in -c.
  sha=$(sha256sum "$file.partial" | cut -d' ' -f1)
  bytes=$(wc -c < "$file.partial" | tr -d ' ')
  echo "select (:'counts'::jsonb || jsonb_build_object('sha256', :'sha', 'bytes', :bytes::bigint))::text;" |
    psql -X -At -v counts="$counts" -v sha="$sha" -v bytes="$bytes" > "$file.json.partial" || return 1
  [ -s "$file.json.partial" ] || return 1

  mv "$file.json.partial" "$file.json"
  mv "$file.partial" "$file"
  hand_over "$file" "$file.json"
  echo "[backup] $file ($bytes bytes)"
  prune
}

# Tries a backup up to $ATTEMPTS times, $RETRY_MINUTES apart. False when all failed.
backup_with_retries() {
  attempt=1
  until backup_once; do
    rm -f "$DIR"/wedmoments-*.partial
    echo "[backup] FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ) (attempt $attempt of $ATTEMPTS)" >&2
    [ "$attempt" -ge "$ATTEMPTS" ] && return 1
    attempt=$((attempt + 1))
    sleep "$((RETRY_MINUTES * 60))"
  done
}

# Sourced by tests for the functions above, without running the loop.
if [ "${BACKUP_LIB_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  ATTEMPTS=1
  backup_with_retries || exit 1
  exit 0
fi

wait=$(seconds_until_due)
if [ "$wait" -gt 0 ]; then
  echo "[backup] the newest dump is under ${INTERVAL_HOURS}h old; the next one is in $((wait / 60)) minutes"
  sleep "$wait"
fi

while true; do
  backup_with_retries || echo "[backup] giving up until the next interval, in ${INTERVAL_HOURS}h" >&2
  sleep "$((INTERVAL_HOURS * 3600))"
done
