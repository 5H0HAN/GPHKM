import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

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

async function expectContentConsentRejected(query: Promise<{ rows: unknown[] }>, expectedMessage?: RegExp) {
  try {
    await query;
    assert.fail("A consent event must be rejected after handoff commits");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "23514",
      "post-handoff consent must fail at the database trigger boundary");
    if (expectedMessage) assert.match(error instanceof Error ? error.message : String(error), expectedMessage);
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

async function expectSupplierHandoffRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("Work start must not pass with only the old supplier route's packet evidence");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501",
      "work start must re-read the accepted current route after waiting for the item lock");
  }
}

async function expectEquivalentAcceptanceRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("Equivalent acceptance must not change routing after work start commits");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501",
      "direct acceptance must revalidate handoff state after acquiring the item lock");
  }
}

async function expectPacketAttemptRejected(client: Client, packetId: string, attemptId: string, actorId: string, expectedMessage: RegExp) {
  await client.query("savepoint packet_attempt_guard_check");
  let rejected: unknown;
  try {
    await client.query(
      `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key, provider)
       values ($1, $2, 'EML_EXPORT', 'EXPORTED', $3, 'replacement@race-fixture.invalid', $4, null)`,
      [attemptId, packetId, actorId, `route-check-${attemptId}`],
    );
  } catch (error) { rejected = error; }
  await client.query("rollback to savepoint packet_attempt_guard_check");
  await client.query("release savepoint packet_attempt_guard_check");
  assert.ok(rejected, "a stale supplier packet must not accept a new export attempt");
  assert.equal(typeof rejected === "object" && rejected !== null && "code" in rejected ? rejected.code : null, "42501");
  assert.match(rejected instanceof Error ? rejected.message : String(rejected), expectedMessage,
    "the database route guard, rather than only RLS, must reject the packet attempt");
}

async function expectSupplierFailureCaseCloseRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("an unresolved supplier-failure case must remain open");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "42501");
    assert.match(error instanceof Error ? error.message : String(error), /supplier failure case must remain active/);
  }
}

