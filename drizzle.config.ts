import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

if (!process.env.MIGRATION_DATABASE_URL) {
  throw new Error("MIGRATION_DATABASE_URL is required for schema migrations");
}

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/identity-schema.ts", "./src/db/catalog-schema.ts", "./src/db/order-schema.ts", "./src/db/support-schema.ts", "./src/db/legal-schema.ts", "./src/db/packet-schema.ts", "./src/db/closure-schema.ts", "./src/db/cancellation-schema.ts", "./src/db/change-request-schema.ts", "./src/db/supplier-finance-schema.ts", "./src/db/post-handoff-refund-schema.ts", "./src/db/notification-schema.ts", "./src/db/reconciliation-schema.ts", "./src/db/supplier-outcome-schema.ts", "./src/db/equivalent-offer-schema.ts", "./src/db/publication-correction-schema.ts", "./src/db/supplier-notice-schema.ts"],
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
