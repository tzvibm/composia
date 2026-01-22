#!/bin/bash
# Load variables without xargs
set -a
source .env.test
set +a

export PGPASSWORD=$DB_PASSWORD 

echo "Setting up Test Environment for $DB_NAME..."
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c "DROP TABLE IF EXISTS units CASCADE;"
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f db/schema.sql

unset PGPASSWORD
echo "✅ Test Environment Ready."