#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY: drops and recreates the database in .env DATABASE_URL, applies migrations and seeds.
#   tools/reset-local-db.sh          -> emr_v2 (the dev database the running app uses)
#   tools/reset-local-db.sh --test   -> emr_v2_test + Redis db 1 (the API test suite; never touches dev data)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
if [ "${1:-}" = "--test" ]; then
  DATABASE_URL="${DATABASE_URL%/*}/emr_v2_test"
  APP_DATABASE_URL="${APP_DATABASE_URL%/*}/emr_v2_test"
  REDIS_URL="${REDIS_URL%/}/1"
  export DATABASE_URL APP_DATABASE_URL REDIS_URL
fi
db="${DATABASE_URL##*/}"; db="${db%%\?*}"
case "$db" in emr_v2|emr_v2_test) ;; *) echo "refusing to reset '$db' (only emr_v2 / emr_v2_test)"; exit 1;; esac
psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""
npx prisma migrate deploy >/dev/null
npx prisma db seed 2>&1 | grep -v '^$' | tail -4
redis-cli -u "$REDIS_URL" --scan --pattern 'sess:*' | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null