async function expectSupplierNoticeWithoutDeliveryRejected(query: Promise<{ rows: unknown[] }>) {
  try {
    await query;
    assert.fail("A supplier notice must not be prepared from an unsent packet");
  } catch (error) {
    assert.equal(typeof error === "object" && error !== null && "code" in error ? error.code : null, "23514");
    assert.match(error instanceof Error ? error.message : String(error), /current-route delivery evidence/);
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

  const migrationPool = new Pool({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: "./src/db/migrations" });
  } finally {
    await migrationPool.end();
  }

  const setup = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
  const handoff = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
  const consent = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
  const observer = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
  connections.push(setup, handoff, consent, observer);
  await Promise.all(connections.map((client) => client.connect()));

  const ownerId = randomUUID();
  const caseOwnerId = randomUUID();
  const adminId = randomUUID();
  const targetAdminId = randomUUID();
  const superAdminId = randomUUID();
  const organizationId = randomUUID();
  const orderId = randomUUID();
  const routeListingId = randomUUID();
  const routeItemId = randomUUID();
  const routeSupportCaseId = randomUUID();
  const routeFailureOutcomeId = randomUUID();
  const routeReturnCaseId = randomUUID();
  const routeReturnFailureOutcomeId = randomUUID();
  const routeReturnRequestId = randomUUID();
  const routeReturnVersionId = randomUUID();
  const routeReturnOfferId = randomUUID();
  const routeMismatchFailureOutcomeId = randomUUID();
  const routeMismatchRequestId = randomUUID();
  const routeMismatchVersionId = randomUUID();
  const routeMismatchOfferId = randomUUID();
  const routeRequestId = randomUUID();
  const routeVersionId = randomUUID();
  const routeOfferId = randomUUID();
  const supplierAId = randomUUID();
  const supplierBId = randomUUID();
  const routePacketId = `pkt_${randomUUID()}`;
  const routeOriginalPacketId = `pkt_${randomUUID()}`;
  const routeUnsentPacketId = `pkt_${randomUUID()}`;
  const routeNoticeId = randomUUID();
  const routeOriginalPacketAttemptId = randomUUID();
  const routeOlderPacketId = `pkt_${randomUUID()}`;
  const routeSupersededPacketId = `pkt_${randomUUID()}`;
  const routeHeldPacketId = `pkt_${randomUUID()}`;
  const routeFreshAPacketId = `pkt_${randomUUID()}`;
  const routePacketAttemptId = randomUUID();
  const routeReservationAttemptId = randomUUID();
  const routeFreshAAttemptId = randomUUID();
  const routeReturnContentHash = "d".repeat(64);
  const routeMismatchContentHash = "b".repeat(64);
  const listingIds = [randomUUID(), randomUUID()];
  const itemIds = [randomUUID(), randomUUID()];
  const requestIds = [randomUUID(), randomUUID()];
  const versionIds = [randomUUID(), randomUUID()];
  const hash = "a".repeat(64);
  const routeContentHash = "c".repeat(64);

  await setup.query("begin");
  await setup.query(
    `insert into auth_user (id, name, email, email_verified) values
       ($1, 'Consent race fixture owner', $2, true), ($3, 'Consent race fixture admin', $4, true),
       ($5, 'Consent race fixture target admin', $6, true), ($7, 'Consent race fixture super admin', $8, true),
       ($9, 'Consent race fixture case owner', $10, true)`,
    [ownerId, `${ownerId}@fixture.invalid`, adminId, `${adminId}@fixture.invalid`,
      targetAdminId, `${targetAdminId}@fixture.invalid`, superAdminId, `${superAdminId}@fixture.invalid`,
      caseOwnerId, `${caseOwnerId}@fixture.invalid`],
  );
  await setup.query(
    "insert into staff_account (user_id, role, active) values ($1, 'ADMIN', true), ($2, 'ADMIN', true), ($3, 'SUPER_ADMIN', true)",
    [adminId, targetAdminId, superAdminId],
  );
  await setup.query(
    "insert into supplier (id, name, status, created_by_user_id) values ($1, 'Race Original Supplier', 'ACTIVE', $3), ($2, 'Race Replacement Supplier', 'ACTIVE', $3)",
    [supplierAId, supplierBId, adminId],
  );
  await setup.query(
    `insert into supplier_contact (id, supplier_id, name, email, is_primary) values
       ($1, $3, 'Original Supplier Contact', 'original@race-fixture.invalid', true),
       ($2, $4, 'Replacement Supplier Contact', 'replacement@race-fixture.invalid', true)`,
    [randomUUID(), randomUUID(), supplierAId, supplierBId],
  );
  await setup.query("insert into organization (id, name, created_by) values ($1, 'Consent race fixture', $2)", [organizationId, ownerId]);
  await setup.query(
    "insert into organization_member (id, organization_id, user_id, role, active) values ($1, $2, $3, 'OWNER', true), ($4, $2, $5, 'OWNER', true)",
    [randomUUID(), organizationId, ownerId, randomUUID(), caseOwnerId],
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

  // Exercise the SECURITY DEFINER acceptance function directly, bypassing the
  // application wrapper that already locks the item. Acceptance must still
  // lock the item before touching the supplier route.
  await setup.query("begin");
  await setup.query(
    `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
       retail_price_cents, link_type, link_validity, turnaround_days, sponsored_content_marking, status,
       allows_sports_and_gaming, allows_pharmacy, allows_crypto, allows_foreign_language)
     values ($1, 'Equivalent route race listing', 'Synthetic equivalent supplier race fixture', 'US', 'English', ARRAY['General'],
       1000, 'DOFOLLOW', 'PERMANENT', 30, false, 'DRAFT', false, false, false, false)`, [routeListingId],
  );
  await setup.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await setup.query(
    `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
       placement_price_minor, writing_selected, target_url, anchor_text, article_text, supplier_sharing_consented, consent_notice_version)
     values ($1, $2, $3, 1, '{"title":"Equivalent route race listing"}'::jsonb, 1000, false,
       'https://example.invalid/original', 'original', 'Synthetic original article for a local route race', true, 'race-fixture-v1')`,
    [routeItemId, orderId, routeListingId],
  );
  await setup.query(
    `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
     values ($1, 'SUPPLIER_SOURCED', $2, $2)`, [routeItemId, supplierAId],
  );
  await setup.query(
    "update order_item_fulfillment set state = 'READY_FOR_HANDOFF', assigned_admin_id = $2 where order_item_id = $1",
    [routeItemId, targetAdminId],
  );
  // The fixture order deliberately remains PENDING_POST because this harness
  // does not exercise checkout. Acceptance only needs a same-item case ID, so
  // bypass the unrelated paid-order support-case guard for this one synthetic
  // setup row and restore it before any runtime race transaction begins.
  await setup.query("alter table support_case disable trigger support_case_guard");
  await setup.query(
    `insert into support_case (id, organization_id, order_id, order_item_id, opened_by_user_id, summary, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'Synthetic equivalent supplier route race', $6, repeat('d', 64))`,
    [routeSupportCaseId, organizationId, orderId, routeItemId, caseOwnerId, `route-case-${routeItemId}`],
  );
  await setup.query("alter table support_case enable trigger support_case_guard");
  await setup.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [caseOwnerId, organizationId]);
  await setup.query(
    `insert into support_case_event (id, case_id, actor_user_id, actor_kind, kind, audience, body, to_state, idempotency_key, request_hash)
     values ($1, $2, $3, 'CUSTOMER', 'OPENED', 'INTERNAL', 'Synthetic equivalent supplier route race', 'OPEN', $4, repeat('e', 64))`,
    [randomUUID(), routeSupportCaseId, caseOwnerId, `route-case-open-${routeItemId}`],
  );
  await setup.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     values ($1, 1, $2, $3, $4, 'original@race-fixture.invalid', '{"items":[{"id":"original-a"}]}'::jsonb, $5, $6)`,
    [routeOriginalPacketId, organizationId, orderId, supplierAId, hash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 1 from customer_order_item oi where oi.id = $2`,
    [routeOriginalPacketId, routeItemId, targetAdminId, hash],
  );
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     values ($1, 2, $2, $3, $4, 'original@race-fixture.invalid', '{"items":[{"id":"original-a"}]}'::jsonb, $5, $6)`,
    [routeUnsentPacketId, organizationId, orderId, supplierAId, hash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 1 from customer_order_item oi where oi.id = $2`,
    [routeUnsentPacketId, routeItemId, targetAdminId, hash],
  );
  await setup.query("update supplier_packet set superseded_at = clock_timestamp() where id = $1", [routeUnsentPacketId]);
  await setup.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key,
       manual_message_reference, sent_at, resolved_at)
     values ($1, $2, 'MANUAL_SENT', 'MANUAL_SENT', $3, 'original@race-fixture.invalid', $4, 'original-a-manual-send', now(), now())`,
    [routeOriginalPacketAttemptId, routeOriginalPacketId, targetAdminId, `original-a-${routeOriginalPacketAttemptId}`],
  );
  await setup.query("update order_item_fulfillment set state = 'HANDOFF_PENDING' where order_item_id = $1", [routeItemId]);
  await setup.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = coalesce(handed_off_at, clock_timestamp()), work_started_at = coalesce(work_started_at, clock_timestamp()), updated_at = clock_timestamp()
     where order_item_id = $1`, [routeItemId],
  );
  await setup.query(
    `insert into supplier_fulfillment_outcome (id, order_item_id, supplier_id, support_case_id, actor_user_id,
       outcome, reason, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'CANNOT_FULFILL', 'Synthetic supplier failure for the route-generation regression', $6, repeat('f', 64))`,
    [routeFailureOutcomeId, routeItemId, supplierAId, routeSupportCaseId, targetAdminId, `route-outcome-${routeItemId}`],
  );
  const originalCutoffs = await setup.query<{ handed_off_at: Date; work_started_at: Date }>(
    "select handed_off_at, work_started_at from order_item_fulfillment where order_item_id = $1", [routeItemId],
  );
  assert.ok(originalCutoffs.rows[0]?.handed_off_at && originalCutoffs.rows[0]?.work_started_at);
  await setup.query("select set_config('app.user_id', $1, true)", [targetAdminId]);
  await setup.query("savepoint supplier_notice_guard");
  await expectSupplierNoticeWithoutDeliveryRejected(setup.query(
    `insert into supplier_item_notice (id, case_id, order_item_id, packet_id, notice_type, recipient, snapshot, content_hash, created_by_user_id)
     values ($1, $2, $3, $4, 'CORRECTION', 'original@race-fixture.invalid', '{"subject":"Correction","body":"Please use the updated details.","itemReference":"original-a"}'::jsonb, $5, $6)`,
    [routeNoticeId, routeSupportCaseId, routeItemId, routeUnsentPacketId, hash, targetAdminId],
  ));
  await setup.query("rollback to savepoint supplier_notice_guard");
  await setup.query("release savepoint supplier_notice_guard");
  await setup.query(
    `insert into supplier_item_notice (id, case_id, order_item_id, packet_id, notice_type, recipient, snapshot, content_hash, created_by_user_id)
     values ($1, $2, $3, $4, 'CORRECTION', 'original@race-fixture.invalid', '{"subject":"Correction","body":"Please use the updated details.","itemReference":"original-a"}'::jsonb, $5, $6)`,
    [routeNoticeId, routeSupportCaseId, routeItemId, routeOriginalPacketId, hash, targetAdminId],
  );
  await setup.query("select set_config('app.user_id', $1, true)", [targetAdminId]);
  await setup.query(
    `insert into order_item_content_change_request (id, order_item_id, request_number, requested_by_user_id,
       base_version, target_supplier_id, target_url, anchor_text, article_text)
     values ($1, $2, 1, $3, 1, $4, 'https://example.invalid/replacement', 'replacement',
       'Synthetic approved replacement article for a local route race')`,
    [routeRequestId, routeItemId, ownerId, supplierBId],
  );
  await setup.query(
    `insert into order_item_content_version (id, order_item_id, request_id, version, target_url, anchor_text,
       article_text, instructions, supplier_id, recipient_email, content_hash, approved_by_user_id)
     values ($1, $2, $3, 2, 'https://example.invalid/replacement', 'replacement',
       'Synthetic approved replacement article for a local route race', '', $4, 'replacement@race-fixture.invalid', $5, $6)`,
    [routeVersionId, routeItemId, routeRequestId, supplierBId, routeContentHash, targetAdminId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, created_at)
     values ($1, $2, $3, 'REQUESTED', clock_timestamp())`, [randomUUID(), routeRequestId, ownerId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, created_at)
     values ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
    [randomUUID(), routeRequestId, targetAdminId, routeVersionId, routeContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer (id, order_item_id, support_case_id, content_request_id, content_version_id,
       title, website_url, description, equivalence_note, categories, country_code, language, link_type, link_validity,
       turnaround_days, buyer_requirements, sponsored_content_marking, terms, locked_price_minor, offered_by_user_id)
     values ($1, $2, $3, $4, $5, 'Replacement listing', 'https://replacement.race-fixture.invalid/',
       'Synthetic replacement listing', 'Equivalent terms for local route race', ARRAY['General'], 'US', 'English',
       'DOFOLLOW', 'PERMANENT', 30, null, false, '{"source":"race-test"}'::jsonb, 1000, $6)`,
    [routeOfferId, routeItemId, routeSupportCaseId, routeRequestId, routeVersionId, targetAdminId],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_route (offer_id, supplier_id, recipient_email, content_hash, route_generation)
     values ($1, $2, 'replacement@race-fixture.invalid', $3, 2)`, [routeOfferId, supplierBId, routeContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, created_at)
     values ($1, $2, $3, 'OFFERED', $4, clock_timestamp())`,
    [randomUUID(), routeOfferId, targetAdminId, routeContentHash],
  );
  await setup.query("commit");

  // An offered replacement cannot be hidden by closing its failure case.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query(
    `insert into support_case_event (id, case_id, actor_user_id, actor_kind, kind, audience, body, from_state, to_state, idempotency_key, request_hash)
     values ($1, $2, $3, 'STAFF', 'STATE_CHANGED', 'INTERNAL', 'Attempt to close while the equivalent offer is pending', 'OPEN', 'RESOLVED', $4, repeat('a', 64))`,
    [randomUUID(), routeSupportCaseId, targetAdminId, `close-pending-${routeItemId}`],
  );
  await expectSupplierFailureCaseCloseRejected(handoff.query(
    "update support_case set state = 'RESOLVED', updated_at = clock_timestamp() where id = $1", [routeSupportCaseId],
  ));
  await handoff.query("rollback");

  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeRequestId, ownerId, routeVersionId, routeContentHash],
  ));
  await consent.query("rollback");

  // Customer acceptance is recorded. Hold the item lock while
  // a case close waits, then accept the route: the waiting close must re-read
  // the accepted pointer after it acquires the same item lock.
  await setup.query("begin");
  await setup.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, notice_version, created_at)
     values ($1, $2, $3, 'ACCEPTED', $4, 'race-fixture-v1', clock_timestamp())`,
    [randomUUID(), routeOfferId, ownerId, routeContentHash],
  );
  await setup.query("commit");

  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await consent.query("select public.gphkm_lock_equivalent_offer_item($1, $2, $3)", [routeOfferId, ownerId, organizationId]);
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  const routeHandoffBackend = await handoff.query<{ pid: number }>("select pg_backend_pid() as pid");
  await handoff.query(
    `insert into support_case_event (id, case_id, actor_user_id, actor_kind, kind, audience, body, from_state, to_state, idempotency_key, request_hash)
     values ($1, $2, $3, 'STAFF', 'STATE_CHANGED', 'INTERNAL', 'Close after customer-approved supplier recovery', 'OPEN', 'RESOLVED', $4, repeat('b', 64))`,
    [randomUUID(), routeSupportCaseId, targetAdminId, `close-after-accept-${routeItemId}`],
  );
  let closeOutcome = "pending";
  const blockedCaseClose = handoff.query(
    "update support_case set state = 'RESOLVED', updated_at = clock_timestamp() where id = $1", [routeSupportCaseId],
  ).then((result) => { closeOutcome = `resolved:${result.rowCount}`; return result; }, (error: unknown) => {
    closeOutcome = typeof error === "object" && error !== null && "code" in error ? `rejected:${String(error.code)}` : "rejected";
    throw error;
  });
  await waitUntilBlocked(observer, routeHandoffBackend.rows[0]!.pid, "Case close-first route acceptance");
  await consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeRequestId, ownerId, routeVersionId, routeContentHash],
  );
  await consent.query("select public.gphkm_apply_equivalent_offer_acceptance($1, $2, $3)", [routeOfferId, ownerId, organizationId]);
  await consent.query("commit");
  await blockedCaseClose;
  assert.equal(closeOutcome, "resolved:1", "case close rechecks after acceptance commits and does not deadlock");
  await handoff.query("commit");
  const acceptedCase = await setup.query<{ state: string }>("select state from support_case where id = $1", [routeSupportCaseId]);
  assert.equal(acceptedCase.rows[0]?.state, "RESOLVED", "accepted current route permits terminal case state");
  const acceptedItem = await setup.query<{ state: string; handed_off_at: Date | null; work_started_at: Date | null; notice_access: boolean }>(
    `select f.state, f.handed_off_at, f.work_started_at,
       public.gphkm_supplier_item_notice_access($2, $3) as notice_access
       from order_item_fulfillment f where f.order_item_id = $1`,
    [routeItemId, routeNoticeId, targetAdminId],
  );
  assert.deepEqual(acceptedItem.rows[0], {
    state: "READY_FOR_HANDOFF", handed_off_at: originalCutoffs.rows[0]!.handed_off_at,
    work_started_at: originalCutoffs.rows[0]!.work_started_at, notice_access: true,
  }, "accepted rerouting preserves the original cancellation cutoff and keeps the prior supplier notice reconcilable");

  // Without any packet from generation 2, a direct work-start write cannot
  // borrow evidence from the original supplier route.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await expectSupplierHandoffRejected(handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = coalesce(handed_off_at, clock_timestamp()), work_started_at = coalesce(work_started_at, clock_timestamp()), updated_at = clock_timestamp()
     where order_item_id = $1`, [routeItemId],
  ));
  await handoff.query("rollback");
  const acceptedRoute = await setup.query<{ supplier_id: string; state: string }>(
    `select route.supplier_id, f.state from order_item_fulfillment_supplier route
       join order_item_fulfillment f on f.order_item_id = route.order_item_id where route.order_item_id = $1`, [routeItemId],
  );
  assert.deepEqual(acceptedRoute.rows[0], { supplier_id: supplierBId, state: "READY_FOR_HANDOFF" },
    "direct acceptance locks and commits the new route before the waiting work-start validates packet evidence");

  await setup.query("begin");
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     values ($1, 1, $2, $3, $4, 'replacement@race-fixture.invalid', '{"items":[{"id":"route-race-old"}]}'::jsonb, $5, $6)`,
    [routeOlderPacketId, organizationId, orderId, supplierBId, routeContentHash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 2 from customer_order_item oi where oi.id = $2`,
    [routeOlderPacketId, routeItemId, targetAdminId, routeContentHash],
  );
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     values ($1, 2, $2, $3, $4, 'replacement@race-fixture.invalid', '{"items":[{"id":"route-race-current"}]}'::jsonb, $5, $6)`,
    [routePacketId, organizationId, orderId, supplierBId, routeContentHash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 2 from customer_order_item oi where oi.id = $2`,
    [routePacketId, routeItemId, targetAdminId, routeContentHash],
  );
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id, hold_reason, held_at)
     values ($1, 3, $2, $3, $4, 'replacement@race-fixture.invalid', '{"items":[{"id":"route-race-held"}]}'::jsonb, $5, $6, 'PACKET_SIZE_REVIEW', now())`,
    [routeHeldPacketId, organizationId, orderId, supplierBId, routeContentHash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 2 from customer_order_item oi where oi.id = $2`,
    [routeHeldPacketId, routeItemId, targetAdminId, routeContentHash],
  );
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id, superseded_at)
     values ($1, 4, $2, $3, $4, 'replacement@race-fixture.invalid', '{"items":[{"id":"route-race-superseded"}]}'::jsonb, $5, $6, now())`,
    [routeSupersededPacketId, organizationId, orderId, supplierBId, routeContentHash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 2 from customer_order_item oi where oi.id = $2`,
    [routeSupersededPacketId, routeItemId, targetAdminId, routeContentHash],
  );
  await setup.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key,
       manual_message_reference, sent_at, resolved_at)
     values ($1, $2, 'MANUAL_SENT', 'MANUAL_SENT', $3, 'replacement@race-fixture.invalid', $4, 'route-race-manual-send', now(), now())`,
    [routePacketAttemptId, routePacketId, targetAdminId, `route-race-${routePacketAttemptId}`],
  );
  await setup.query("update order_item_fulfillment set state = 'HANDOFF_PENDING' where order_item_id = $1", [routeItemId]);
  await setup.query("commit");

  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await expectPacketAttemptRejected(handoff, routeOriginalPacketId, randomUUID(), targetAdminId, /supplier packet route, recipient, or active version is stale/);
  await expectPacketAttemptRejected(handoff, routeOlderPacketId, randomUUID(), targetAdminId, /supplier packet route, recipient, or active version is stale/);
  await expectPacketAttemptRejected(handoff, routeHeldPacketId, randomUUID(), targetAdminId, /supplier packet is superseded, held, or unavailable/);
  await expectPacketAttemptRejected(handoff, routeSupersededPacketId, randomUUID(), targetAdminId, /supplier packet is superseded, held, or unavailable/);
  await handoff.query("rollback");

  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = coalesce(handed_off_at, clock_timestamp()), work_started_at = coalesce(work_started_at, clock_timestamp()), updated_at = clock_timestamp()
     where order_item_id = $1`, [routeItemId],
  );
  await handoff.query("commit");
  const postHandoffRoute = await setup.query<{ supplier_id: string; route_generation: number; state: string; work_started_at: Date | null }>(
    `select route.supplier_id, route.route_generation, f.state, f.work_started_at from order_item_fulfillment_supplier route
       join order_item_fulfillment f on f.order_item_id = route.order_item_id where route.order_item_id = $1`, [routeItemId],
  );
  assert.deepEqual({ supplier_id: postHandoffRoute.rows[0]?.supplier_id, route_generation: postHandoffRoute.rows[0]?.route_generation,
    state: postHandoffRoute.rows[0]?.state }, { supplier_id: supplierBId, route_generation: 2, state: "IN_FULFILLMENT" },
    "the first accepted supplier recovery returns the handed-off item to preparation at generation 2 while retaining historical work-start evidence");
  assert.ok(postHandoffRoute.rows[0]?.work_started_at);

  // A second failure on supplier B exercises the canonical post-handoff
  // recovery path back to A. First pause a real SEND reservation before the
  // failure is reported. This models the provider call being deferred after
  // reservation without invoking Resend or any other external service.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key, provider)
     values ($1, $2, 'SEND', 'SENDING', $3, 'replacement@race-fixture.invalid', $4, 'RESEND')`,
    [routeReservationAttemptId, routePacketId, targetAdminId, `route-reservation-${routeReservationAttemptId}`],
  );
  await handoff.query("commit");

  // The old A packet remains generation 1. A pending send on B must leave the
  // new equivalent offer visible for review but not actionable until staff
  // confirms the attempt did not reach the provider.
  await setup.query("begin");
  await setup.query("select set_config('app.user_id', $1, true)", [targetAdminId]);
  await setup.query("alter table support_case disable trigger support_case_guard");
  await setup.query(
    `insert into support_case (id, organization_id, order_id, order_item_id, opened_by_user_id, summary, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'Synthetic second supplier failure', $6, repeat('9', 64))`,
    [routeReturnCaseId, organizationId, orderId, routeItemId, ownerId, `return-case-${routeItemId}`],
  );
  await setup.query("alter table support_case enable trigger support_case_guard");
  await setup.query(
    `insert into support_case_event (id, case_id, actor_user_id, actor_kind, kind, audience, body, to_state, idempotency_key, request_hash)
     values ($1, $2, $3, 'CUSTOMER', 'OPENED', 'INTERNAL', 'Synthetic second supplier failure', 'OPEN', $4, repeat('8', 64))`,
    [randomUUID(), routeReturnCaseId, ownerId, `return-case-open-${routeItemId}`],
  );
  await setup.query(
    `insert into supplier_fulfillment_outcome (id, order_item_id, supplier_id, support_case_id, actor_user_id,
       outcome, reason, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'CANNOT_FULFILL', 'Synthetic supplier B failure for A-to-B-to-A regression', $6, repeat('7', 64))`,
    [routeReturnFailureOutcomeId, routeItemId, supplierBId, routeReturnCaseId, targetAdminId, `return-outcome-${routeItemId}`],
  );
  await setup.query(
    `insert into order_item_content_change_request (id, order_item_id, request_number, requested_by_user_id,
       base_version, target_supplier_id, target_url, anchor_text, article_text)
     values ($1, $2, 2, $3, 2, $4, 'https://example.invalid/return-to-a', 'return to A',
       'Synthetic approved return content for the local A-to-B-to-A route regression')`,
    [routeReturnRequestId, routeItemId, ownerId, supplierAId],
  );
  await setup.query(
    `insert into order_item_content_version (id, order_item_id, request_id, version, target_url, anchor_text,
       article_text, instructions, supplier_id, recipient_email, content_hash, approved_by_user_id)
     values ($1, $2, $3, 3, 'https://example.invalid/return-to-a', 'return to A',
       'Synthetic approved return content for the local A-to-B-to-A route regression', '', $4, 'original@race-fixture.invalid', $5, $6)`,
    [routeReturnVersionId, routeItemId, routeReturnRequestId, supplierAId, routeReturnContentHash, targetAdminId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, created_at)
     values ($1, $2, $3, 'REQUESTED', clock_timestamp())`, [randomUUID(), routeReturnRequestId, ownerId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, created_at)
     values ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
    [randomUUID(), routeReturnRequestId, targetAdminId, routeReturnVersionId, routeReturnContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer (id, order_item_id, support_case_id, content_request_id, content_version_id,
       title, website_url, description, equivalence_note, categories, country_code, language, link_type, link_validity,
       turnaround_days, buyer_requirements, sponsored_content_marking, terms, locked_price_minor, offered_by_user_id)
     values ($1, $2, $3, $4, $5, 'Return to original supplier listing', 'https://original.race-fixture.invalid/',
       'Synthetic original listing', 'Return route for local regression', ARRAY['General'], 'US', 'English',
       'DOFOLLOW', 'PERMANENT', 30, null, false, '{"source":"race-test"}'::jsonb, 1000, $6)`,
    [routeReturnOfferId, routeItemId, routeReturnCaseId, routeReturnRequestId, routeReturnVersionId, targetAdminId],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_route (offer_id, supplier_id, recipient_email, content_hash, route_generation)
     values ($1, $2, 'original@race-fixture.invalid', $3, 3)`, [routeReturnOfferId, supplierAId, routeReturnContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, created_at)
     values ($1, $2, $3, 'OFFERED', $4, clock_timestamp())`,
    [randomUUID(), routeReturnOfferId, targetAdminId, routeReturnContentHash],
  );
  await setup.query("commit");

  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await consent.query("select public.gphkm_lock_equivalent_offer_item($1, $2, $3)", [routeReturnOfferId, ownerId, organizationId]);
  const visibleRecovery = await consent.query<{ can_decide: boolean }>(
    "select public.gphkm_customer_can_decide_equivalent_offer($1, $2, $3) as can_decide", [routeReturnOfferId, ownerId, organizationId],
  );
  assert.equal(visibleRecovery.rows[0]?.can_decide, false,
    "customer cannot accept a supplier recovery while the current packet send reservation is unresolved");
  await consent.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, notice_version)
     values ($1, $2, $3, 'ACCEPTED', $4, 'race-fixture-v1')`,
    [randomUUID(), routeReturnOfferId, ownerId, routeReturnContentHash],
  );
  await consent.query("savepoint pending_send_acceptance");
  await expectEquivalentAcceptanceRejected(consent.query(
    "select public.gphkm_apply_equivalent_offer_acceptance($1, $2, $3)", [routeReturnOfferId, ownerId, organizationId],
  ));
  await consent.query("rollback to savepoint pending_send_acceptance");
  await consent.query("release savepoint pending_send_acceptance");
  await consent.query("savepoint pending_send_consent");
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeReturnRequestId, ownerId, routeReturnVersionId, routeReturnContentHash],
  ), /content consent closes after handoff unless bound to the current customer-approved supplier recovery/);
  await consent.query("rollback to savepoint pending_send_consent");
  await consent.query("release savepoint pending_send_consent");
  await consent.query("rollback");

  // Reconcile the deferred request as confirmed-not-sent. This is a local
  // database history transition only; no provider request was made.
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query(
    `insert into supplier_packet_attempt_event (id, attempt_id, actor_user_id, actor_kind, from_state, to_state, reason_code, reference)
     values ($1, $2, $3, 'STAFF', 'SENDING', 'RECONCILED_FAILED', 'CONFIRMED_NOT_SENT', 'Race fixture: provider call was never dispatched')`,
    [randomUUID(), routeReservationAttemptId, targetAdminId],
  );
  await handoff.query(
    `update supplier_packet_attempt set state = 'RECONCILED_FAILED', resolved_at = clock_timestamp(), updated_at = clock_timestamp()
     where id = $1`, [routeReservationAttemptId],
  );
  await handoff.query("commit");

  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await consent.query("select public.gphkm_lock_equivalent_offer_item($1, $2, $3)", [routeReturnOfferId, ownerId, organizationId]);
  const recoveredDecision = await consent.query<{ can_decide: boolean }>(
    "select public.gphkm_customer_can_decide_equivalent_offer($1, $2, $3) as can_decide", [routeReturnOfferId, ownerId, organizationId],
  );
  assert.equal(recoveredDecision.rows[0]?.can_decide, true,
    "customer can decide the exact approved recovery after the send is reconciled as not sent");
  await consent.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, notice_version)
     values ($1, $2, $3, 'ACCEPTED', $4, 'race-fixture-v1')`,
    [randomUUID(), routeReturnOfferId, ownerId, routeReturnContentHash],
  );
  await consent.query("savepoint missing_recovery_consent");
  await expectEquivalentAcceptanceRejected(consent.query(
    "select public.gphkm_apply_equivalent_offer_acceptance($1, $2, $3)", [routeReturnOfferId, ownerId, organizationId],
  ));
  await consent.query("rollback to savepoint missing_recovery_consent");
  await consent.query("release savepoint missing_recovery_consent");
  await consent.query("savepoint stale_recovery_consent");
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeReturnRequestId, ownerId, routeReturnVersionId, "e".repeat(64)],
  ));
  await consent.query("rollback to savepoint stale_recovery_consent");
  await consent.query("release savepoint stale_recovery_consent");
  await consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeReturnRequestId, ownerId, routeReturnVersionId, routeReturnContentHash],
  );
  await consent.query("select public.gphkm_apply_equivalent_offer_acceptance($1, $2, $3)", [routeReturnOfferId, ownerId, organizationId]);
  await consent.query("commit");
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await expectEquivalentAcceptanceRejected(consent.query(
    "select public.gphkm_apply_equivalent_offer_acceptance($1, $2, $3)", [routeOfferId, ownerId, organizationId],
  ));
  await consent.query("rollback");
  const returnRoute = await setup.query<{ supplier_id: string; route_generation: number; state: string; handed_off_at: Date | null; work_started_at: Date | null }>(
    `select route.supplier_id, route.route_generation, f.state, f.handed_off_at, f.work_started_at from order_item_fulfillment_supplier route
       join order_item_fulfillment f on f.order_item_id = route.order_item_id where route.order_item_id = $1`, [routeItemId],
  );
  assert.equal(returnRoute.rows[0]?.supplier_id, supplierAId);
  assert.equal(returnRoute.rows[0]?.route_generation, 3);
  assert.equal(returnRoute.rows[0]?.state, "READY_FOR_HANDOFF");
  assert.equal(returnRoute.rows[0]?.handed_off_at?.getTime(), originalCutoffs.rows[0]!.handed_off_at.getTime());
  assert.equal(returnRoute.rows[0]?.work_started_at?.getTime(), originalCutoffs.rows[0]!.work_started_at.getTime(),
    "each accepted replacement retains the original post-handoff cancellation cutoff");

  // The stale A→B request still targets B after the later B→A acceptance made
  // A the current route. Its matching old hash is not consent for current A.
  const staleRequestRoute = await setup.query<{ request_supplier_id: string; current_supplier_id: string }>(
    `select request.target_supplier_id as request_supplier_id, route.supplier_id as current_supplier_id
       from order_item_content_change_request request
       join order_item_fulfillment_supplier route on route.order_item_id = request.order_item_id
      where request.id = $1`, [routeRequestId],
  );
  assert.deepEqual(staleRequestRoute.rows[0], { request_supplier_id: supplierBId, current_supplier_id: supplierAId },
    "stale request explicitly targets B while the accepted current route is A");
  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeRequestId, ownerId, routeVersionId, routeContentHash],
  ), /content consent closes after handoff unless bound to the current customer-approved supplier recovery/);
  await consent.query("rollback");

  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await expectPacketAttemptRejected(handoff, routeOriginalPacketId, randomUUID(), targetAdminId, /supplier packet route, recipient, or active version is stale/);
  await handoff.query("rollback");
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query("update order_item_fulfillment set state = 'HANDOFF_PENDING', updated_at = clock_timestamp() where order_item_id = $1", [routeItemId]);
  await expectSupplierHandoffRejected(handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS', updated_at = clock_timestamp()
     where order_item_id = $1`, [routeItemId],
  ));
  await handoff.query("rollback");

  await setup.query("begin");
  await setup.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     values ($1, 3, $2, $3, $4, 'original@race-fixture.invalid', '{"items":[{"id":"return-a-generation-3"}]}'::jsonb, $5, $6)`,
    [routeFreshAPacketId, organizationId, orderId, supplierAId, routeReturnContentHash, targetAdminId],
  );
  await setup.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version, consented_at, consent_content_hash, route_generation)
     select $1, oi.id, $3, oi.consent_notice_version, oi.consented_at, $4, 3 from customer_order_item oi where oi.id = $2`,
    [routeFreshAPacketId, routeItemId, targetAdminId, routeReturnContentHash],
  );
  await setup.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key,
       manual_message_reference, sent_at, resolved_at)
     values ($1, $2, 'MANUAL_SENT', 'MANUAL_SENT', $3, 'original@race-fixture.invalid', $4, 'return-a-generation-3-manual-send', now(), now())`,
    [routeFreshAAttemptId, routeFreshAPacketId, targetAdminId, `fresh-a-${routeFreshAAttemptId}`],
  );
  await setup.query("commit");
  await handoff.query("begin");
  await handoff.query("set local role gphkm_runtime");
  await handoff.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [targetAdminId]);
  await handoff.query("update order_item_fulfillment set state = 'HANDOFF_PENDING', updated_at = clock_timestamp() where order_item_id = $1", [routeItemId]);
  await handoff.query(
    `update order_item_fulfillment set state = 'IN_FULFILLMENT', customer_status = 'IN_PROGRESS',
       handed_off_at = coalesce(handed_off_at, clock_timestamp()), work_started_at = coalesce(work_started_at, clock_timestamp()), updated_at = clock_timestamp()
     where order_item_id = $1`, [routeItemId],
  );
  await handoff.query("commit");
  const freshRouteWork = await setup.query<{ state: string; route_generation: number }>(
    `select f.state, route.route_generation from order_item_fulfillment f
       join order_item_fulfillment_supplier route on route.order_item_id = f.order_item_id where f.order_item_id = $1`, [routeItemId],
  );
  assert.deepEqual(freshRouteWork.rows[0], { state: "IN_FULFILLMENT", route_generation: 3 },
    "fresh generation-3 A evidence permits work start after stale generation-1 A evidence was rejected");

  // Keep the mismatch regression in the same active order conversation. The
  // current route is A, but this synthetic accepted recovery offer routes to B
  // while its approved content request still names A. Matching hashes alone
  // must not authorize post-handoff supplier consent for that mismatch.
  await setup.query("begin");
  await setup.query("select set_config('app.user_id', $1, true)", [targetAdminId]);
  await setup.query(
    `insert into supplier_fulfillment_outcome (id, order_item_id, supplier_id, support_case_id, actor_user_id,
       outcome, reason, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'CANNOT_FULFILL', 'Synthetic supplier A failure for cross-supplier consent regression', $6, repeat('4', 64))`,
    [routeMismatchFailureOutcomeId, routeItemId, supplierAId, routeReturnCaseId, targetAdminId, `mismatch-outcome-${routeItemId}`],
  );
  await setup.query(
    `insert into order_item_content_change_request (id, order_item_id, request_number, requested_by_user_id,
       base_version, target_supplier_id, target_url, anchor_text, article_text)
     values ($1, $2, 3, $3, 3, $4, 'https://example.invalid/mismatched-route', 'mismatched route',
       'Synthetic content approved for A but incorrectly offered to supplier B')`,
    [routeMismatchRequestId, routeItemId, ownerId, supplierAId],
  );
  await setup.query(
    `insert into order_item_content_version (id, order_item_id, request_id, version, target_url, anchor_text,
       article_text, instructions, supplier_id, recipient_email, content_hash, approved_by_user_id)
     values ($1, $2, $3, 4, 'https://example.invalid/mismatched-route', 'mismatched route',
       'Synthetic content approved for A but incorrectly offered to supplier B', '', $4, 'original@race-fixture.invalid', $5, $6)`,
    [routeMismatchVersionId, routeItemId, routeMismatchRequestId, supplierAId, routeMismatchContentHash, targetAdminId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, created_at)
     values ($1, $2, $3, 'REQUESTED', clock_timestamp())`, [randomUUID(), routeMismatchRequestId, ownerId],
  );
  await setup.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, created_at)
     values ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
    [randomUUID(), routeMismatchRequestId, targetAdminId, routeMismatchVersionId, routeMismatchContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer (id, order_item_id, support_case_id, content_request_id, content_version_id,
       title, website_url, description, equivalence_note, categories, country_code, language, link_type, link_validity,
       turnaround_days, buyer_requirements, sponsored_content_marking, terms, locked_price_minor, offered_by_user_id)
     values ($1, $2, $3, $4, $5, 'Mismatched supplier route', 'https://replacement.race-fixture.invalid/',
       'Synthetic mismatched supplier offer', 'Must be rejected by consent binding', ARRAY['General'], 'US', 'English',
       'DOFOLLOW', 'PERMANENT', 30, null, false, '{"source":"mismatch-race"}'::jsonb, 1000, $6)`,
    [routeMismatchOfferId, routeItemId, routeReturnCaseId, routeMismatchRequestId, routeMismatchVersionId, targetAdminId],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_route (offer_id, supplier_id, recipient_email, content_hash, route_generation)
     values ($1, $2, 'replacement@race-fixture.invalid', $3, 4)`, [routeMismatchOfferId, supplierBId, routeMismatchContentHash],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, created_at)
     values ($1, $2, $3, 'OFFERED', $4, clock_timestamp())`,
    [randomUUID(), routeMismatchOfferId, targetAdminId, routeMismatchContentHash],
  );
  await setup.query("commit");

  await consent.query("begin");
  await consent.query("set local role gphkm_runtime");
  await consent.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [ownerId, organizationId]);
  await consent.query("select public.gphkm_lock_equivalent_offer_item($1, $2, $3)", [routeMismatchOfferId, ownerId, organizationId]);
  const mismatchedDecision = await consent.query<{ can_decide: boolean }>(
    "select public.gphkm_customer_can_decide_equivalent_offer($1, $2, $3) as can_decide", [routeMismatchOfferId, ownerId, organizationId],
  );
  assert.equal(mismatchedDecision.rows[0]?.can_decide, false,
    "an offer for B cannot be decided using approved content whose request targets the current supplier A");
  await consent.query(
    `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, notice_version)
     values ($1, $2, $3, 'ACCEPTED', $4, 'race-fixture-v1')`,
    [randomUUID(), routeMismatchOfferId, ownerId, routeMismatchContentHash],
  );
  await expectContentConsentRejected(consent.query(
    `insert into order_item_content_change_event (id, request_id, actor_user_id, event_type, version_id, content_hash, notice_version)
     values ($1, $2, $3, 'CONSENTED', $4, $5, 'race-fixture-v1')`,
    [randomUUID(), routeMismatchRequestId, ownerId, routeMismatchVersionId, routeMismatchContentHash],
  ), /content consent closes after handoff unless bound to the current customer-approved supplier recovery/);
  await consent.query("rollback");
  const mismatchedRoute = await setup.query<{ supplier_id: string; route_generation: number }>(
    "select supplier_id, route_generation from order_item_fulfillment_supplier where order_item_id = $1", [routeItemId],
  );
  assert.deepEqual(mismatchedRoute.rows[0], { supplier_id: supplierAId, route_generation: 3 },
    "rejected mismatched consent leaves the accepted A route unchanged");

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
  console.log("Local two-session security races passed: an ordering member accepted recovery when a different Owner opened Support; unsent notices were rejected while delivered notices stayed reconcilable after rerouting; historical cancellation cutoffs were preserved; customer consent and work-start revalidated after handoff locks; a reserved SEND remained blocked until audited not-sent reconciliation; A→B→A rejected stale packet evidence and offer replay; and a deactivated assignment actor could not mutate work after waiting.");
} catch (error) {
  if (error instanceof Error) console.error(error.message);
  if (typeof error === "object" && error !== null && "where" in error && typeof error.where === "string") console.error(error.where);
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") console.error(error.detail);
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") console.error(`PostgreSQL code: ${error.code}`);
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
