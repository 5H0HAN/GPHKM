import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error("Set MIGRATION_DATABASE_URL for the local customer suspension check.");
const url = new URL(databaseUrl);
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.username) !== "gphkm_migration" || url.pathname !== "/gphkm") {
  throw new Error("This check is restricted to the local disposable GPHKM database.");
}

const db = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
let transactionOpen = false;
async function denied(label: string, sql: string, values: unknown[] = [], expectedMessage?: string) {
  await db.query("SAVEPOINT expected_customer_denial");
  try {
    await db.query(sql, values);
    assert.fail(`${label} unexpectedly succeeded`);
  } catch (error) {
    assert.equal((error as { code?: string }).code, "42501", `${label} must fail closed`);
    if (expectedMessage) assert.equal((error as { message?: string }).message, expectedMessage, `${label} reached its intended guard`);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT expected_customer_denial");
    await db.query("RELEASE SAVEPOINT expected_customer_denial");
  }
}

try {
  await db.connect();
  const current = await db.query("select current_user as role, current_database() as database");
  assert.equal(current.rows[0]?.role, "gphkm_migration");
  assert.equal(current.rows[0]?.database, "gphkm");
  await db.query("BEGIN");
  transactionOpen = true;

  const adminId = randomUUID();
  const customerId = randomUUID();
  const orgId = randomUUID();
  const inviteOrgId = randomUUID();
  const invitationId = randomUUID();
  const invitationHash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  await db.query(`INSERT INTO auth_user(id, name, email, email_verified) VALUES
    ($1, 'Suspension check Admin', $2, true), ($3, 'Suspension check Customer', $4, true)`,
  [adminId, `${adminId}@example.invalid`, customerId, `${customerId}@example.invalid`]);
  await db.query("INSERT INTO staff_account(user_id, role, active) VALUES ($1, 'ADMIN', true)", [adminId]);
  await db.query("INSERT INTO organization(id, name, created_by) VALUES ($1, 'Suspension check customer', $2)", [orgId, customerId]);
  await db.query("INSERT INTO organization_member(id, organization_id, user_id, role, active) VALUES ($1, $2, $3, 'OWNER', true)",
    [randomUUID(), orgId, customerId]);

  await db.query("SET LOCAL ROLE gphkm_runtime");
  await db.query("SELECT set_config('app.user_id', $1, true)", [adminId]);
  const suspended = await db.query<{ changed: boolean }>(
    "SELECT public.gphkm_staff_set_customer_account_state($1, 'ACTIVE', 'SUSPENDED', 'SECURITY_REVIEW') AS changed", [customerId]);
  assert.equal(suspended.rows[0]?.changed, true);

  await db.query("SELECT set_config('app.user_id', $1, true)", [customerId]);
  const active = await db.query<{ active: boolean }>("SELECT public.gphkm_customer_is_active($1) AS active", [customerId]);
  assert.equal(active.rows[0]?.active, false);
  const memberships = await db.query("SELECT id FROM organization_member WHERE user_id = $1", [customerId]);
  assert.equal(memberships.rowCount, 0, "RLS hides suspended customer membership");
  await denied("suspended customer command", "SELECT public.gphkm_assert_active_customer()", [], "customer unavailable");
  await denied("suspended customer session insertion",
    "INSERT INTO auth_session(id, user_id, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
    [randomUUID(), customerId, randomUUID()], "session unavailable");

  // Exercise the SECURITY DEFINER invitation reactivation route with an existing
  // inactive membership; this path does not pass through an INSERT RLS policy.
  await db.query("RESET ROLE");
  await db.query("INSERT INTO organization(id, name, created_by) VALUES ($1, 'Suspension invite check', $2)", [inviteOrgId, adminId]);
  await db.query(`INSERT INTO organization_member(id, organization_id, user_id, role, active)
    VALUES ($1, $2, $3, 'MEMBER', false)`, [randomUUID(), inviteOrgId, customerId]);
  await db.query(`INSERT INTO organization_invitation(id, organization_id, email, token_hash, invited_by_user_id, expires_at)
    SELECT $1, $2, email, $3, $4, now() + interval '7 days' FROM auth_user WHERE id = $5`,
  [invitationId, inviteOrgId, invitationHash, adminId, customerId]);
  await db.query("SET LOCAL ROLE gphkm_runtime");
  await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.invitation_token_hash', $2, true)",
    [customerId, invitationHash]);
  await denied("suspended invitation reactivation",
    "SELECT public.gphkm_accept_organization_invitation($1, $2)", [invitationId, randomUUID()], "invitation unavailable");
  console.log("Customer suspension guard, membership RLS, session trigger and invitation reactivation checks passed.");
} catch (error) {
  console.error("Customer suspension integration check failed.");
  throw error;
} finally {
  if (transactionOpen) await db.query("ROLLBACK").catch(() => {});
  await db.end().catch(() => {});
}
