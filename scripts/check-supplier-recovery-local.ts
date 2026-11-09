import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

function localUrl(value: string | undefined, role: string) {
  if (!value) throw new Error("Supplier recovery check requires local database URLs from .env");
  const url = new URL(value);
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || !["postgres:", "postgresql:"].includes(url.protocol)
      || decodeURIComponent(url.username) !== role || url.pathname !== "/gphkm") {
    throw new Error("Supplier recovery check is restricted to the local GPHKM database and expected role");
  }
  return url;
}

const migrationUrl = localUrl(process.env.MIGRATION_DATABASE_URL, "gphkm_migration");
const runtimeUrl = localUrl(process.env.DATABASE_URL, "gphkm_runtime");
const databaseName = `gphkm_recovery_${process.pid}_${randomUUID().slice(0, 8)}`;
const databaseIdentifier = `"${databaseName}"`;
const isolatedMigrationUrl = new URL(migrationUrl);
const isolatedRuntimeUrl = new URL(runtimeUrl);
isolatedMigrationUrl.pathname = `/${databaseName}`;
isolatedRuntimeUrl.pathname = `/${databaseName}`;

const administrator = new Client({ connectionString: migrationUrl.href, connectionTimeoutMillis: 5000 });
const setup = new Client({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000 });
const runtimeA = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
const runtimeB = new Client({ connectionString: isolatedRuntimeUrl.href, connectionTimeoutMillis: 5000 });
let created = false;

function requestHash(itemId: string, reason: string) {
  return createHash("sha256").update(JSON.stringify({ itemId, reason })).digest("hex");
}

async function expectDenied(work: () => Promise<unknown>, message: RegExp) {
  let caught: unknown;
  try { await work(); } catch (error) { caught = error; }
  assert.ok(caught, "the command must reject this recovery attempt");
  assert.equal(typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null, "42501");
  assert.match(caught instanceof Error ? caught.message : String(caught), message);
}

async function insertCurrentConsentPacket(client: Client, input: {
  packetId: string; organizationId: string; orderId: string; itemId: string; supplierId: string;
  assignedAdminId: string; createdByUserId: string; contentHash: string;
}) {
  const recipient = "current@recovery.invalid";
  const inserted = await client.query(
    `insert into supplier_packet (id, version, organization_id, order_id, supplier_id, recipient, packet, content_hash, created_by_user_id)
     select $1, 1, order_row.organization_id, order_row.id, route.supplier_id, contact.email,
       jsonb_build_object(
         'id', $1::text, 'version', 1, 'organizationId', order_row.organization_id, 'orderId', order_row.id,
         'supplierId', route.supplier_id, 'recipient', lower(btrim(contact.email)), 'createdBy', $7::text,
         'createdAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         'contentHash', $6::text,
         'items', jsonb_build_array(jsonb_build_object(
           'orderItemId', item.id, 'assignedAdminId', fulfillment.assigned_admin_id,
           'placementRequirements', public.gphkm_packet_placement_requirements(item.customer_listing_snapshot),
           'targetUrl', item.target_url, 'anchorText', item.anchor_text,
           'article', item.article_text, 'instructions', btrim(coalesce(item.instructions, '')),
           'consent', jsonb_build_object(
             'disclosureVersion', item.consent_notice_version, 'contentHash', $6::text,
             'supplierId', route.supplier_id, 'recipient', lower(btrim(contact.email)), 'consentEventId', null,
             'acceptedAt', to_char(item.consented_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           )
         ))
       ), $6, $7
       from customer_order_item item
       join customer_order order_row on order_row.id = item.order_id
       join order_item_fulfillment fulfillment on fulfillment.order_item_id = item.id
       join order_item_fulfillment_supplier route on route.order_item_id = item.id
       join supplier_contact contact on contact.supplier_id = route.supplier_id and contact.is_primary
      where item.id = $2 and order_row.id = $3 and order_row.organization_id = $4
        and route.supplier_id = $5 and lower(btrim(contact.email)) = lower(btrim($8))
        and fulfillment.assigned_admin_id = $9`,
    [input.packetId, input.itemId, input.orderId, input.organizationId, input.supplierId,
      input.contentHash, input.createdByUserId, recipient, input.assignedAdminId],
  );
  assert.equal(inserted.rowCount, 1, "recovery packet is bound to the current supplier route and assigned admin");
  await client.query(
    `insert into supplier_packet_item (packet_id, order_item_id, assigned_admin_id, consent_notice_version,
       consented_at, consent_content_hash, route_generation)
     select $1, item.id, fulfillment.assigned_admin_id, item.consent_notice_version, item.consented_at, $3, route.route_generation
       from customer_order_item item
       join order_item_fulfillment fulfillment on fulfillment.order_item_id = item.id
       join order_item_fulfillment_supplier route on route.order_item_id = item.id
      where item.id = $2 and fulfillment.assigned_admin_id = $4`,
    [input.packetId, input.itemId, input.contentHash, input.assignedAdminId],
  );
}

