import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvent } from "@/db/schema";
import {
  catalogImportApplyEvent, catalogImportBatch, catalogImportRow, listing, listingRevision,
  listingSourcing, listingUrl,
} from "@/db/catalog-schema";
import { applySelectedImportRowsInTransaction } from "@/server/catalog/imports";

function localDatabaseUrl(value: string | undefined, expectedRole: string): URL {
  if (!value) throw new Error("Import apply check requires database URLs from .env");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Import apply database URL is invalid"); }
  if (!(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      || !["postgres:", "postgresql:"].includes(url.protocol)
      || decodeURIComponent(url.username) !== expectedRole || url.pathname !== "/gphkm") {
    throw new Error("Import apply check is restricted to the local GPHKM database and expected role");
  }
  return url;
}

function sqlState(error: unknown): string | null {
  let current = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

const migrationUrl = localDatabaseUrl(process.env.MIGRATION_DATABASE_URL, "gphkm_migration");
localDatabaseUrl(process.env.DATABASE_URL, "gphkm_runtime");
const actorId = randomUUID();
const supplierId = randomUUID();
const batchId = randomUUID();
const readyRowId = randomUUID();
const secondReadyRowId = randomUUID();
const reviewRowId = randomUUID();
const websiteUrl = `https://f08-${randomUUID().replaceAll("-", "")}.example/`;
const secondWebsiteUrl = `https://f08-${randomUUID().replaceAll("-", "")}.example/`;
const migration = new Client({ connectionString: migrationUrl.href, connectionTimeoutMillis: 5000 });

let migrationConnected = false;
let appliedListingIds: string[] = [];

async function main() {
try {
  await migration.connect();
  migrationConnected = true;
  await migration.query("BEGIN");
  await migration.query(
    "insert into auth_user (id, name, email, email_verified) values ($1, 'Synthetic F08 Admin', $2, true)",
    [actorId, `f08-import-${actorId}@example.invalid`],
  );
  await migration.query("insert into staff_account (user_id, role, active) values ($1, 'ADMIN', true)", [actorId]);
  await migration.query(
    "insert into supplier (id, name, status, created_by_user_id) values ($1, 'Synthetic F08 Supplier', 'ACTIVE', $2)",
    [supplierId, actorId],
  );
  await migration.query(
    `insert into catalog_import_batch (id, supplier_id, source_type, content_sha256, mapping, created_by_user_id)
     values ($1, $2, 'CSV', repeat('f', 64), '{}'::jsonb, $3)`,
    [batchId, supplierId, actorId],
  );
  await migration.query(
    `insert into catalog_import_row (id, batch_id, row_number, original_values, staged_values,
       platform_category_override, proposed_retail_price_cents, status)
     values ($1, $2, 2, $3::jsonb, $3::jsonb, ARRAY['Business'], 2500, 'READY')`,
    [readyRowId, batchId, JSON.stringify({
      websiteUrl, title: "Synthetic F08 listing", description: "Synthetic import integration fixture.",
      countryCode: "US", primaryLanguage: "English", categories: ["Business"], linkType: "DOFOLLOW",
      linkValidity: "PERMANENT", turnaroundDays: 10, sponsoredContentMarking: true,
    })],
  );
  await migration.query(
    `insert into catalog_import_row (id, batch_id, row_number, original_values, staged_values,
       platform_category_override, proposed_retail_price_cents, status)
     values ($1, $2, 3, $3::jsonb, $3::jsonb, ARRAY['Business'], 3500, 'READY')`,
    [secondReadyRowId, batchId, JSON.stringify({
      websiteUrl: secondWebsiteUrl, title: "Synthetic F08 listing two", description: "Second synthetic import integration fixture.",
      countryCode: "US", primaryLanguage: "English", categories: ["Business"], linkType: "DOFOLLOW",
      linkValidity: "PERMANENT", turnaroundDays: 12, sponsoredContentMarking: true,
    })],
  );
  await migration.query(
    `insert into catalog_import_row (id, batch_id, row_number, original_values, staged_values, status)
     values ($1, $2, 4, '{"title":"Needs review"}'::jsonb, '{"title":"Needs review"}'::jsonb, 'NEEDS_REVIEW')`,
    [reviewRowId, batchId],
  );
  await migration.query("COMMIT");

  await assert.rejects(db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actorId}, true), set_config('app.organization_id', '', true)`);
    const identity = await tx.execute<{ current_user: string; session_user: string; app_user_id: string }>(sql`
      select current_user, session_user, current_setting('app.user_id', true) as app_user_id
    `);
    assert.deepEqual(identity.rows[0], {
      current_user: "gphkm_runtime", session_user: "gphkm_runtime", app_user_id: actorId,
    }, "apply runs with the real restricted runtime role and transaction-local Admin context");

    const result = await applySelectedImportRowsInTransaction(tx, actorId, batchId,
      [{ rowId: reviewRowId }, { rowId: secondReadyRowId }, { rowId: readyRowId }]);
    assert.equal(result.appliedCount, 2);
    assert.equal(result.batchStatus, "PARTIALLY_APPLIED");
    assert.equal(result.appliedListings.length, 2);
    assert.equal(result.appliedListings[0].rowId, readyRowId);
    assert.equal(result.appliedListings[0].title, "Synthetic F08 listing");
    assert.equal(result.appliedListings[0].websiteUrl, websiteUrl);
    assert.equal(result.appliedListings[0].status, "DRAFT");
    assert.equal(result.appliedListings[0].retailPriceCents, 2500);
    assert.equal(result.appliedListings[0].revision, 1);
    assert.deepEqual(result.appliedListings[1], {
      rowId: secondReadyRowId, id: result.appliedListings[1].id, title: "Synthetic F08 listing two",
      websiteUrl: secondWebsiteUrl, status: "DRAFT", retailPriceCents: 3500, revision: 1,
    });
    assert.deepEqual(result.skippedRows, [{
      rowId: reviewRowId, status: "NEEDS_REVIEW", errors: [], warnings: [], duplicateOfRow: null, duplicateOfListingIds: [],
    }], "non-ready selected rows are returned as skipped without being applied");

    appliedListingIds = result.appliedListings.map((appliedListing) => appliedListing.id);
    const persistedListings = await tx.select({
      id: listing.id, title: listing.title, description: listing.description, countryCode: listing.countryCode,
      primaryLanguage: listing.primaryLanguage, categories: listing.categories, retailPriceCents: listing.retailPriceCents,
      status: listing.status, revision: listing.revision,
      commercialSource: listingSourcing.commercialSource, supplierId: listingSourcing.supplierId,
      fulfillmentSupplierId: listingSourcing.fulfillmentSupplierId,
      urlVisibleWithoutRecharge: listingSourcing.urlVisibleWithoutRecharge,
      createdByUserId: listingSourcing.createdByUserId, websiteUrl: listingUrl.websiteUrl,
    }).from(listing)
      .innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .where(inArray(listing.id, appliedListingIds));
    assert.deepEqual(persistedListings.sort((a, b) => a.title.localeCompare(b.title)), [
      {
        id: appliedListingIds[0], title: "Synthetic F08 listing", description: "Synthetic import integration fixture.",
        countryCode: "US", primaryLanguage: "English", categories: ["Business"], retailPriceCents: "2500",
        status: "DRAFT", revision: 1, commercialSource: "SUPPLIER_SOURCED", supplierId,
        fulfillmentSupplierId: supplierId, urlVisibleWithoutRecharge: false, createdByUserId: actorId, websiteUrl,
      },
      {
        id: appliedListingIds[1], title: "Synthetic F08 listing two", description: "Second synthetic import integration fixture.",
        countryCode: "US", primaryLanguage: "English", categories: ["Business"], retailPriceCents: "3500",
        status: "DRAFT", revision: 1, commercialSource: "SUPPLIER_SOURCED", supplierId,
        fulfillmentSupplierId: supplierId, urlVisibleWithoutRecharge: false, createdByUserId: actorId, websiteUrl: secondWebsiteUrl,
      },
    ], "apply persists both drafts and their private source, supplier, and URL relationships");

    const revisions = await tx.select().from(listingRevision).where(inArray(listingRevision.listingId, appliedListingIds));
    assert.equal(revisions.length, 2);
    for (const revision of revisions) {
      assert.equal(revision.revision, 1);
      assert.equal(revision.actorUserId, actorId);
      assert.equal(revision.reason, "Initial listing draft");
    }

    const persistedRows = await tx.select({ id: catalogImportRow.id, status: catalogImportRow.status,
      appliedListingId: catalogImportRow.appliedListingId, reviewedByUserId: catalogImportRow.reviewedByUserId,
      reviewedAt: catalogImportRow.reviewedAt,
    }).from(catalogImportRow).where(inArray(catalogImportRow.id, [readyRowId, secondReadyRowId, reviewRowId]));
    const appliedRow = persistedRows.find((row) => row.id === readyRowId);
    const secondAppliedRow = persistedRows.find((row) => row.id === secondReadyRowId);
    const skippedRow = persistedRows.find((row) => row.id === reviewRowId);
    assert.equal(appliedRow?.status, "APPLIED");
    assert.equal(appliedRow?.appliedListingId, appliedListingIds[0]);
    assert.equal(appliedRow?.reviewedByUserId, actorId);
    assert.ok(appliedRow?.reviewedAt instanceof Date);
    assert.equal(secondAppliedRow?.status, "APPLIED");
    assert.equal(secondAppliedRow?.appliedListingId, appliedListingIds[1]);
    assert.equal(secondAppliedRow?.reviewedByUserId, actorId);
    assert.ok(secondAppliedRow?.reviewedAt instanceof Date);
    assert.equal(skippedRow?.status, "NEEDS_REVIEW");
    assert.equal(skippedRow?.appliedListingId, null);
    assert.equal(skippedRow?.reviewedByUserId, null);
    assert.equal(skippedRow?.reviewedAt, null);
    assert.equal(persistedRows.length, 3);

    const [batch] = await tx.select().from(catalogImportBatch).where(eq(catalogImportBatch.id, batchId));
    assert.equal(batch?.status, "PARTIALLY_APPLIED");
    assert.ok(batch?.appliedAt instanceof Date);

    const [applyEvent] = await tx.select().from(catalogImportApplyEvent).where(eq(catalogImportApplyEvent.batchId, batchId));
    assert.deepEqual(applyEvent?.selectedRowIds, [readyRowId, secondReadyRowId, reviewRowId]);
    assert.deepEqual(applyEvent?.appliedListingIds, appliedListingIds);
    assert.equal(applyEvent?.actorUserId, actorId);

    const auditRows = await tx.select({ action: auditEvent.action, targetType: auditEvent.targetType,
      targetId: auditEvent.targetId, reasonCode: auditEvent.reasonCode, metadata: auditEvent.metadata,
    }).from(auditEvent).where(eq(auditEvent.actorUserId, actorId));
    const auditEvents = auditRows.map((row) => ({
      action: row.action, targetType: row.targetType, targetId: row.targetId,
      reasonCode: row.reasonCode, metadata: row.metadata,
    })).sort((a, b) => a.action.localeCompare(b.action) || a.targetId.localeCompare(b.targetId));
    const expectedAuditEvents = [
      { action: "CATALOG_IMPORT_BATCH_APPLY_FINISHED", targetType: "catalog_import_batch", targetId: batchId,
        reasonCode: null, metadata: { itemCount: 3, result: "2_DRAFTS_CREATED" } },
      { action: "CATALOG_IMPORT_ROW_APPLIED", targetType: "catalog_import_row", targetId: readyRowId,
        reasonCode: null, metadata: { result: "DRAFT_CREATED", version: 1 } },
      { action: "CATALOG_IMPORT_ROW_APPLIED", targetType: "catalog_import_row", targetId: secondReadyRowId,
        reasonCode: null, metadata: { result: "DRAFT_CREATED", version: 1 } },
      { action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: reviewRowId,
        reasonCode: "ROW_NEEDS_REVIEW", metadata: {} },
      { action: "CATALOG_LISTING_CREATED", targetType: "marketplace_listing", targetId: appliedListingIds[0],
        reasonCode: null, metadata: { version: 1 } },
      { action: "CATALOG_LISTING_CREATED", targetType: "marketplace_listing", targetId: appliedListingIds[1],
        reasonCode: null, metadata: { version: 1 } },
    ].sort((a, b) => a.action.localeCompare(b.action) || a.targetId.localeCompare(b.targetId));
    assert.deepEqual(auditEvents, expectedAuditEvents, "apply and skip paths write exact actor-scoped audit evidence");

    await tx.execute(sql`select 1 / 0`);
  }), (error: unknown) => {
    assert.equal(sqlState(error), "22012",
      `injected division-by-zero must abort the apply transaction (received ${error instanceof Error ? error.message : String(error)})`);
    return true;
  });

  const rollbackRows = await migration.query<{ status: string; applied_listing_id: string | null }>(
    `select status::text, applied_listing_id from catalog_import_row where batch_id = $1 order by row_number`, [batchId],
  );
  assert.deepEqual(rollbackRows.rows, [
    { status: "READY", applied_listing_id: null }, { status: "READY", applied_listing_id: null },
    { status: "NEEDS_REVIEW", applied_listing_id: null },
  ], "a failed apply transaction leaves every staged row unchanged");
  const rollbackEvidence = await migration.query<{ batch_status: string; listing_count: string; apply_event_count: string; audit_count: string }>(
    `select b.status::text as batch_status,
       (select count(*)::text from marketplace_listing_url where website_url in ($2, $3)) as listing_count,
       (select count(*)::text from catalog_import_apply_event where batch_id = b.id) as apply_event_count,
       (select count(*)::text from audit_event where actor_user_id = $4) as audit_count
     from catalog_import_batch b where b.id = $1`,
    [batchId, websiteUrl, secondWebsiteUrl, actorId],
  );
  assert.deepEqual(rollbackEvidence.rows[0], {
    batch_status: "STAGED", listing_count: "0", apply_event_count: "0", audit_count: "0",
  }, "transaction rollback removes the draft, apply event, and all audit records");
  console.log("Local import apply transaction check passed (synthetic fixture; all apply writes rolled back).");
} finally {
  try {
    if (migrationConnected) {
      try {
        await migration.query("ROLLBACK").catch(() => undefined);
        await migration.query("BEGIN");
        await migration.query("delete from catalog_import_row where batch_id = $1", [batchId]);
        await migration.query("delete from catalog_import_batch where id = $1", [batchId]);
        await migration.query("delete from supplier where id = $1", [supplierId]);
        await migration.query("delete from staff_account where user_id = $1", [actorId]);
        await migration.query("delete from auth_user where id = $1", [actorId]);
        await migration.query("COMMIT");
        const remaining = await migration.query<{ batches: string; suppliers: string; staff: string; users: string }>(
          `select (select count(*)::text from catalog_import_batch where id = $1) as batches,
             (select count(*)::text from supplier where id = $2) as suppliers,
             (select count(*)::text from staff_account where user_id = $3) as staff,
             (select count(*)::text from auth_user where id = $3) as users`,
          [batchId, supplierId, actorId],
        );
        assert.deepEqual(remaining.rows[0], { batches: "0", suppliers: "0", staff: "0", users: "0" },
          "finally removes all synthetic import fixtures");
      } catch (error) {
        await migration.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
  } finally {
    try {
      if (migrationConnected) await migration.end();
    } finally {
      await db.$client.end();
    }
  }
}
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
