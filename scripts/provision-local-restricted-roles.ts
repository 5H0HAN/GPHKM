import { Client } from "pg";

const connectionString = process.env.MIGRATION_DATABASE_URL;
const migrationPassword = process.env.POSTGRES_MIGRATION_PASSWORD;
const roles = [
  { name: "gphkm_runtime", password: process.env.GPHKM_DATABASE_PASSWORD },
  { name: "gphkm_worker", password: process.env.GPHKM_WORKER_PASSWORD },
  { name: "gphkm_webhook", password: process.env.GPHKM_WEBHOOK_PASSWORD },
  { name: "gphkm_resend_webhook", password: process.env.GPHKM_RESEND_WEBHOOK_PASSWORD },
  { name: "gphkm_mfa_proof", password: process.env.GPHKM_MFA_PROOF_PASSWORD },
] as const;
if (!connectionString || !migrationPassword || !/^[A-Za-z0-9_-]{32,128}$/.test(migrationPassword) ||
    roles.some(({ password }) => !password || !/^[A-Za-z0-9_-]{32,128}$/.test(password))) {
  throw new Error("Local database-role provisioning requires migration access and separate random passwords");
}
if (new Set([migrationPassword, ...roles.map(({ password }) => password)]).size !== roles.length + 1) {
  throw new Error("Each local database role must have a distinct password");
}
const databaseUrl = new URL(connectionString);
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    databaseUrl.username !== "gphkm_migration" || decodeURIComponent(databaseUrl.password) !== migrationPassword) {
  throw new Error("This provisioning script is limited to a local database");
}
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const client = new Client({ connectionString });
try {
  await client.connect();
  const database = await client.query<{ name: string }>("select current_database() as name");
  for (const role of roles) {
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [role.name]);
    const config = `LOGIN PASSWORD ${quoteLiteral(role.password!)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`;
    if (exists.rowCount) await client.query(`ALTER ROLE ${quoteIdentifier(role.name)} WITH ${config}`);
    else await client.query(`CREATE ROLE ${quoteIdentifier(role.name)} ${config}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database.rows[0]!.name)} TO ${quoteIdentifier(role.name)}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role.name)}`);
    if (role.name !== "gphkm_runtime") {
      await client.query(`REVOKE gphkm_runtime FROM ${quoteIdentifier(role.name)}`).catch(() => undefined);
    }
  }
  const memberships = await client.query<{ member: string; parent: string }>(
    `select member.rolname as member, parent.rolname as parent
       from pg_auth_members membership
       join pg_roles member on member.oid = membership.member
       join pg_roles parent on parent.oid = membership.roleid
      where member.rolname = any($1::text[])`,
    [roles.map(({ name }) => name)],
  );
  if (memberships.rowCount) throw new Error("Application roles must not be members of other database roles");
  console.log("Local application, worker, Stripe webhook, Resend webhook, and MFA-proof roles are provisioned with separate credentials.");
} catch {
  console.error("Local database-role provisioning failed. Check migration access and local role configuration.");
  process.exitCode = 1;
} finally {
  await client.end();
}
