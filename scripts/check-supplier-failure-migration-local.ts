import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

function localProjectUrl(value: string | undefined, role: string) {
  if (!value) throw new Error("Migration regression requires local database URLs from .env");
  const url = new URL(value);
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || !["postgres:", "postgresql:"].includes(url.protocol)
      || decodeURIComponent(url.username) !== role || url.pathname !== "/gphkm") {
    throw new Error("Migration regression is restricted to the local GPHKM database and expected migration role");
  }
  return url;
}

const migrationUrl = localProjectUrl(process.env.MIGRATION_DATABASE_URL, "gphkm_migration");
const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
const journalPath = join(migrationDir, "meta/_journal.json");
const sourceJournal = JSON.parse(await readFile(journalPath, "utf8")) as {
  version: string; dialect: string; entries: Array<{ tag: string; idx: number; when: number; [key: string]: unknown }>;
};
const migration168Entry = sourceJournal.entries.find((entry) => entry.tag === "0168_supplier_failure_route_generation");
if (!migration168Entry) throw new Error("Migration journal is missing 0168_supplier_failure_route_generation");
const priorEntries = sourceJournal.entries.filter((entry) => entry.idx < migration168Entry.idx);
const migration168When = migration168Entry.when;
const isolatedMigrationDir = await mkdtemp(join(tmpdir(), "gphkm-0168-before-")).catch((error: unknown) => {
  throw new Error(`Could not create a temporary migration directory: ${String(error)}`);
});
await mkdir(join(isolatedMigrationDir, "meta"), { recursive: true });
await writeFile(join(isolatedMigrationDir, "meta/_journal.json"), JSON.stringify({
  version: sourceJournal.version,
  dialect: sourceJournal.dialect,
  entries: priorEntries,
}, null, 2));
for (const entry of priorEntries) {
  await copyFile(join(migrationDir, `${entry.tag}.sql`), join(isolatedMigrationDir, `${entry.tag}.sql`));
}

const admin = new Client({ connectionString: migrationUrl.href, connectionTimeoutMillis: 5000 });
const testDatabases: string[] = [];
const templateDatabase = `gphkm_0168_template_${process.pid}_${randomUUID().slice(0, 6)}`;
let templateCreated = false;

function databaseIdentifier(name: string) {
  if (!/^gphkm_0168_[a-z0-9_]+$/.test(name)) throw new Error("Unexpected isolated database name");
  return `"${name}"`;
}

function databaseUrl(name: string) {
  const url = new URL(migrationUrl);
  url.pathname = `/${name}`;
  return url;
}

