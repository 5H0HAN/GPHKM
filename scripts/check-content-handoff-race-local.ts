import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const sourceMigrationUrl = process.env.MIGRATION_DATABASE_URL;
const sourceRuntimeUrl = process.env.DATABASE_URL;

function localProjectUrl(value: string | undefined, role: string) {
  if (!value) throw new Error("Concurrency check requires local database URLs from .env");
  const url = new URL(value);
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || !["postgres:", "postgresql:"].includes(url.protocol)
      || decodeURIComponent(url.username) !== role || url.pathname !== "/gphkm") {
    throw new Error("Concurrency check is restricted to the local GPHKM database and expected role");
  }
  return url;
}

const migrationUrl = localProjectUrl(sourceMigrationUrl, "gphkm_migration");
const runtimeUrl = localProjectUrl(sourceRuntimeUrl, "gphkm_runtime");
const databaseName = `gphkm_race_${process.pid}_${randomUUID().slice(0, 8)}`;
const dbIdentifier = `"${databaseName}"`;
const isolatedMigrationUrl = new URL(migrationUrl);
const isolatedRuntimeUrl = new URL(runtimeUrl);
isolatedMigrationUrl.pathname = `/${databaseName}`;
isolatedRuntimeUrl.pathname = `/${databaseName}`;

