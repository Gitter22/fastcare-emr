#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY: drops and recreates the database in .env DATABASE_URL, applies migrations and seeds.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
db="${DATABASE_URL##*/}"; db="${db%%\?*}"
case "$db" in emr_v2|emr_v2_test) ;; *) echo "refusing to reset '$db' (only emr_v2 / emr_v2_test)"; exit 1;; esac
psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""
npx prisma migrate deploy >/dev/null
npx prisma db seed 2>&1 | grep -v '^$' | tail -4
redis-cli -u "$REDIS_URL" --scan --pattern 'sess:*' | xargs -r redis-cli -u "$REDIS_URL" del >/dev/null
