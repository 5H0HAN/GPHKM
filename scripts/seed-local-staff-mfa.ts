import { randomUUID } from "node:crypto";
import { symmetricEncrypt, generateRandomString } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { Client } from "pg";
import { assertLoopbackUrl, localAuthEnabled, localStaffMfaDisabled, requiredEnv } from "../src/server/auth/policy.ts";

if (process.env.NODE_ENV !== "development" || !localAuthEnabled(process.env) || !localStaffMfaDisabled(process.env)) {
  throw new Error("This fixture requires development mode, local auth, and the local staff MFA bypass");
}

const email = process.argv[2]?.trim().toLowerCase() ?? "";
const showSecret = process.argv.includes("--show-secret");
if (!showSecret) throw new Error("Pass --show-secret so the generated TOTP seed can be added to your local authenticator");
if (!process.stdout.isTTY) throw new Error("Run this command in a private interactive terminal so the TOTP seed is not captured");
if (!/^[^\s@]+@gphkm\.test$/.test(email)) throw new Error("Pass a local staff account using the reserved gphkm.test domain");
const databaseUrl = assertLoopbackUrl(requiredEnv(process.env, "MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL");
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)
    || decodeURIComponent(databaseUrl.username) !== "gphkm_migration"
    || databaseUrl.pathname !== "/gphkm") {
  throw new Error("This fixture requires the local GPHKM migration database");
}

const secretKey = requiredEnv(process.env, "BETTER_AUTH_SECRET");
const factorSecret = generateRandomString(32);
const encryptedSecret = await symmetricEncrypt({ key: secretKey, data: factorSecret });
const encryptedEmptyBackupCodes = await symmetricEncrypt({ key: secretKey, data: "[]" });
const db = new Client({ connectionString: databaseUrl.toString() });

try {
  await db.connect();
  await db.query("BEGIN");
  const account = await db.query<{ id: string; email_verified: boolean }>(
    "SELECT u.id, u.email_verified FROM auth_user u JOIN staff_account s ON s.user_id=u.id WHERE u.email=$1 FOR UPDATE OF u",
    [email],
  );
  if (account.rowCount !== 1 || account.rows[0].email_verified !== true) {
    throw new Error("A verified local staff account was not found");
  }
  const existing = await db.query("SELECT 1 FROM auth_two_factor WHERE user_id=$1", [account.rows[0].id]);
  if (existing.rowCount) throw new Error("The local staff account already has a factor; reset it through the staff workflow first");
  await db.query(
    "INSERT INTO auth_two_factor(id,secret,backup_codes,user_id,verified) VALUES ($1,$2,$3,$4,true)",
    [randomUUID(), encryptedSecret, encryptedEmptyBackupCodes, account.rows[0].id],
  );
  await db.query("UPDATE auth_user SET two_factor_enabled=true WHERE id=$1", [account.rows[0].id]);
  await db.query("COMMIT");
  console.log(`Local TOTP provisioning URI (contains a reusable secret; keep it private): ${createOTP(factorSecret).url("GPHKM Staff", email)}`);
} catch (error) {
  await db.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await db.end().catch(() => {});
}
