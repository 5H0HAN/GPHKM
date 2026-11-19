import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { stagingDatabaseUrl } from "./staging-setup.mjs";

const client = new Client({ connectionString: stagingDatabaseUrl(process.env) });
try {
  await client.connect();
  // Serialize overlapping deployments before Drizzle reads its migration journal.
  await client.query("select pg_advisory_lock(hashtextextended('gphkm.staging.migrations', 0))");
  await migrate(drizzle(client), { migrationsFolder: "./src/db/migrations" });
  console.log("Staging database migrations applied.");
} finally {
  await client.end();
}
