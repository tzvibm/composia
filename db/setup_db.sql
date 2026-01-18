-- 1. Create the dedicated user
CREATE USER composia_admin WITH PASSWORD '1234';

-- 2. Create the database
CREATE DATABASE composia OWNER composia_admin;

-- 3. Grant privileges
GRANT ALL PRIVILEGES ON DATABASE composia TO composia_admin;