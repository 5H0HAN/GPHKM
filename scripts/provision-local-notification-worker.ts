import { Client } from "pg";

const connectionString = process.env.MIGRATION_DATABASE_URL;
const password = process.env.GPHKM_WORKER_PASSWORD;
if (!connectionString || !password || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
  throw new Error("Local worker provisioning requires MIGRATION_DATABASE_URL and a 32–128 character random GPHKM_WORKER_PASSWORD");
}
const databaseUrl = new URL(connectionString);
if (!databaseUrl.hostname.includes("localhost") && databaseUrl.hostname !== "127.0.0.1" && databaseUrl.hostname !== "[::1]") {
  throw new Error("This provisioning script is limited to a local database");
}
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const client = new Client({ connectionString });
try {
  await client.connect();
  const database = await client.query<{ name: string }>("select current_database() as name");
  const exists = await client.query("select 1 from pg_roles where rolname = 'gphkm_worker'");
  await client.query(`ALTER ROLE gphkm_worker WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    .catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== "42704" || exists.rowCount) throw error;
      await client.query(`CREATE ROLE gphkm_worker LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    });
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database.rows[0]!.name)} TO gphkm_worker`);
  await client.query("GRANT USAGE ON SCHEMA public TO gphkm_worker");
  await client.query("REVOKE gphkm_runtime FROM gphkm_worker").catch(() => undefined);
  console.log("Local notification worker database role is provisioned with a separate password.");
} catch {
  console.error("Local notification worker provisioning failed. Check the local migration connection and role privileges.");
  process.exitCode = 1;
} finally {
  await client.end();
}
