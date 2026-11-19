import { Client } from "pg";

export function stagingDatabaseUrl(env) {
  const url = new URL(env.MIGRATION_DATABASE_URL);
  if (env.GPHKM_DEPLOYMENT_ENV !== "staging"
      || env.GPHKM_REAL_MONEY_ENABLED !== "false" || env.GPHKM_LAUNCH_GATES_VERIFIED !== "false"
      || env.GPHKM_LOCAL_AUTH_ENABLED === "true" || env.GPHKM_LOCAL_MFA_DISABLED === "true"
      || !["postgres:", "postgresql:"].includes(url.protocol) || url.username !== "gphkm_migration"
      || url.pathname !== "/gphkm_staging" || url.search || url.hash) {
    throw new Error("Expected the isolated staging database, disabled launch gates and mandatory MFA.");
  }
  return url.href;
}

export async function stagingTransaction(work) {
  const db = new Client({ connectionString: stagingDatabaseUrl(process.env) });
  try {
    await db.connect();
    await db.query("BEGIN");
    const result = await db.query("SELECT current_database() AS name, current_user AS role");
    if (result.rows[0].name !== "gphkm_staging" || result.rows[0].role !== "gphkm_migration") throw new Error("Unexpected database.");
    const message = await work(db);
    await db.query("COMMIT");
    return message;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}
