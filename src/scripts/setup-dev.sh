#!/bin/bash
# Safer way to load variables
set -a
source .env
set +a

echo "Setting up Dev Environment for $DB_NAME..."

# 2. Infrastructure (Run as postgres superuser)
# Create user and DB if they don't exist
psql -h localhost -U postgres -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" 2>/dev/null || echo "User exists."
psql -h localhost -U postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null || echo "DB exists."
psql -h localhost -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

# 3. Schema (Run as app user)
# Note: No DROP TABLE here, so your data stays safe.
psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f db/schema.sql

echo "✅ Dev Environment Ready (Data Preserved)."