import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let connection: ReturnType<typeof drizzle> | undefined;

export function getMfaProofDb() {
  const connectionString = process.env.MFA_PROOF_DATABASE_URL;
  if (!connectionString) throw new Error("Staff MFA proof storage is not configured");
  if (!connection) {
    connection = drizzle({ client: new Pool({ connectionString, max: 2 }) });
  }
  return connection;
}
