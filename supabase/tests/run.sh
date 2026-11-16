#!/usr/bin/env bash
# Applies every migration to a throwaway local PostgreSQL cluster and runs the SQL tests.
# Needs the PostgreSQL server binaries (initdb/pg_ctl) and psql. No Supabase account required.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v initdb 2>/dev/null || ls /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$TMP/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" start >/dev/null
export PGHOST="$TMP" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
psql -v ON_ERROR_STOP=1 -q -f "$HERE/_supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migration $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -f "$f"
done
status=0
shopt -s nullglob
for f in "$HERE"/*.test.sql; do
  echo "test $(basename "$f")"
  if ! psql -v ON_ERROR_STOP=1 -q -f "$f"; then status=1; fi
done
if [ "$status" = 0 ]; then echo "SQL tests passed"; else echo "SQL tests FAILED"; fi
exit $status
