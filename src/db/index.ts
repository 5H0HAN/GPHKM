import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { applicationDbPoolMax } from "./pool-config.ts";

const connectionString = process.env.DATABASE_URL;
const poolMax = applicationDbPoolMax(process.env.GPHKM_DB_POOL_MAX);

if (!connectionString) {
  throw new Error("DATABASE_URL is required for application database access");
}
const pool = new Pool({
  connectionString,
  max: poolMax,
});

export const db = drizzle({ client: pool });
