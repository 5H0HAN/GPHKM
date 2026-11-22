\set ON_ERROR_STOP on
SELECT format(
  'ALTER ROLE gphkm_worker WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'worker_password'
) \gexec
SELECT format(
  'ALTER ROLE gphkm_resend_webhook WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'webhook_password'
) \gexec
GRANT CONNECT ON DATABASE gphkm_staging TO gphkm_worker;
GRANT CONNECT ON DATABASE gphkm_staging TO gphkm_resend_webhook;
GRANT USAGE ON SCHEMA public TO gphkm_worker;
REVOKE gphkm_runtime FROM gphkm_worker;
REVOKE gphkm_runtime FROM gphkm_resend_webhook;
