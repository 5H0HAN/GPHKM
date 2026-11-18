import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requiredMfaProofDatabaseUrl } from "@/server/auth/policy";

let connection: ReturnType<typeof drizzle> | undefined;

export function getMfaProofDb() {
  const connectionString = requiredMfaProofDatabaseUrl(process.env);
  if (!connection) connection = drizzle({ client: new Pool({ connectionString, max: 2 }) });
  return connection;
}