const administrator = new Client({ connectionString: migrationUrl.href, connectionTimeoutMillis: 5000 });
let created = false;
const connections: Client[] = [];

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntilBlocked(observer: Client, blockedPid: number, label: string) {
  for (let index = 0; index < 200; index += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where pid = $1 and wait_event_type = 'Lock' and state = 'active') as blocked`,
      [blockedPid],
    );
    if (result.rows[0]?.blocked) return;
    await sleep(25);
  }
  const activity = await observer.query<{ state: string; wait_event_type: string | null; wait_event: string | null }>(
    "select state, wait_event_type, wait_event from pg_stat_activity where pid = $1", [blockedPid],
  );
  throw new Error(`${label} session did not block as expected (${JSON.stringify(activity.rows[0] ?? null)})`);
}

async function expectContentConsentRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("A consent event must be rejected after handoff commits");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "23514",
      "post-handoff consent must fail at the database trigger boundary");
  }
}

async function expectAssignmentAuthorityRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("Assignment by a concurrently deactivated staff actor must be rejected");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501",
      "assignment must recheck actor authority after waiting for the staff row lock");
  }
}

try {
  await administrator.connect();
  const collision = await administrator.query<{ exists: boolean }>(
    "select exists (select 1 from pg_database where datname = $1) as exists", [databaseName],
  );
  assert.equal(collision.rows[0]?.exists, false, "generated isolated database name must be unused");
  await administrator.query(`create database ${dbIdentifier} owner gphkm_migration template template0`);
  created = true;

  const migrate = spawnSync("npx", ["drizzle-kit", "migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, MIGRATION_DATABASE_URL: isolatedMigrationUrl.href },
    encoding: "utf8",
  });
  if (migrate.status !== 0) {
    throw new Error(`Isolated migration failed${migrate.stderr ? `: ${migrate.stderr.trim()}` : ""}`);
  }

  const setup = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
  const handoff = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
  const consent = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
  const observer = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
  connections.push(setup, handoff, consent, observer);
  await Promise.all(connections.map((client) => client.connect()));

  const ownerId = randomUUID();
  const adminId = randomUUID();
  const targetAdminId = randomUUID();
  const superAdminId = randomUUID();
  const organizationId = randomUUID();
  const orderId = randomUUID();
  const listingIds = [randomUUID(), randomUUID()];
  const itemIds = [randomUUID(), randomUUID()];
  const requestIds = [randomUUID(), randomUUID()];
  const versionIds = [randomUUID(), randomUUID()];
  const hash = "a".repeat(64);

  await setup.query("begin");
  await setup.query(
    `insert into auth_user (id, name, email, email_verified) values
       ($1, 'Consent race fixture owner', $2, true), ($3, 'Consent race fixture admin', $4, true),
       ($5, 'Consent race fixture target admin', $6, true), ($7, 'Consent race fixture super admin', $8, true)`,
    [ownerId, `${ownerId}@fixture.invalid`, adminId, `${adminId}@fixture.invalid`,
      targetAdminId, `${targetAdminId}@fixture.invalid`, superAdminId, `${superAdminId}@fixture.invalid`],
  );
  await setup.query(
    "insert into staff_account (user_id, role, active) values ($1, 'ADMIN', true), ($2, 'ADMIN', true), ($3, 'SUPER_ADMIN', true)",
    [adminId, targetAdminId, superAdminId],
  );
  await setup.query("insert into organization (id, name, created_by) values ($1, 'Consent race fixture', $2)", [organizationId, ownerId]);
  await setup.query(
    "insert into organization_member (id, organization_id, user_id, role, active) values ($1, $2, $3, 'OWNER', true)",
    [randomUUID(), organizationId, ownerId],
  );
  await setup.query("insert into wallet_account (organization_id, currency) values ($1, 'USD')", [organizationId]);
  // This isolated fixture does not test checkout admission or the deferred
  // debit invariant; the RLS smoke separately covers exact wallet checkout.
  await setup.query("alter table customer_order disable trigger customer_order_requires_debit");
  await setup.query(
    `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
       placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version,
       content_policy_version, content_policy_accepted_at, customer_status, checkout_state)
     values ($1, $2, $3, $4, $5, 2000, 0, 2000, 'race-fixture-v1', 'gphkm-content-policy-v1', now(), 'ORDER_RECEIVED', 'PENDING_POST')`,
    [orderId, organizationId, ownerId, `race-${orderId}`, hash],
  );
  const pendingOrder = await setup.query<{ checkout_state: string; customer_status: string }>(
    "select checkout_state, customer_status from customer_order where id = $1", [orderId],
  );
  assert.deepEqual(pendingOrder.rows[0], { checkout_state: "PENDING_POST", customer_status: "ORDER_RECEIVED" },
    "synthetic order must remain open for item creation");
  // The race regression concerns consent/handoff serialization. Seed the
  // already-created synthetic order items as the migration owner, then restore
  // the checkout admission trigger before any race transaction starts.
  await setup.query("alter table customer_order_item disable trigger customer_order_item_pending_only");
  for (let index = 0; index < listingIds.length; index += 1) {
    await setup.query(
      `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
         retail_price_cents, link_type, link_validity, turnaround_days, sponsored_content_marking,
         status, allows_sports_and_gaming, allows_pharmacy, allows_crypto, allows_foreign_language)
       values ($1, $2, 'Synthetic database concurrency fixture', 'US', 'English', ARRAY['General'],
         1000, 'DOFOLLOW', 'PERMANENT', 30, false, 'DRAFT', false, false, false, false)`,
      [listingIds[index], `Consent race fixture ${index + 1}`],
    );
    await setup.query(
      `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
         placement_price_minor, writing_selected, target_url, anchor_text, article_text,
         supplier_sharing_consented, consent_notice_version)
       values ($1, $2, $3, 1, $4::jsonb, 1000, false, 'https://example.invalid/race', 'fixture link',
         'Synthetic article for a local database concurrency regression', true, 'race-fixture-v1')`,
      [itemIds[index], orderId, listingIds[index], JSON.stringify({ title: `Race fixture ${index + 1}` })],
    );
    await setup.query(
      `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
       values ($1, 'PLATFORM_OWNED', null, null)`, [itemIds[index]],
    );
    const stateAfterItem = await setup.query<{ checkout_state: string; customer_status: string }>(
      "select checkout_state, customer_status from customer_order where id = $1", [orderId],
    );
    assert.deepEqual(stateAfterItem.rows[0], { checkout_state: "PENDING_POST", customer_status: "ORDER_RECEIVED" },
      "synthetic order must remain open between fixture item inserts");
    await setup.query("update order_item_fulfillment set state = 'READY_FOR_HANDOFF', assigned_admin_id = $2 where order_item_id = $1",
      [itemIds[index], adminId]);
    await setup.query(
      `insert into order_item_content_change_request (id, order_item_id, request_number, requested_by_user_id,
         target_url, article_text)
       values ($1, $2, 1, $3, 'https://example.invalid/revised', 'Synthetic approved content version')`,
      [requestIds[index], itemIds[index], ownerId],
    );
    await setup.query(
      `insert into order_item_content_version (id, order_item_id, request_id, version, target_url, anchor_text,
         article_text, instructions, supplier_id, recipient_email, content_hash, approved_by_user_id)
       values ($1, $2, $3, 2, 'https://example.invalid/revised', 'fixture revised link',
         'Synthetic approved content version', '', null, 'GPHKM_INTERNAL', $4, $5)`,
      [versionIds[index], itemIds[index], requestIds[index], hash, adminId],
    );
    await setup.query(
      `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, created_at)
       values ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
      [randomUUID(), requestIds[index], adminId, versionIds[index], hash],
    );
    await setup.query(
      `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version, created_at)
       values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1', clock_timestamp())`,
      [randomUUID(), requestIds[index], ownerId, versionIds[index], hash],
    );
  }
  await setup.query("alter table customer_order_item enable trigger customer_order_item_pending_only");
  await setup.query("alter table customer_order enable trigger customer_order_requires_debit");
  await setup.query("commit");

  // Handoff locks the item first. The customer INSERT then begins with the old
  // statement snapshot and waits for that lock; after handoff commits, the
  // trigger must reject based on the newer row returned by SELECT FOR UPDATE.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminId]);
  const handoffFirst = await handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = clock_timestamp(), work_started_at = clock_timestamp(), updated_at = clock_timestamp()
     where order_item_id = $1`, [itemIds[0]],
  );
  assert.equal(handoffFirst.rowCount, 1, "handoff-first race must lock and update one assigned fulfillment item");
  const consentBackend = await consent.query<{ pid: number }>("select pg_backend_pid() as pid");
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  let consentOutcome = "pending";
  const blockedConsent = consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), requestIds[0], ownerId, versionIds[0], hash],
  ).then((result) => { consentOutcome = `resolved:${result.rowCount}`; return result; }, (error: unknown) => {
    consentOutcome = typeof error === "object" && error !== null && "code" in error ? `rejected:${String(error.code)}` : "rejected";
    throw error;
  });
  try { await waitUntilBlocked(observer, consentBackend.rows[0]!.pid, "Handoff-first consent"); }
  catch (error) {
    try { await blockedConsent; console.error("Consent attempt unexpectedly completed before handoff commit"); }
    catch (consentError) { console.error(`Consent attempt rejected before handoff commit: ${String(consentOutcome)} ${consentError instanceof Error ? consentError.message : ""}`); }
    throw error;
  }
  await handoff.query("commit");
  await expectContentConsentRejected(blockedConsent);
  await consent.query("rollback");

  // In the opposite order, consent commits first and a new handoff statement
  // sees that committed version and proceeds. A later duplicate consent stays
  // closed by the same database trigger.
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), requestIds[1], ownerId, versionIds[1], hash],
  );
  const handoffBackend = await handoff.query<{ pid: number }>("select pg_backend_pid() as pid");
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminId]);
  const blockedHandoff = handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = clock_timestamp(), work_started_at = clock_timestamp(), updated_at = clock_timestamp()
     where order_item_id = $1`, [itemIds[1]],
  );
  await waitUntilBlocked(observer, handoffBackend.rows[0]!.pid, "Consent-first handoff");
  await consent.query("commit");
  await blockedHandoff;
  await handoff.query("commit");
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), requestIds[1], ownerId, versionIds[1], hash],
  ));
  await consent.query("rollback");

  // Move all active items off the Admin, then race their deactivation against
  // an assignment command started with the old authority. The command must
  // wait on the staff row and reject after the deactivation commits.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [superAdminId]);
  for (const itemId of itemIds) {
    await handoff.query("select public.gphkm_assign_fulfillment_item($1, null)", [itemId]);
  }
  await handoff.query("commit");

  await setup.query("begin");
  await setup.query("update staff_account set active = false where user_id = $1", [adminId]);
  const assignmentBackend = await consent.query<{ pid: number }>("select pg_backend_pid() as pid");
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [adminId]);
  let assignmentOutcome = "pending";
  const blockedAssignment = consent.query(
    "select public.gphkm_assign_fulfillment_item($1, $2)", [itemIds[0], targetAdminId],
  ).then((result) => { assignmentOutcome = `resolved:${result.rowCount}`; return result; }, (error: unknown) => {
    assignmentOutcome = typeof error === "object" && error !== null && "code" in error ? `rejected:${String(error.code)}` : "rejected";
    throw error;
  });
  try {
    await waitUntilBlocked(observer, assignmentBackend.rows[0]!.pid, "Deactivation-first assignment");
  } catch (error) {
    console.error(`Assignment race result before deactivation commit: ${assignmentOutcome}`);
    throw error;
  }
  await setup.query("commit");
  await expectAssignmentAuthorityRejected(blockedAssignment);
  await consent.query("rollback");
  const actorAuthority = await setup.query<{ active: boolean; assigned_count: string }>(
    `select staff.active,
       (select count(*)::text from order_item_fulfillment where assigned_admin_id = $1 and state not in ('COMPLETED','CANCELED_REFUNDED')) as assigned_count
     from staff_account staff where staff.user_id = $1`, [adminId],
  );
  assert.deepEqual(actorAuthority.rows[0], { active: false, assigned_count: "0" },
    "deactivation wins authority race and assignment leaves no work on the deactivated account");

  const finalStates = await setup.query<{ state: string; handed_off_at: Date | null }>(
    "select state, handed_off_at from order_item_fulfillment where order_item_id = any($1::text[]) order by order_item_id",
    [itemIds],
  );
  assert.equal(finalStates.rowCount, 2);
  assert.ok(finalStates.rows.every((row) => row.state === "IN_FULFILLMENT" && row.handed_off_at),
    "both ordering permutations leave the handoff committed and reject any later consent event");
  console.log("Local two-session security races passed: consent/handoff was checked in both commit orders, post-handoff consent was denied, and a deactivated assignment actor could not mutate work after waiting.");
} catch (error) {
  if (error instanceof Error) console.error(error.message);
  if (typeof error === "object" && error !== null && "where" in error && typeof error.where === "string") console.error(error.where);
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") console.error(error.detail);
  process.exitCode = 1;
} finally {
  await Promise.all(connections.map((client) => client.end().catch(() => undefined)));
  if (created) {
    await administrator.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]).catch(() => undefined);
    await administrator.query(`drop database if exists ${dbIdentifier} with (force)`).catch((error: unknown) => {
      console.error(error instanceof Error ? `Could not remove isolated test database: ${error.message}` : "Could not remove isolated test database");
      process.exitCode = 1;
    });
  }
  await administrator.end().catch(() => undefined);
}
