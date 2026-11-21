\set ON_ERROR_STOP on
SELECT format(
  'ALTER ROLE gphkm_worker WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'worker_password'
) \gexec
GRANT CONNECT ON DATABASE gphkm_staging TO gphkm_worker;
GRANT USAGE ON SCHEMA public TO gphkm_worker;
REVOKE gphkm_runtime FROM gphkm_worker;
