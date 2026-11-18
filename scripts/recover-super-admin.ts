import { parseArgs } from "node:util";
import { hashPassword } from "better-auth/crypto";
import { Client } from "pg";

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Read the password from a protected pipe");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > 4096) throw new Error("Recovery input exceeds the limit");
    chunks.push(chunk);
  }
  const password = new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks, length)).replace(/\r?\n$/, "");
  if (password.length < 16 || password.length > 128) {
    throw new Error("The recovery password must be 16–128 characters");
  }
  return password;
}

try {
  const { values } = parseArgs({
    options: {
      "user-id": { type: "string" },
      reason: { type: "string" },
      confirm: { type: "boolean" },
    },
  });
  const userId = values["user-id"];
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (process.env.GPHKM_BREAK_GLASS_RECOVERY !== "true" || !values.confirm
    || !userId || !/^[^\s\u0000-\u001f\u007f]{1,255}$/.test(userId)
    || !values.reason || !/^[A-Z0-9_]{2,64}$/.test(values.reason)
    || !connectionString || !["postgres:", "postgresql:"].includes(new URL(connectionString).protocol)) {
    throw new Error("Recovery configuration rejected");
  }

  const hash = await hashPassword(await readPassword());
  const db = new Client({ connectionString });
  try {
    await db.connect();
    await db.query("SELECT public.gphkm_break_glass_recover_super_admin($1, $2, $3)", [userId, hash, values.reason]);
  } finally {
    await db.end();
  }
  console.log(JSON.stringify({ event: "super_admin_break_glass_recovered" }));
} catch {
  // Do not print parser errors, connection details, or SQL inputs.
  console.error("Super Admin recovery failed. Check the recovery runbook and database audit.");
  process.exitCode = 1;
}
