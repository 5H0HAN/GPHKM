import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Client } from "pg";
import { assertBootstrapAvailable, bootstrapSettings } from "../src/server/auth/policy.ts";

// The package script sets NODE_ENV=development and loads the ignored .env file.
// Only the controlled setup process uses migration credentials; request handlers never do.
const settings = bootstrapSettings(process.env);
const passwordHash = await hashPassword(settings.password);
const customerPasswordHash = await hashPassword(settings.customerPassword);
const client = new Client({ connectionString: settings.databaseUrl });
try {
  await client.connect();
  await client.query("BEGIN");
  // Serialize concurrent bootstrap attempts and account creation before checking identity reuse.
  await client.query("LOCK TABLE staff_bootstrap, staff_account, auth_user IN EXCLUSIVE MODE");
  const staff = await client.query("SELECT 1 FROM staff_account LIMIT 1");
  const bootstrap = await client.query("SELECT 1 FROM staff_bootstrap LIMIT 1");
  const existing = await client.query("SELECT 1 FROM auth_user WHERE lower(email) = ANY($1::text[]) LIMIT 1", [[settings.email, settings.customerEmail]]);
  assertBootstrapAvailable(staff.rowCount !== 0, bootstrap.rowCount !== 0, existing.rowCount !== 0);
  const staffId = randomUUID();
  const customerId = randomUUID();
  for (const [id, email, name, hash] of [
    [staffId, settings.email, "Local Super Admin", passwordHash],
    [customerId, settings.customerEmail, "Local Customer", customerPasswordHash],
  ]) {
    // Verified fixtures are created only here; no HTTP signup or global verification bypass exists.
    await client.query("INSERT INTO auth_user (id, name, email, email_verified) VALUES ($1, $2, $3, true)", [id, name, email]);
    await client.query("INSERT INTO auth_account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)", [randomUUID(), id, hash]);
  }
  await client.query("INSERT INTO staff_account (user_id, role) VALUES ($1, 'SUPER_ADMIN')", [staffId]);
  const organizationId = randomUUID();
  await client.query("INSERT INTO organization (id, name, created_by) VALUES ($1, $2, $3)", [organizationId, "Local Test Organization", customerId]);
  await client.query("INSERT INTO organization_member (id, organization_id, user_id, role) VALUES ($1, $2, $3, 'OWNER')", [randomUUID(), organizationId, customerId]);
  await client.query("INSERT INTO wallet_account (organization_id, currency) VALUES ($1, 'USD') ON CONFLICT (organization_id) DO NOTHING", [organizationId]);
  await client.query("INSERT INTO access_policy (id, minimum_minor, duration, version, updated_by) VALUES (1, 5000, 'SIX_MONTHS', 1, $1) ON CONFLICT (id) DO NOTHING", [staffId]);
  await client.query("INSERT INTO staff_bootstrap (id, user_id, action) VALUES (1, $1, 'LOCAL_TEST_IDENTITIES_CREATED')", [staffId]);
  await client.query("COMMIT");
  console.log("Local customer and Super Admin fixtures created. Staff access requires enrolled MFA and a verified staff session.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  if (error instanceof Error && error.message === "Initial staff bootstrap has already been used") {
    console.log("Local customer and Super Admin fixtures already exist. Existing passwords were not changed; use the values in the ignored .env file.");
    process.exitCode = 0;
  } else if (error instanceof Error && error.message === "Bootstrap cannot elevate an existing account") {
    console.error("Local bootstrap stopped because a configured fixture email already exists. No account was elevated.");
    process.exitCode = 1;
  } else if (error instanceof Error && error.message === "A staff account already exists") {
    console.error("Local bootstrap stopped because a staff account exists without the one-time fixture marker. No account was elevated.");
    process.exitCode = 1;
  } else {
  // Never log driver errors, connection URLs, credentials, or user input.
    console.error("Local bootstrap failed. Check configuration and migrations; no accounts were elevated.");
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
