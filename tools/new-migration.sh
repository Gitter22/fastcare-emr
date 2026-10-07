#!/usr/bin/env bash
# Create a migration from the diff between prisma/migrations and prisma/schema.prisma (uses a local shadow DB).
#   tools/new-migration.sh <name>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
name="$(date -u +%Y%m%d%H%M%S)_$1"
mkdir -p "prisma/migrations/$name"
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "${DATABASE_URL%/*}/emr_v2_shadow" --script > "prisma/migrations/$name/migration.sql"
echo "prisma/migrations/$name/migration.sql"; cat "prisma/migrations/$name/migration.sql"