async function migrateFolder(databaseName: string, folder: string) {
  const pool = new Pool({ connectionString: databaseUrl(databaseName).href, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

type Scenario = "safe" | "legacy" | "completed" | "ambiguous" | "missing_fulfillment";

async function seedScenario(databaseName: string, scenario: Scenario) {
  const client = new Client({ connectionString: databaseUrl(databaseName).href, connectionTimeoutMillis: 5000 });
  await client.connect();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const organizationId = randomUUID();
  const orderId = randomUUID();
  const caseId = randomUUID();
  const supplierAId = randomUUID();
  const supplierBId = randomUUID();
  const itemCount = scenario === "safe" ? 3 : 1;
  const itemIds = Array.from({ length: itemCount }, () => randomUUID());
  const listingIds = Array.from({ length: itemCount }, () => randomUUID());
  const outcomeIds = itemIds.map(() => randomUUID());
  const contentHash = "8".repeat(64);

  try {
    await client.query("begin");
    await client.query("alter table customer_order disable trigger customer_order_requires_debit");
    await client.query("alter table customer_order_item disable trigger customer_order_item_pending_only");
    await client.query(
      `insert into auth_user (id, name, email, email_verified) values ($1, 'Migration owner', $2, true), ($3, 'Migration admin', $4, true)`,
      [ownerId, `${ownerId}@migration.invalid`, adminId, `${adminId}@migration.invalid`],
    );
    await client.query("insert into staff_account (user_id, role, active) values ($1, 'SUPER_ADMIN', true)", [adminId]);
    await client.query("select set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)", [adminId, organizationId]);
    await client.query("insert into organization (id, name, created_by) values ($1, '0168 migration fixture', $2)", [organizationId, ownerId]);
    await client.query(
      `insert into supplier (id, name, status, created_by_user_id) values ($1, 'Migration source A', 'ACTIVE', $3), ($2, 'Migration target B', 'ACTIVE', $3)`,
      [supplierAId, supplierBId, adminId],
    );
    await client.query(
      `insert into supplier_contact (id, supplier_id, name, email, is_primary) values
         ($1, $3, 'Source contact', 'source@migration.invalid', true),
         ($2, $4, 'Target contact', 'target@migration.invalid', true)`,
      [randomUUID(), randomUUID(), supplierAId, supplierBId],
    );
    await client.query(
      `insert into customer_order (id, organization_id, actor_user_id, idempotency_key, request_hash,
         placement_total_minor, writing_total_minor, total_minor, content_sharing_notice_version,
         content_policy_version, content_policy_accepted_at, customer_status, checkout_state)
       values ($1, $2, $3, $4, repeat('a', 64), $5, 0, $5, 'gphkm-content-sharing-v1',
         'gphkm-content-policy-v1', clock_timestamp(), 'ORDER_RECEIVED', 'PENDING_POST')`,
      [orderId, organizationId, ownerId, `migration-${orderId}`, itemCount * 1000],
    );
    for (let index = 0; index < itemCount; index += 1) {
      await client.query(
        `insert into marketplace_listing (id, title, description, country_code, primary_language, categories,
           retail_price_cents, link_type, link_validity, turnaround_days, sponsored_content_marking, status,
           allows_sports_and_gaming, allows_pharmacy, allows_crypto, allows_foreign_language)
         values ($1, $2, 'Migration fixture listing', 'US', 'English', ARRAY['General'],
           1000, 'DOFOLLOW', 'PERMANENT', 30, false, 'DRAFT', false, false, false, false)`,
        [listingIds[index], `Migration fixture ${index + 1}`],
      );
      await client.query(
        `insert into customer_order_item (id, order_id, listing_id, listing_revision, customer_listing_snapshot,
           placement_price_minor, writing_selected, target_url, anchor_text, article_text,
           supplier_sharing_consented, consent_notice_version)
         values ($1, $2, $3, 1, jsonb_build_object('title', $4::text), 1000, false,
           'https://example.invalid/migration', 'migration fixture', 'Synthetic content for migration testing',
           true, 'gphkm-content-sharing-v1')`,
        [itemIds[index], orderId, listingIds[index], `Migration fixture ${index + 1}`],
      );
    }
    await client.query("alter table customer_order_item enable trigger customer_order_item_pending_only");
    await client.query("alter table customer_order enable trigger customer_order_requires_debit");
    for (const itemId of itemIds) {
      await client.query(
        `insert into order_item_financial (order_item_id, commercial_source, supplier_id, fulfillment_supplier_id)
         values ($1, 'SUPPLIER_SOURCED', $2, $2)`, [itemId, supplierAId],
      );
    }
    await client.query("alter table support_case disable trigger support_case_guard");
    await client.query(
      `insert into support_case (id, organization_id, order_id, order_item_id, opened_by_user_id, summary, idempotency_key, request_hash)
       values ($1, $2, $3, $4, $5, 'Migration fixture supplier outcome', $6, repeat('b', 64))`,
      [caseId, organizationId, orderId, itemIds[0], ownerId, `case-${caseId}`],
    );
    await client.query("alter table support_case enable trigger support_case_guard");

    for (let index = 0; index < itemCount; index += 1) {
      const failedSupplier = scenario === "safe" && index === 2 ? supplierBId : supplierAId;
      await client.query(
        `insert into supplier_fulfillment_outcome (id, order_item_id, supplier_id, support_case_id, actor_user_id,
           outcome, reason, idempotency_key, request_hash)
         values ($1, $2, $3, $4, $5, 'CANNOT_FULFILL', 'Synthetic pre-0168 outcome fixture', $6, repeat('c', 64))`,
        [outcomeIds[index], itemIds[index], failedSupplier, caseId, adminId, `outcome-${outcomeIds[index]}`],
      );
    }

    const transitions = scenario === "safe" ? new Map([[1, [supplierBId]], [2, [supplierBId]]])
      : scenario === "legacy" ? new Map([[0, [supplierBId]]])
      : scenario === "ambiguous" ? new Map([[0, [supplierBId, supplierAId]]])
        : new Map<number, string[]>();
    for (const [itemIndex, suppliers] of transitions) {
      for (let transitionIndex = 0; transitionIndex < suppliers.length; transitionIndex += 1) {
        const targetSupplierId = suppliers[transitionIndex]!;
        // 0162 backfilled an already-accepted route as generation 1. Recreate
        // that exact shape separately from current generation-2 acceptances.
        const generation = scenario === "legacy" ? 1 : transitionIndex + 2;
        const contentVersion = scenario === "legacy" ? 2 : generation;
        const requestId = randomUUID();
        const versionId = randomUUID();
        const offerId = randomUUID();
        const targetUrl = `https://example.invalid/route-${generation}`;
        await client.query(
          `insert into order_item_content_change_request (id, order_item_id, request_number, requested_by_user_id,
             base_version, target_supplier_id, target_url, anchor_text, article_text)
           values ($1, $2, $3, $4, $5, $6, $7, 'migration fixture', 'Synthetic approved migration content')`,
          [requestId, itemIds[itemIndex], Math.max(1, contentVersion - 1), ownerId, Math.max(1, contentVersion - 1), targetSupplierId, targetUrl],
        );
        await client.query(
          `insert into order_item_content_version (id, order_item_id, request_id, version, target_url, anchor_text,
             article_text, instructions, supplier_id, recipient_email, content_hash, approved_by_user_id)
           values ($1, $2, $3, $4, $5, 'migration fixture', 'Synthetic approved migration content', '', $6,
             'migration@fixture.invalid', $7, $8)`,
          [versionId, itemIds[itemIndex], requestId, contentVersion, targetUrl, targetSupplierId, contentHash, adminId],
        );
        await client.query(
          `insert into order_item_equivalent_offer (id, order_item_id, support_case_id, content_request_id,
             content_version_id, title, website_url, description, equivalence_note, categories, country_code,
             language, link_type, link_validity, turnaround_days, sponsored_content_marking, terms,
             locked_price_minor, offered_by_user_id)
           values ($1, $2, $3, $4, $5, 'Migration equivalent', 'https://replacement.example/',
             'Synthetic equivalent offer', 'Equivalent terms for migration fixture', ARRAY['General'], 'US',
             'English', 'DOFOLLOW', 'PERMANENT', 30, false, '{"migration":true}'::jsonb, 1000, $6)`,
          [offerId, itemIds[itemIndex], caseId, requestId, versionId, adminId],
        );
        await client.query(
          `insert into order_item_equivalent_offer_route (offer_id, supplier_id, recipient_email, content_hash, route_generation)
           values ($1, $2, 'migration@fixture.invalid', $3, $4)`,
          [offerId, targetSupplierId, contentHash, generation],
        );
        await client.query("alter table order_item_equivalent_offer_event disable trigger user");
        await client.query(
          `insert into order_item_equivalent_offer_event (id, offer_id, actor_user_id, event_type, content_hash, notice_version)
           values ($1, $2, $3, 'ACCEPTED', $4, 'gphkm-content-sharing-v1')`,
          [randomUUID(), offerId, ownerId, contentHash],
        );
        await client.query("alter table order_item_equivalent_offer_event enable trigger user");
        await client.query(
          `update order_item_fulfillment_supplier set supplier_id = $2, route_generation = $3, last_equivalent_offer_id = $4
            where order_item_id = $1`, [itemIds[itemIndex], targetSupplierId, generation, offerId],
        );
      }
    }

    if (scenario === "completed") {
      await client.query("alter table order_item_fulfillment disable trigger user");
      await client.query("update order_item_fulfillment set state = 'COMPLETED' where order_item_id = $1", [itemIds[0]]);
      await client.query("alter table order_item_fulfillment enable trigger user");
    }
    if (scenario === "missing_fulfillment") {
      await client.query("alter table customer_order_item_milestone disable trigger user");
      await client.query("delete from customer_order_item_milestone where order_item_id = $1", [itemIds[0]]);
      await client.query("alter table customer_order_item_milestone enable trigger user");
      await client.query("delete from order_item_fulfillment_supplier where order_item_id = $1", [itemIds[0]]);
      await client.query("delete from order_item_fulfillment where order_item_id = $1", [itemIds[0]]);
    }
    await client.query("commit");

    return { itemIds, outcomeIds, supplierAId, supplierBId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function migrationErrorText(error: unknown) {
  const parts: string[] = [];
  let current = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

async function runScenario(templateName: string, scenario: Scenario) {
  const databaseName = `gphkm_0168_${scenario}_${process.pid}_${randomUUID().slice(0, 5)}`;
  await admin.query(`create database ${databaseIdentifier(databaseName)} owner gphkm_migration template ${databaseIdentifier(templateName)}`);
  testDatabases.push(databaseName);
  const seeded = await seedScenario(databaseName, scenario);
  let migrationFailure: unknown;
  try {
    await migrateFolder(databaseName, migrationDir);
  } catch (error) {
    migrationFailure = error;
  }

  const verify = new Client({ connectionString: databaseUrl(databaseName).href, connectionTimeoutMillis: 5000 });
  await verify.connect();
  try {
    if (scenario === "safe" || scenario === "legacy") {
      if (migrationFailure) {
        const debug = await verify.query(
          `select outcome.id, outcome.supplier_id, financial.fulfillment_supplier_id,
                  route.supplier_id as current_supplier_id, route.route_generation as current_generation,
                  route.last_equivalent_offer_id, (select count(*) from order_item_equivalent_offer offer
                    join order_item_equivalent_offer_event event on event.offer_id = offer.id
                    where offer.order_item_id = outcome.order_item_id and event.event_type = 'ACCEPTED') as accepted_count
             from supplier_fulfillment_outcome outcome join order_item_financial financial on financial.order_item_id = outcome.order_item_id
             join order_item_fulfillment_supplier route on route.order_item_id = outcome.order_item_id
            where outcome.id = any($1::text[]) order by array_position($1::text[], outcome.id)`, [seeded.outcomeIds],
        );
        console.error(`safe migration seed: ${JSON.stringify(debug.rows)}`);
      }
      assert.equal(migrationFailure, undefined, "a provable single accepted A→B route should migrate safely");
      const result = await verify.query<{ outcome_id: string; route_generation: number; resolved: boolean }>(
        `select outcome.id as outcome_id, outcome.route_generation,
           exists (select 1 from supplier_fulfillment_outcome_resolution resolution where resolution.outcome_id = outcome.id) as resolved
           from supplier_fulfillment_outcome outcome where outcome.id = any($1::text[]) order by array_position($1::text[], outcome.id)`,
        [seeded.outcomeIds],
      );
      if (scenario === "safe") {
        assert.deepEqual(result.rows, [
          { outcome_id: seeded.outcomeIds[0], route_generation: 1, resolved: false },
          { outcome_id: seeded.outcomeIds[1], route_generation: 1, resolved: true },
          { outcome_id: seeded.outcomeIds[2], route_generation: 2, resolved: false },
        ], "legacy source generations and the accepted-offer resolution edge match the provable generation-2 A→B history");
      } else {
        assert.deepEqual(result.rows, [
          { outcome_id: seeded.outcomeIds[0], route_generation: 1, resolved: true },
        ], "the accepted-route state backfilled by 0162 resolves its generation-1 checkout-source failure");
      }
    } else {
      assert.ok(migrationFailure, `${scenario} history must stop migration for manual reconciliation`);
      assert.match(migrationErrorText(migrationFailure), /migration blocked: .*historical supplier failure/);
      const schemaState = await verify.query<{ outcome_has_generation: boolean; resolution_table_exists: boolean; migration_168_recorded: boolean }>(
        `select exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'supplier_fulfillment_outcome' and column_name = 'route_generation') as outcome_has_generation,
           to_regclass('public.supplier_fulfillment_outcome_resolution') is not null as resolution_table_exists,
           exists (select 1 from drizzle.__drizzle_migrations where created_at = $1) as migration_168_recorded`,
        [migration168When],
      );
      assert.deepEqual(schemaState.rows[0], { outcome_has_generation: false, resolution_table_exists: false, migration_168_recorded: false },
        "a blocked upgrade leaves no partial schema or migration record");
    }
  } finally {
    await verify.end();
  }
}

try {
  await admin.connect();
  await admin.query(`create database ${databaseIdentifier(templateDatabase)} owner gphkm_migration template template0`);
  templateCreated = true;
  await migrateFolder(templateDatabase, isolatedMigrationDir);
  await runScenario(templateDatabase, "safe");
  await runScenario(templateDatabase, "legacy");
  await runScenario(templateDatabase, "completed");
  await runScenario(templateDatabase, "ambiguous");
  await runScenario(templateDatabase, "missing_fulfillment");
  console.log("Migration 0168 upgrade fixtures passed: generation-1 routes backfilled by 0162, generation-2 A→B history, current-source generation, completed-item and A→B→A preflight failures, missing fulfillment detection, and failed-migration rollback.");
} catch (error) {
  console.error(migrationErrorText(error));
  process.exitCode = 1;
} finally {
  for (const databaseName of testDatabases) {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]).catch(() => undefined);
    await admin.query(`drop database if exists ${databaseIdentifier(databaseName)} with (force)`).catch((error: unknown) => {
      console.error(error instanceof Error ? `Could not remove ${databaseName}: ${error.message}` : `Could not remove ${databaseName}`);
      process.exitCode = 1;
    });
  }
  if (templateCreated) {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [templateDatabase]).catch(() => undefined);
    await admin.query(`drop database if exists ${databaseIdentifier(templateDatabase)} with (force)`).catch(() => { process.exitCode = 1; });
  }
  await admin.end().catch(() => undefined);
  await rm(isolatedMigrationDir, { recursive: true, force: true });
}
