#!/bin/bash
set -a
source .env
set +a

export PGPASSWORD=$DB_PASSWORD

# This script takes a filename as an argument
# Usage: bash src/scripts/migrate.sh db/migrations/001_add_timestamp.sql

if [ -z "$1" ]; then
  echo "Error: No migration file specified."
  echo "Usage: npm run migrate -- db/migrations/your_file.sql"
  exit 1
fi

echo "Running migration: $1..."
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f "$1"

echo "✅ Migration Complete."
unset PGPASSWORD