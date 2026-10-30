import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let connection: ReturnType<typeof drizzle> | undefined;

export function getStripeWebhookDb() {
  const connectionString = process.env.STRIPE_WEBHOOK_DATABASE_URL;
  if (!connectionString) throw new Error("Stripe webhook database access is not configured");
  if (!connection) {
    connection = drizzle({ client: new Pool({ connectionString, max: 2 }) });
  }
  return connection;
}
