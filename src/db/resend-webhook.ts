import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let connection: typeof import("@/db").db | undefined;

export function getResendWebhookDb() {
  const connectionString = process.env.RESEND_WEBHOOK_DATABASE_URL;
  if (!connectionString) throw new Error("Resend webhook database access is not configured");
  if (!connection) {
    connection = drizzle({ client: new Pool({ connectionString, max: 2 }) }) as typeof import("@/db").db;
  }
  return connection;
}
