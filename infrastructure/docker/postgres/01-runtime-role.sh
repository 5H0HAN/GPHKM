#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$GPHKM_DATABASE_PASSWORD" \
  --set=worker_password="$GPHKM_WORKER_PASSWORD" \
  --set=webhook_password="$GPHKM_WEBHOOK_PASSWORD" \
  --set=resend_webhook_password="$GPHKM_RESEND_WEBHOOK_PASSWORD" \
  --set=mfa_proof_password="$GPHKM_MFA_PROOF_PASSWORD" <<'SQL'
CREATE ROLE gphkm_runtime LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE gphkm_worker LOGIN PASSWORD :'worker_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE gphkm_webhook LOGIN PASSWORD :'webhook_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE gphkm_resend_webhook LOGIN PASSWORD :'resend_webhook_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE gphkm_mfa_proof LOGIN PASSWORD :'mfa_proof_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE gphkm TO gphkm_runtime;
GRANT CONNECT ON DATABASE gphkm TO gphkm_worker;
GRANT CONNECT ON DATABASE gphkm TO gphkm_webhook;
GRANT CONNECT ON DATABASE gphkm TO gphkm_resend_webhook;
GRANT CONNECT ON DATABASE gphkm TO gphkm_mfa_proof;
GRANT USAGE ON SCHEMA public TO gphkm_runtime;
GRANT USAGE ON SCHEMA public TO gphkm_webhook, gphkm_resend_webhook, gphkm_mfa_proof;
SQL
