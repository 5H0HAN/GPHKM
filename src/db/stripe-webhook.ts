import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let connection: ReturnType<typeof drizzle> | undefined;

export function getStripeWebhookDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.STRIPE_WEBHOOK_DATABASE_URL?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.username && url.pathname.length > 1
      ? value : null;
  } catch {
    return null;
  }
}

export function getStripeWebhookDb() {
  const connectionString = getStripeWebhookDatabaseUrl();
  if (!connectionString) throw new Error("Stripe webhook database access is not configured");
  if (!connection) {
    connection = drizzle({ client: new Pool({ connectionString, max: 2 }) });
  }
  return connection;
}
