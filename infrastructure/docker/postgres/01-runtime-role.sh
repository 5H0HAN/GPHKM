#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$GPHKM_DATABASE_PASSWORD" <<'SQL'
CREATE ROLE gphkm_runtime LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE gphkm TO gphkm_runtime;
GRANT USAGE ON SCHEMA public TO gphkm_runtime;
SQL
