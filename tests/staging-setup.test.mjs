import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { stagingDatabaseUrl } from "../scripts/staging-setup.mjs";

const flags = {
  GPHKM_DEPLOYMENT_ENV: "staging", GPHKM_REAL_MONEY_ENABLED: "false", GPHKM_LAUNCH_GATES_VERIFIED: "false",
};
test("staging setup requires an explicitly isolated target and closed launch gates", () => {
  const env = { ...flags, MIGRATION_DATABASE_URL: "postgres://gphkm_migration@localhost/gphkm_staging" };
  assert.equal(stagingDatabaseUrl(env), env.MIGRATION_DATABASE_URL);
  for (const override of [
    { GPHKM_DEPLOYMENT_ENV: "production" }, { GPHKM_REAL_MONEY_ENABLED: "true" }, { GPHKM_LAUNCH_GATES_VERIFIED: undefined },
    { GPHKM_LOCAL_AUTH_ENABLED: "true" }, { GPHKM_LOCAL_MFA_DISABLED: "true" }, { MIGRATION_DATABASE_URL: "postgres://gphkm_migration@localhost/gphkm" },
    { MIGRATION_DATABASE_URL: "postgres://gphkm_runtime@localhost/gphkm_staging" },
  ]) assert.throws(() => stagingDatabaseUrl({ ...env, ...override }));
});

test("staging catalog replay, customer row visibility and first staff bootstrap", {
  skip: process.env.GPHKM_CHECK_ISOLATED_STAGING_DB !== "true",
}, async () => {
  const migrationUrl = new URL(stagingDatabaseUrl(process.env));
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  assert.equal(migrationUrl.hostname, "127.0.0.1");
  assert.equal(runtimeUrl.host, migrationUrl.host);
  assert.equal(runtimeUrl.pathname, migrationUrl.pathname);
  assert.equal(runtimeUrl.username, "gphkm_runtime");
  const db = new Client({ connectionString: migrationUrl.href });
  const runtime = new Client({ connectionString: runtimeUrl.href });
  const command = (script, args = [], env = {}, input = "") => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env }, input, encoding: "utf8",
  }).status;
  try {
    await db.connect();
    await runtime.connect();
    const count = async (table) => Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    assert.equal(await count("auth_user"), 0, "This check needs a freshly migrated scratch database.");
    assert.equal(await count("marketplace_listing"), 0);
    assert.equal(command("scripts/seed-staging-demo.mjs"), 0);
    assert.equal(command("scripts/seed-staging-demo.mjs"), 0);
    for (const [table, expected] of Object.entries({
      auth_user: 1, auth_account: 0, staff_account: 0, organization_member: 0, wallet_ledger_entry: 0,
      supplier: 1, marketplace_listing: 3, marketplace_listing_revision: 3,
    })) assert.equal(await count(table), expected, table);
    assert.equal((await db.query(`SELECT retail_price_cents FROM marketplace_listing
      WHERE title = 'Demo Garden Journal'`)).rows[0]?.retail_price_cents, "5000",
    "one demo offer matches the $50 qualifying wallet top-up");
    assert.equal((await db.query(`SELECT count(*) FROM supplier_contact
      WHERE email = 'demo-contact@staging.invalid' AND is_primary`)).rows[0]?.count, "1",
    "the supplier-backed demo offer has a synthetic non-deliverable primary recipient");

    const customer = randomUUID();
    const org = randomUUID();
    const email = "demo-owner@example.com";
    await db.query("INSERT INTO auth_user(id,name,email,email_verified) VALUES ($1,'Test Customer',$2,true)", [customer, email]);
    await db.query("INSERT INTO organization(id,name,created_by) VALUES ($1,'Test Org',$2)", [org, customer]);
    await db.query("INSERT INTO organization_member(id,organization_id,user_id,role) VALUES ($1,$2,$3,'OWNER')", [randomUUID(), org, customer]);
    await runtime.query("BEGIN");
    assert.equal((await runtime.query("SELECT id FROM marketplace_listing")).rowCount, 0);
    await runtime.query("SELECT set_config('app.user_id',$1,true),set_config('app.organization_id',$2,true)", [customer, org]);
    assert.equal((await runtime.query("SELECT id FROM marketplace_listing")).rowCount, 3);
    assert.equal((await runtime.query("SELECT listing_id FROM marketplace_listing_url")).rowCount, 1);
    assert.equal((await runtime.query("SELECT listing_id FROM marketplace_listing_sourcing")).rowCount, 0);
    assert.equal((await runtime.query("SELECT id FROM supplier")).rowCount, 0);
    await runtime.query("ROLLBACK");

    const bootstrap = (mailbox, args) => command("scripts/bootstrap-staging-admin.mjs", args,
      { GPHKM_STAGING_ADMIN_EMAIL: mailbox }, randomBytes(32).toString("hex"));
    const adminEmail = "staging-admin@example.com";
    assert.equal(bootstrap(adminEmail, []), 1);
    assert.equal(bootstrap(email, ["--mailbox-verified"]), 1);
    assert.equal(await count("staff_account"), 0);
    assert.equal(bootstrap(adminEmail, ["--mailbox-verified"]), 0);
    assert.equal(bootstrap(adminEmail, ["--mailbox-verified"]), 1);
    assert.equal(await count("staff_bootstrap"), 1);
    assert.equal(await count("staff_account"), 1);
    assert.equal(await count("auth_account"), 1);
    assert.equal(await count("auth_two_factor"), 0);
    assert.equal(await count("staff_mfa_session"), 0);
    assert.equal(await count("auth_session"), 0);
    assert.equal(await count("wallet_ledger_entry"), 0);
  } finally {
    await Promise.all([db.end(), runtime.end()]);
  }
});
