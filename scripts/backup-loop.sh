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

INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
KEEP="${BACKUP_KEEP:-14}"
DIR="${BACKUP_TARGET_DIR:-/backups}"

COUNTS_SQL="select json_build_object(
  'createdAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'database', current_database(),
  'serverVersion', current_setting('server_version'),
  'consistent', false,
  'tables', (select coalesce(json_object_agg(table_name,
      (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint), '{}')
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'),
  'latestMigration', (select max(filename) from schema_migrations))"

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
  echo "[backup] $file ($bytes bytes)"
  ls -1 "$DIR"/wedmoments-*.dump 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" "$old.json"
    echo "[backup] removed $old"
  done
}

while true; do
  if ! backup_once; then
    rm -f "$DIR"/wedmoments-*.partial
    echo "[backup] FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    [ "${BACKUP_ONCE:-0}" = "1" ] && exit 1
  fi
  [ "${BACKUP_ONCE:-0}" = "1" ] && exit 0
  sleep "$((INTERVAL_HOURS * 3600))"
done
