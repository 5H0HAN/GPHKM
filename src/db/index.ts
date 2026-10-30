import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for application database access");
}

const pool = new Pool({
  connectionString,
  max: 5,
});

export const db = drizzle({ client: pool });