async function invoke(client: Client, actorId: string, itemId: string, reason: string, key: string) {
  await client.query("begin");
  try {
    await client.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', '', true)", [actorId]);
    const result = await client.query<{ recovery_id: string; support_case_id: string; replayed: boolean }>(
      "select * from public.gphkm_recover_supplier_failure($1, $2, $3, $4)",
      [itemId, reason, key, requestHash(itemId, reason)],
    );
    await client.query("commit");
    return result.rows[0]!;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

try {
  await administrator.connect();
  const duplicate = await administrator.query("select exists(select 1 from pg_database where datname = $1) as exists", [databaseName]);
  assert.equal(duplicate.rows[0]?.exists, false);
  await administrator.query(`create database ${databaseIdentifier} owner gphkm_migration template template0`);
  created = true;

  const migrationPool = new Pool({ connectionString: isolatedMigrationUrl.href, connectionTimeoutMillis: 5000, max: 1 });
  try { await migrate(drizzle(migrationPool), { migrationsFolder: "./src/db/migrations" }); }
  finally { await migrationPool.end(); }
  await Promise.all([setup.connect(), runtimeA.connect(), runtimeB.connect()]);

  const ownerId = randomUUID();
  const superAdminId = randomUUID();
  const secondSuperAdminId = randomUUID();
  const ordinaryAdminId = randomUUID();
  const organizationId = randomUUID();
  const orderId = randomUUID();
  const caseId = randomUUID();
  const supplierId = randomUUID();
  const itemIds = [randomUUID(), randomUUID(), randomUUID()];
  const listingIds = itemIds.map(() => randomUUID());
  const packetId = `pkt_${randomUUID()}`;
  const checkoutLedgerId = randomUUID();
  const ids = {
    firstOutcome: randomUUID(), secondOutcome: randomUUID(), raceOutcome: randomUUID(), staleOutcome: randomUUID(),
  };
  const hash = "a".repeat(64);
  await setup.query("begin");
  await setup.query(
    `insert into auth_user (id, name, email, email_verified) values
      ($1, 'Recovery fixture owner', $2, true), ($3, 'Recovery fixture Super Admin', $4, true),
      ($5, 'Recovery fixture second Super Admin', $6, true), ($7, 'Recovery fixture Admin', $8, true)`,
    [ownerId, `${ownerId}@recovery.invalid`, superAdminId, `${superAdminId}@recovery.invalid`,
      secondSuperAdminId, `${secondSuperAdminId}@recovery.invalid`, ordinaryAdminId, `${ordinaryAdminId}@recovery.invalid`],
  );
  await setup.query("insert into staff_account (user_id, role, active) values ($1, 'SUPER_ADMIN', true), ($2, 'SUPER_ADMIN', true), ($3, 'ADMIN', true)",
    [superAdminId, secondSuperAdminId, ordinaryAdminId]);
  await setup.query("insert into organization (id, name, created_by) values ($1, 'Supplier recovery fixture', $2)", [organizationId, ownerId]);
  await setup.query("insert into organization_member (id, organization_id, user_id, role, active) values ($1, $2, $3, 'OWNER', true)",
    [randomUUID(), organizationId, ownerId]);
  await setup.query("insert into wallet_account (organization_id, currency) values ($1, 'USD')", [organizationId]);
  await setup.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency, operation, idempotency_key)
     values ($1, $2, $3, 'TOP_UP', 5000, 'USD', 'RECOVERY_FIXTURE_TOP_UP', $4)`,
    [randomUUID(), organizationId, ownerId, `recovery-credit-${orderId}`],
  );
  await setup.query("insert into supplier (id, name, status, created_by_user_id) values ($1, 'Recovery fixture supplier', 'ACTIVE', $2)",
    [supplierId, superAdminId]);
  await setup.query("insert into supplier_contact (id, supplier_id, name, email, is_primary) values ($1, $2, 'Primary contact', 'current@recovery.invalid', true)",
    [randomUUID(), supplierId]);

  await setup.query("alter table customer_order disable trigger user");
  await setup.query(
    `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
       placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version,
       content_policy_version, content_policy_accepted_at, customer_status, checkout_state)
     values ($1, $2, $3, $4, $5, 3000, 0, 3000, 'recovery-fixture-v1',
       'gphkm-content-policy-v1', clock_timestamp(), 'ORDER_RECEIVED', 'PENDING_POST')`,
    [orderId, organizationId, ownerId, `recovery-${orderId}`, hash],
  );
  await setup.query("alter table customer_order enable trigger user");
  await setup.query(
    `insert into wallet_ledger_entry (id, organization_id, actor_user_id, kind, delta_minor, currency,
       operation, idempotency_key, related_type, related_id, reason_code)
     values ($1, $2, $3, 'ORDER_DEBIT', -3000, 'USD', $4, $5, 'CUSTOMER_ORDER', $6, 'ORDER_CHECKOUT')`,
    [checkoutLedgerId, organizationId, ownerId, `RECOVERY_FIXTURE:${orderId}`, `recovery-debit-${orderId}`, orderId],
  );
  await setup.query("update customer_order set checkout_state = 'PAID', paid_ledger_entry_id = $2 where id = $1", [orderId, checkoutLedgerId]);
  await setup.query("alter table customer_order_item disable trigger user");
  await setup.query("alter table order_item_fulfillment disable trigger user");
  await setup.query("alter table order_item_fulfillment_supplier disable trigger user");
  for (let index = 0; index < itemIds.length; index += 1) {
    await setup.query(
      `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
         retail_price_cents, link_type, link_validity, turnaround_days, sponsored_content_marking, status,
         allows_sports_and_gaming, allows_pharmacy, allows_crypto, allows_foreign_language)
       values ($1, $2, 'Recovery fixture listing', 'US', 'English', ARRAY['General'],
         1000, 'DOFOLLOW', 'PERMANENT', 30, false, 'DRAFT', false, false, false, false)`,
      [listingIds[index], `Recovery fixture ${index + 1}`],
    );
    await setup.query(
      `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
         placement_price_minor, writing_selected, target_url, anchor_text, article_text,
         supplier_sharing_consented, consent_notice_version)
       values ($1, $2, $3, 1, jsonb_build_object('title', $4::text), 1000, false,
         'https://example.invalid/recovery', 'fixture', 'Synthetic approved article for database regression', true, 'recovery-fixture-v1')`,
      [itemIds[index], orderId, listingIds[index], `Recovery fixture ${index + 1}`],
    );
    await setup.query("insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id) values ($1, 'SUPPLIER_SOURCED', $2, $2)",
      [itemIds[index], supplierId]);
    await setup.query(
      "update order_item_fulfillment set state = 'READY_FOR_HANDOFF', assigned_admin_id = $2 where order_item_id = $1",
      [itemIds[index], superAdminId],
    );
  }
  await setup.query("update order_item_fulfillment_supplier set route_generation = 2 where order_item_id = $1", [itemIds[2]]);
  await setup.query("alter table order_item_fulfillment_supplier enable trigger user");
  await setup.query("alter table order_item_fulfillment enable trigger user");
  await setup.query("alter table customer_order_item enable trigger user");

  await setup.query(
    `insert into order_item_supplier_consent (order_item_id, supplier_id, recipient_email, notice_version, accepted_at, capture_source)
     select item.id, route.supplier_id, contact.email, item.consent_notice_version, item.consented_at, 'CHECKOUT_ROUTE'
       from customer_order_item item
       join order_item_fulfillment_supplier route on route.order_item_id = item.id
       join supplier_contact contact on contact.supplier_id = route.supplier_id and contact.is_primary
      where item.id = any($1::text[])
     on conflict (order_item_id) do nothing`, [itemIds],
  );

  await setup.query("alter table support_case disable trigger user");
  await setup.query(
    `insert into support_case (id, organization_id, order_id, order_item_id, opened_by_user_id, summary, state, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, 'Same-supplier recovery regression', 'OPEN', $6, $7)`,
    [caseId, organizationId, orderId, itemIds[0], ownerId, `case-${caseId}`, hash],
  );
  await setup.query("alter table support_case enable trigger user");
  await insertCurrentConsentPacket(setup, {
    packetId, organizationId, orderId, itemId: itemIds[0], supplierId,
    assignedAdminId: superAdminId, createdByUserId: superAdminId, contentHash: hash,
  });
  await setup.query("select set_config('app.user_id', $1, true)", [superAdminId]);
  await setup.query(
    `insert into supplier_fulfillment_outcome (id, order_item_id, supplier_id, support_case_id, actor_user_id,
       outcome, reason, idempotency_key, request_hash, route_generation)
     values ($1, $2, $3, $4, $5, 'CANNOT_FULFILL', 'Supplier previously unavailable', $6, $7, 1),
            ($8, $2, $3, $4, $5, 'NONRESPONSIVE', 'Follow-up was not answered', $9, $7, 1),
            ($10, $11, $3, $4, $5, 'CANNOT_FULFILL', 'Supplier previously unavailable', $12, $7, 1),
            ($13, $14, $3, $4, $5, 'CANNOT_FULFILL', 'Stale route fixture', $15, $7, 2)`,
    [ids.firstOutcome, itemIds[0], supplierId, caseId, superAdminId, `outcome-${ids.firstOutcome}`, hash,
      ids.secondOutcome, `outcome-${ids.secondOutcome}`, ids.raceOutcome, itemIds[1], `outcome-${ids.raceOutcome}`,
      ids.staleOutcome, itemIds[2], `outcome-${ids.staleOutcome}`],
  );
  await setup.query("alter table order_item_fulfillment disable trigger user");
  await setup.query("update order_item_fulfillment set state = 'ON_HOLD', state_before_hold = 'READY_FOR_HANDOFF' where order_item_id = any($1::text[])", [itemIds]);
  await setup.query("alter table order_item_fulfillment enable trigger user");
  await setup.query("alter table order_item_fulfillment_supplier disable trigger user");
  await setup.query("update order_item_fulfillment_supplier set route_generation = 3 where order_item_id = $1", [itemIds[2]]);
  await setup.query("alter table order_item_fulfillment_supplier enable trigger user");
  await setup.query("commit");

  const recoveryReason = "Supplier availability reconfirmed by the assigned Super Admin.";
  const recoveryKey = randomUUID();
  await expectDenied(async () => invoke(runtimeA, ordinaryAdminId, itemIds[0], recoveryReason, randomUUID()), /active Super Admin/);
  await expectDenied(async () => invoke(runtimeA, secondSuperAdminId, itemIds[0], recoveryReason, randomUUID()), /assigned Super Admin/);

  await runtimeA.query("begin");
  await runtimeA.query("select set_config('app.user_id', $1, true)", [superAdminId]);
  await runtimeA.query("savepoint held_packet_attempt");
  await expectDenied(() => runtimeA.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key, provider)
     values ($1, $2, 'EML_EXPORT', 'EXPORTED', $3, 'current@recovery.invalid', $4, null)`,
    [randomUUID(), packetId, superAdminId, randomUUID()],
  ), /active handoff item/);
  await runtimeA.query("rollback to savepoint held_packet_attempt");
  await runtimeA.query("release savepoint held_packet_attempt");
  await runtimeA.query("rollback");

  const concurrent = await Promise.all([
    invoke(runtimeA, superAdminId, itemIds[1], recoveryReason, recoveryKey),
    invoke(runtimeB, superAdminId, itemIds[1], recoveryReason, recoveryKey),
  ]);
  assert.equal(concurrent[0]?.recovery_id, concurrent[1]?.recovery_id, "concurrent same-key recovery returns one canonical event");
  assert.deepEqual(concurrent.map(({ replayed }) => replayed).sort(), [false, true], "one recovery transaction wins and the other replays");

  const recovered = await invoke(runtimeA, superAdminId, itemIds[0], recoveryReason, recoveryKey);
  assert.equal(recovered.replayed, false);
  const replay = await invoke(runtimeA, superAdminId, itemIds[0], recoveryReason, recoveryKey);
  assert.deepEqual(replay, { ...recovered, replayed: true }, "exact recovery replay is idempotent");
  await expectDenied(async () => invoke(runtimeA, superAdminId, itemIds[2], recoveryReason, randomUUID()), /unresolved supplier failure does not match/);

  const status = await setup.query<{ state: string; state_before_hold: string; recovery_count: number; resolved_count: number }>(
    `select fulfillment.state, fulfillment.state_before_hold,
       (select count(*)::int from supplier_fulfillment_recovery recovery where recovery.order_item_id = fulfillment.order_item_id) as recovery_count,
       (select count(*)::int from supplier_fulfillment_outcome_resolution resolution
         join supplier_fulfillment_outcome outcome on outcome.id = resolution.outcome_id
        where outcome.order_item_id = fulfillment.order_item_id and resolution.recovery_id is not null) as resolved_count
     from order_item_fulfillment fulfillment where fulfillment.order_item_id = $1`, [itemIds[0]],
  );
  assert.deepEqual(status.rows[0], { state: "ON_HOLD", state_before_hold: "READY_FOR_HANDOFF", recovery_count: 1, resolved_count: 2 },
    "recovery resolves every same-route outcome, preserves the hold, and leaves its original evidence intact");

  // A later failure on the unchanged route must reopen the equivalent-offer
  // workflow even though earlier outcomes on this generation were recovered.
  const alternativeSupplierId = randomUUID();
  const repeatOutcomeId = randomUUID();
  const replacementRequestId = randomUUID();
  const replacementVersionId = randomUUID();
  const equivalentOfferId = randomUUID();
  const replacementHash = "d".repeat(64);
  await setup.query("begin");
  await setup.query("select set_config('app.user_id',$1,true)", [superAdminId]);
  await setup.query("savepoint repeat_failure_offer");
  await setup.query(
    "insert into supplier (id,name,status,created_by_user_id) values ($1,'Recovery replacement supplier','ACTIVE',$2)",
    [alternativeSupplierId, superAdminId],
  );
  await setup.query(
    "insert into supplier_contact (id,supplier_id,name,email,is_primary) values ($1,$2,'Primary contact','replacement@recovery.invalid',true)",
    [randomUUID(), alternativeSupplierId],
  );
  await setup.query(
    `insert into supplier_fulfillment_outcome (id,order_item_id,supplier_id,support_case_id,actor_user_id,outcome,reason,idempotency_key,request_hash)
     values ($1,$2,$3,$4,$5,'CANNOT_FULFILL','Supplier failed again after recovery',$6,$7)`,
    [repeatOutcomeId, itemIds[0], supplierId, caseId, superAdminId, `repeat-${repeatOutcomeId}`, hash],
  );
  await setup.query(
    `insert into order_item_content_change_request
       (id,order_item_id,request_number,requested_by_user_id,base_version,purpose,target_supplier_id,target_url,anchor_text,article_text,instructions)
     values ($1,$2,1,$3,1,'CONTENT_CHANGE',$4,'https://replacement.example/article','replacement anchor',
       'Synthetic replacement content for database regression',NULL)`,
    [replacementRequestId, itemIds[0], ownerId, alternativeSupplierId],
  );
  await setup.query(
    `insert into order_item_content_version
       (id,order_item_id,request_id,version,target_url,anchor_text,article_text,instructions,supplier_id,recipient_email,content_hash,approved_by_user_id)
     values ($1,$2,$3,2,'https://replacement.example/article','replacement anchor',
       'Synthetic replacement content for database regression','',$4,'replacement@recovery.invalid',$5,$6)`,
    [replacementVersionId, itemIds[0], replacementRequestId, alternativeSupplierId, replacementHash, superAdminId],
  );
  await setup.query(
    `insert into order_item_equivalent_offer
       (id,order_item_id,support_case_id,content_request_id,content_version_id,title,website_url,description,equivalence_note,categories,
        country_code,language,link_type,link_validity,turnaround_days,sponsored_content_marking,terms,locked_price_minor,offered_by_user_id)
     values ($1,$2,$3,$4,$5,'Replacement fixture','https://replacement.example/','Equivalent replacement fixture',
       'Comparable audience and publication scope',ARRAY['General'],'US','English','DOFOLLOW','PERMANENT',30,false,'{}'::jsonb,3000,$6)`,
    [equivalentOfferId, itemIds[0], caseId, replacementRequestId, replacementVersionId, superAdminId],
  );
  await setup.query(
    `insert into order_item_equivalent_offer_route (offer_id,supplier_id,recipient_email,content_hash,route_generation)
     values ($1,$2,'replacement@recovery.invalid',$3,2)`, [equivalentOfferId, alternativeSupplierId, replacementHash],
  );
  const offered = await setup.query(
    `insert into order_item_equivalent_offer_event (id,offer_id,actor_user_id,event_type,content_hash)
     values ($1,$2,$3,'OFFERED',$4) returning id`, [randomUUID(), equivalentOfferId, superAdminId, replacementHash],
  );
  assert.equal(offered.rowCount, 1, "a fresh failure after recovery permits an equivalent offer on the current route");
  await setup.query("rollback to savepoint repeat_failure_offer");
  await setup.query("release savepoint repeat_failure_offer");
  await setup.query("rollback");

  await setup.query("begin");
  await setup.query("alter table order_item_fulfillment disable trigger user");
  await setup.query("update order_item_fulfillment set state = 'HANDOFF_PENDING', state_before_hold = null where order_item_id = $1", [itemIds[0]]);
  await setup.query("alter table order_item_fulfillment enable trigger user");
  await setup.query("commit");
  await runtimeA.query("begin");
  await runtimeA.query("select set_config('app.user_id', $1, true)", [superAdminId]);
  await runtimeA.query(
    `insert into supplier_packet_attempt (id, packet_id, type, state, actor_user_id, recipient, idempotency_key, provider)
     values ($1, $2, 'EML_EXPORT', 'EXPORTED', $3, 'current@recovery.invalid', $4, null)`,
    [randomUUID(), packetId, superAdminId, randomUUID()],
  );
  await runtimeA.query("commit");

  await runtimeA.query("select set_config('app.user_id', $1, false)", [superAdminId]);
  const rlsRead = await runtimeA.query("select count(*)::int as count from supplier_fulfillment_recovery where id = $1", [recovered.recovery_id]);
  assert.equal(rlsRead.rows[0]?.count, 1, "assigned Super Admin can read the recovery event through runtime RLS");
  await runtimeB.query("select set_config('app.user_id', $1, false)", [ordinaryAdminId]);
  const hiddenRead = await runtimeB.query("select count(*)::int as count from supplier_fulfillment_recovery where id = $1", [recovered.recovery_id]);
  assert.equal(hiddenRead.rows[0]?.count, 0, "unassigned Admin cannot read the recovery event");

  await setup.query("begin");
  await setup.query("savepoint immutable_recovery");
  await expectDenied(() => setup.query("update supplier_fulfillment_recovery set reason = 'changed' where id = $1", [recovered.recovery_id]), /append-only/);
  await setup.query("rollback to savepoint immutable_recovery");
  await setup.query("release savepoint immutable_recovery");
  await setup.query("rollback");

  console.log("Local supplier-recovery database regression passed: privilege and assignment checks, stale-route rejection, held-item packet blocking, concurrent idempotency, multi-outcome resolution, immutable history, scoped reads, same-route repeat failure with equivalent-offer recovery, and resumed packet-attempt validation.");
} finally {
  await Promise.all([setup.end().catch(() => undefined), runtimeA.end().catch(() => undefined), runtimeB.end().catch(() => undefined)]);
  if (created) {
    await administrator.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]).catch(() => undefined);
    await administrator.query(`drop database if exists ${databaseIdentifier} with (force)`).catch((error: unknown) => {
      console.error(`Could not drop isolated supplier-recovery database ${databaseName}: ${String(error)}`);
      process.exitCode = 1;
    });
  }
  await administrator.end().catch(() => undefined);
}
