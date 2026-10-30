import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { catalogImportApplyEvent, catalogImportBatch, catalogImportRow, listing, listingSourcing, listingUrl, supplier, } from "@/db/catalog-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { buildImportMapping, fetchPublicSheetCsv, extractPublicSheetReference, getPersistableImportValues, IMPORT_LIMITS, parseCsv, parseInventoryFile, resolveDuplicate, stageImportRows, toDraftListingInput, type ImportCandidate, type ImportMapping } from "@/modules/catalog/imports";
import { normalizeWebsiteUrl, validateListingRelationships, validateListingTerms, type ListingTerms } from "@/modules/catalog/domain";
import { parseUsdMinorUnits } from "@/modules/wallet/usd-amount";
import { insertDraftListingInTransaction, staffTransaction } from "./admin";
import { deletePrivateFile, readPrivateFile, savePrivateFile } from "@/server/storage/private-files";

const importSourceSupplier = alias(supplier, "import_source_supplier");
const importFulfillmentSupplier = alias(supplier, "import_fulfillment_supplier");

export type StageInventoryInput = {
  supplierId: string;
  sourceType: "CSV" | "XLSX" | "GOOGLE_SHEETS";
  file?: { name: string; bytes: Buffer };
  sheetReference?: string;
  sheetIndex?: number;
  headerRowNumber?: number;
  mapping: ImportMapping;
};

export async function stageInventoryImport(headers: Headers, input: StageInventoryInput) {
  await requireStaffAccess(headers, "supplier.manage");
  const headerRowNumber = input.headerRowNumber ?? 1;
  if (!Number.isInteger(headerRowNumber) || headerRowNumber < 1 || headerRowNumber > 100) throw new Error("IMPORT_HEADER_ROW_INVALID");
  let parsed;
  let content: Buffer;
  let sourceReference: string | null = null;
  let sourceFilename: string | null = null;
  if (input.sourceType === "GOOGLE_SHEETS") {
    if (!input.sheetReference || input.file) throw new Error("SHEET_REFERENCE_INVALID");
    const ref = extractPublicSheetReference(input.sheetReference);
    const csv = await fetchPublicSheetCsv(input.sheetReference);
    content = Buffer.from(csv, "utf8");
    parsed = [parseCsv(csv)];
    sourceReference = `${ref.spreadsheetId}:${ref.gid}`;
  } else {
    if (!input.file || input.sheetReference || input.file.bytes.byteLength < 1 || input.file.bytes.byteLength > IMPORT_LIMITS.fileBytes) {
      throw new Error("IMPORT_FILE_TOO_LARGE");
    }
    const detectedSourceType = /\.xlsx$/i.test(input.file.name) ? "XLSX" : /\.csv$/i.test(input.file.name) ? "CSV" : null;
    if (!detectedSourceType || detectedSourceType !== input.sourceType) throw new Error("IMPORT_SOURCE_TYPE_MISMATCH");
    content = input.file.bytes;
    sourceFilename = input.file.name;
    parsed = await parseInventoryFile(input.file.name, content);
  }
  const sheetIndex = input.sourceType === "XLSX" ? input.sheetIndex ?? 0 : 0;
  if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= parsed.length) throw new Error("IMPORT_SHEET_INVALID");
  const sheet = parsed[sheetIndex];
  const mapping = buildImportMapping(sheet.rows[headerRowNumber - 1] ?? [], input.mapping);
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const batchId = randomUUID();
  const sourceObjectKey = await savePrivateFile(content);

  let transactionCallbackReturned = false;
  try {
    const result = await staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const [supplierRow] = await tx.select({ id: supplier.id }).from(supplier).where(eq(supplier.id, input.supplierId)).limit(1);
    if (!supplierRow) throw new Error("Supplier unavailable");
    const existingListings = await tx.select({ id: listingUrl.listingId, websiteUrl: listingUrl.websiteUrl }).from(listingUrl);
    const candidates = stageImportRows({ rows: sheet.rows, mapping, existingListings, headerRowNumber });
    await tx.insert(catalogImportBatch).values({
      id: batchId, supplierId: input.supplierId, sourceType: input.sourceType, sourceReference,
      sourceFilename, sourceObjectKey, sourceBytes: content.byteLength, contentSha256,
      mapping: { ...mapping, __headerRowNumber: headerRowNumber }, createdByUserId: userId,
    });
    const stagedRows = candidates.map((candidate) => {
      const row = sheet.rows[candidate.rowNumber - 1] ?? [];
      const persistable = getPersistableImportValues(candidate, row, mapping);
      return {
        id: randomUUID(), batchId, rowNumber: candidate.rowNumber, originalValues: persistable.originalValues,
        stagedValues: persistable.stagedValues, errors: candidate.errors, warnings: candidate.warnings,
        duplicateOfRow: candidate.duplicateOfRow, duplicateOfListingIds: candidate.duplicateOfListingIds,
        status: candidate.status,
      };
    });
    for (let index = 0; index < stagedRows.length; index += 500) {
      await tx.insert(catalogImportRow).values(stagedRows.slice(index, index + 500));
    }
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_STAGED", targetType: "catalog_import_batch", targetId: batchId, metadata: { result: input.sourceType, itemCount: candidates.length } });
    transactionCallbackReturned = true;
    return { batchId, rowCount: candidates.length };
    });
    return result;
  } catch (error) {
    // A lost commit acknowledgement is ambiguous. Keep the source once the
    // callback completed so a committed batch never points at a deleted file.
    if (!transactionCallbackReturned) await deletePrivateFile(sourceObjectKey).catch(() => undefined);
    throw error;
  }
}

export async function listStagedImports(headers: Headers) {
  return staffTransaction(headers, "supplier.manage", async (tx) => tx.select({
    id: catalogImportBatch.id, sourceType: catalogImportBatch.sourceType, sourceFilename: catalogImportBatch.sourceFilename,
    status: catalogImportBatch.status, createdAt: catalogImportBatch.createdAt, supplierId: catalogImportBatch.supplierId,
    supplierName: supplier.name, rowCount: sql<number>`(select count(*)::int from catalog_import_row r where r.batch_id = ${catalogImportBatch.id})`,
  }).from(catalogImportBatch).innerJoin(supplier, eq(supplier.id, catalogImportBatch.supplierId))
    .orderBy(desc(catalogImportBatch.createdAt)).limit(50));
}

export async function getStagedImportRows(headers: Headers, batchId: string, page = 0) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || !Number.isInteger(page) || page < 0 || page > 99) throw new Error("Import unavailable");
  return staffTransaction(headers, "supplier.manage", async (tx, _userId, role) => {
    const [batch] = await tx.select({ sourceType: catalogImportBatch.sourceType, sourceFilename: catalogImportBatch.sourceFilename,
      sourceObjectKey: catalogImportBatch.sourceObjectKey }).from(catalogImportBatch).where(eq(catalogImportBatch.id, batchId)).limit(1);
    if (!batch) throw new Error("Import unavailable");
    const rows = await tx.select({
      id: catalogImportRow.id, rowNumber: catalogImportRow.rowNumber, originalValues: catalogImportRow.originalValues,
      values: catalogImportRow.stagedValues, errors: catalogImportRow.errors,
      warnings: catalogImportRow.warnings, duplicateOfRow: catalogImportRow.duplicateOfRow,
      duplicateOfListingIds: catalogImportRow.duplicateOfListingIds, duplicateDecision: catalogImportRow.duplicateDecision,
      duplicateReason: catalogImportRow.duplicateReason, status: catalogImportRow.status,
    }).from(catalogImportRow).where(eq(catalogImportRow.batchId, batchId)).orderBy(asc(catalogImportRow.rowNumber)).limit(51).offset(page * 50);
    const visibleRows = rows.slice(0, 50);
    const matchIds = [...new Set(visibleRows.flatMap((row) => row.duplicateOfListingIds.slice(0, 3)))];
    const matches = matchIds.length ? await tx.select({
      id: listing.id, title: listing.title, description: listing.description, countryCode: listing.countryCode,
      primaryLanguage: listing.primaryLanguage, categories: listing.categories, retailPriceCents: listing.retailPriceCents,
      linkType: listing.linkType, linkValidity: listing.linkValidity, turnaroundDays: listing.turnaroundDays,
      allowsSportsAndGaming: listing.allowsSportsAndGaming, allowsPharmacy: listing.allowsPharmacy,
      allowsCrypto: listing.allowsCrypto, allowsForeignLanguage: listing.allowsForeignLanguage,
      sponsoredContentMarking: listing.sponsoredContentMarking, status: listing.status, revision: listing.revision,
      websiteUrl: listingUrl.websiteUrl, commercialSource: listingSourcing.commercialSource,
      sourceSupplierName: importSourceSupplier.name, fulfillmentSupplierName: importFulfillmentSupplier.name,
    }).from(listing).innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .leftJoin(importSourceSupplier, eq(importSourceSupplier.id, listingSourcing.supplierId))
      .leftJoin(importFulfillmentSupplier, eq(importFulfillmentSupplier.id, listingSourcing.fulfillmentSupplierId))
      .where(inArray(listing.id, matchIds)) : [];
    const matchesById = new Map(matches.map((match) => [match.id, match]));
    return { rows: visibleRows.map((row) => ({ ...row, duplicateMatches: row.duplicateOfListingIds
      .slice(0, 3).flatMap((id) => matchesById.has(id) ? [matchesById.get(id)!] : []),
      hiddenMatchCount: Math.max(0, row.duplicateOfListingIds.length - 3),
    })), hasNext: rows.length > 50, hasPrevious: page > 0,
      sourceAvailable: batch.sourceObjectKey !== null, actorRole: role };
  });
}

export async function downloadStagedImportSource(headers: Headers, batchId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Import source unavailable");
  const batch = await staffTransaction(headers, "supplier.manage", async (tx, _userId, role) => {
    if (role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const [batch] = await tx.select().from(catalogImportBatch).where(eq(catalogImportBatch.id, batchId)).limit(1);
    if (!batch?.sourceObjectKey || !batch.sourceBytes) throw new Error("Import source unavailable");
    return batch;
  });
  const bytes = await readPrivateFile(batch.sourceObjectKey!, IMPORT_LIMITS.fileBytes);
  if (bytes.byteLength !== batch.sourceBytes || createHash("sha256").update(bytes).digest("hex") !== batch.contentSha256) {
    throw new Error("Import source integrity check failed");
  }
  await staffTransaction(headers, "supplier.manage", async (tx, userId, role) => {
    if (role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const [current] = await tx.select({ sourceObjectKey: catalogImportBatch.sourceObjectKey }).from(catalogImportBatch).where(eq(catalogImportBatch.id, batchId)).limit(1);
    if (current?.sourceObjectKey !== batch.sourceObjectKey) throw new Error("Import source unavailable");
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_SOURCE_DOWNLOADED", targetType: "catalog_import_batch", targetId: batchId, metadata: { sourceType: batch.sourceType, result: "ALLOWED" } });
  });
  const extension = batch.sourceType === "XLSX" ? "xlsx" : "csv";
  const basename = batch.sourceFilename?.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return { bytes, filename: basename && basename.includes(".") ? basename : `inventory-${batchId}.${extension}` };
}

const correctableFields = new Set([
  "websiteUrl", "title", "description", "countryCode", "primaryLanguage", "categories", "linkType", "linkValidity",
  "turnaroundDays", "allowsSportsAndGaming", "allowsPharmacy", "allowsCrypto", "allowsForeignLanguage", "sponsoredContentMarking",
]);

function rowCandidate(row: { rowNumber: number; values: unknown; errors: unknown; warnings: unknown; duplicateOfRow: number | null; duplicateOfListingIds: string[]; status: string; duplicateDecision: string | null; duplicateReason: string | null; duplicateDecidedByUserId?: string | null; duplicateDecidedAt?: Date | null }): ImportCandidate {
  const values = row.values && typeof row.values === "object" && !Array.isArray(row.values) ? row.values as ImportCandidate["values"] : {};
  const websiteUrl = typeof values.websiteUrl === "string" ? values.websiteUrl : null;
  return {
    rowNumber: row.rowNumber, sourceDomain: websiteUrl ? new URL(websiteUrl).hostname : null, values,
    errors: Array.isArray(row.errors) ? row.errors as ImportCandidate["errors"] : [],
    warnings: Array.isArray(row.warnings) ? row.warnings as ImportCandidate["warnings"] : [],
    duplicateOfRow: row.duplicateOfRow, duplicateOfListingIds: row.duplicateOfListingIds,
    status: row.status as ImportCandidate["status"],
    duplicateResolution: row.duplicateDecision && row.duplicateReason && row.duplicateDecidedByUserId && row.duplicateDecidedAt ? {
      decision: row.duplicateDecision as "KEEP_SEPARATE" | "REJECT", staffUserId: row.duplicateDecidedByUserId,
      reason: row.duplicateReason, decidedAt: row.duplicateDecidedAt.toISOString(),
    } : null,
  };
}

async function lockImport(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], batchId: string) {
  const [batch] = await tx.select().from(catalogImportBatch).where(eq(catalogImportBatch.id, batchId)).for("update").limit(1);
  if (!batch) throw new Error("Import unavailable");
  return batch;
}

async function refreshBatchStatus(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], batchId: string, appliedAt: Date | null) {
  const rows = await tx.select({ status: catalogImportRow.status }).from(catalogImportRow).where(eq(catalogImportRow.batchId, batchId));
  const applied = rows.filter((row) => row.status === "APPLIED").length;
  const pending = rows.some((row) => row.status !== "APPLIED" && row.status !== "REJECTED");
  let status: "STAGED" | "PARTIALLY_APPLIED" | "APPLIED" | "REJECTED" = "STAGED";
  if (rows.length > 0 && !pending) status = applied > 0 ? "APPLIED" : "REJECTED";
  else if (applied > 0) status = "PARTIALLY_APPLIED";
  await tx.update(catalogImportBatch).set({ status, appliedAt: status === "STAGED" || status === "REJECTED" ? null : appliedAt ?? new Date() })
    .where(eq(catalogImportBatch.id, batchId));
  return status;
}

export async function correctStagedImportRow(headers: Headers, batchId: string, rowId: string, corrections: Record<string, string>) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || !/^[0-9a-f-]{36}$/i.test(rowId)) throw new Error("Import row unavailable");
  for (const field of Object.keys(corrections)) if (!correctableFields.has(field)) throw new Error("Import field cannot be corrected");
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const importBatch = await lockImport(tx, batchId);
    const [row] = await tx.select().from(catalogImportRow).where(and(eq(catalogImportRow.id, rowId), eq(catalogImportRow.batchId, batchId))).for("update").limit(1);
    if (!row || row.status === "APPLIED" || row.status === "REJECTED") throw new Error("Import row cannot be corrected");
    const rawMapping = importBatch.mapping as ImportMapping;
    const safeMapping = rawMapping;
    const original = { ...(row.originalValues as Record<string, unknown>) };
    for (const field of Object.keys(original)) if (correctableFields.has(field) && safeMapping[field as keyof ImportMapping] === undefined) {
      safeMapping[field as keyof ImportMapping] = Math.max(-1, ...Object.values(safeMapping)) + 1;
    }
    for (const [field, value] of Object.entries(corrections)) original[field] = value;
    for (const field of Object.keys(corrections)) if (safeMapping[field as keyof ImportMapping] === undefined) {
      safeMapping[field as keyof ImportMapping] = Math.max(-1, ...Object.values(safeMapping)) + 1;
    }
    const maxColumn = Math.max(...Object.values(safeMapping));
    const headersRow = Array.from({ length: maxColumn + 1 }, (_, index) => `Column ${index}`);
    const sourceRow = Array.from({ length: maxColumn + 1 }, () => null as unknown);
    for (const [field, column] of Object.entries(safeMapping)) sourceRow[column] = original[field] ?? null;
    const existingListings = await tx.select({ id: listingUrl.listingId, websiteUrl: listingUrl.websiteUrl }).from(listingUrl);
    const candidate = stageImportRows({ rows: [headersRow, sourceRow], mapping: safeMapping, existingListings })[0];
    candidate.rowNumber = row.rowNumber;
    const otherRows = await tx.select({ rowNumber: catalogImportRow.rowNumber, stagedValues: catalogImportRow.stagedValues, status: catalogImportRow.status })
      .from(catalogImportRow).where(eq(catalogImportRow.batchId, batchId));
    const currentUrl = typeof candidate.values.websiteUrl === "string" ? normalizeWebsiteUrl(candidate.values.websiteUrl) : null;
    const sameBatch = currentUrl && otherRows.find((other) => other.rowNumber !== row.rowNumber && other.status !== "REJECTED" &&
      typeof (other.stagedValues as Record<string, unknown>).websiteUrl === "string" &&
      normalizeWebsiteUrl((other.stagedValues as Record<string, unknown>).websiteUrl) === currentUrl);
    if (sameBatch) {
      candidate.duplicateOfRow = sameBatch.rowNumber;
      if (!candidate.warnings.includes("POSSIBLE_DUPLICATE_DOMAIN")) candidate.warnings.push("POSSIBLE_DUPLICATE_DOMAIN");
      if (!candidate.errors.length) candidate.status = "DUPLICATE_REVIEW";
    }
    const persisted = getPersistableImportValues(candidate, sourceRow, safeMapping);
    await tx.update(catalogImportRow).set({
      originalValues: persisted.originalValues, stagedValues: persisted.stagedValues, errors: candidate.errors,
      warnings: candidate.warnings, duplicateOfRow: candidate.duplicateOfRow, duplicateOfListingIds: candidate.duplicateOfListingIds,
      duplicateDecision: null, duplicateReason: null, duplicateDecidedByUserId: null, duplicateDecidedAt: null,
      status: candidate.status, reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date(),
    }).where(eq(catalogImportRow.id, rowId));
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_CORRECTED", targetType: "catalog_import_row", targetId: rowId, metadata: { result: candidate.status } });
    await refreshBatchStatus(tx, batchId, importBatch.appliedAt);
    return { rowId, status: candidate.status };
  });
}

export async function decideStagedDuplicate(headers: Headers, batchId: string, rowId: string, decision: "KEEP_SEPARATE" | "REJECT", reason: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || !/^[0-9a-f-]{36}$/i.test(rowId) || !reason.trim() || reason.length > 1_000) throw new Error("Duplicate decision invalid");
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const batch = await lockImport(tx, batchId);
    const [row] = await tx.select().from(catalogImportRow).where(and(eq(catalogImportRow.id, rowId), eq(catalogImportRow.batchId, batchId))).for("update").limit(1);
    if (!row || row.status !== "DUPLICATE_REVIEW") throw new Error("Duplicate review unavailable");
    const resolved = resolveDuplicate(rowCandidate({ ...row, values: row.stagedValues }), {
      decision, staffUserId: userId, reason: reason.trim(), decidedAt: new Date().toISOString(),
    });
    await tx.update(catalogImportRow).set({
      status: resolved.status, duplicateDecision: decision, duplicateReason: reason.trim(), duplicateDecidedByUserId: userId,
      duplicateDecidedAt: new Date(), reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date(),
    }).where(eq(catalogImportRow.id, rowId));
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_DUPLICATE_DECIDED", targetType: "catalog_import_row", targetId: rowId,
      reasonCode: decision === "KEEP_SEPARATE" ? "DUPLICATE_KEEP_SEPARATE" : "DUPLICATE_REJECTED", metadata: { result: resolved.status } });
    await refreshBatchStatus(tx, batchId, batch.appliedAt);
    return { rowId, status: resolved.status };
  });
}

export async function rejectStagedImportRow(headers: Headers, batchId: string, rowId: string, reason: string) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || !/^[0-9a-f-]{36}$/i.test(rowId) || !["INVALID_SOURCE_DATA", "NO_LONGER_OFFERED", "OTHER"].includes(reason)) throw new Error("Reject reason required");
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const batch = await lockImport(tx, batchId);
    const [row] = await tx.select().from(catalogImportRow).where(and(eq(catalogImportRow.id, rowId), eq(catalogImportRow.batchId, batchId))).for("update").limit(1);
    if (!row || row.status === "APPLIED" || row.status === "REJECTED") throw new Error("Import row cannot be rejected");
    const isDuplicate = row.status === "DUPLICATE_REVIEW";
    await tx.update(catalogImportRow).set({ status: "REJECTED", reviewedByUserId: userId, reviewedAt: new Date(), updatedAt: new Date(),
      ...(isDuplicate ? { duplicateDecision: "REJECT", duplicateReason: reason.trim(), duplicateDecidedByUserId: userId, duplicateDecidedAt: new Date() } : {})
    }).where(eq(catalogImportRow.id, rowId));
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_REJECTED", targetType: "catalog_import_row", targetId: rowId,
      reasonCode: reason });
    await refreshBatchStatus(tx, batchId, batch.appliedAt);
    return { rowId, status: "REJECTED" as const };
  });
}

export async function applySelectedImportRows(headers: Headers, batchId: string, selections: Array<{ rowId: string; retailPriceUsd: string }>) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || !Array.isArray(selections) || selections.length < 1 || selections.length > 50 ||
    selections.some((selection) => !/^[0-9a-f-]{36}$/i.test(selection.rowId)) || new Set(selections.map((selection) => selection.rowId)).size !== selections.length) {
    throw new Error("Import selection invalid");
  }
  const prices = new Map(selections.map((selection) => {
    try { return [selection.rowId, parseUsdMinorUnits(selection.retailPriceUsd)] as const; }
    catch { return [selection.rowId, null] as const; }
  }));
  return staffTransaction(headers, "supplier.manage", async (tx, userId) => {
    const batch = await lockImport(tx, batchId);
    if (batch.status === "APPLIED" || batch.status === "REJECTED") throw new Error("Import is closed");
    const rows = await tx.select().from(catalogImportRow).where(and(eq(catalogImportRow.batchId, batchId), inArray(catalogImportRow.id, selections.map((selection) => selection.rowId))))
      .orderBy(asc(catalogImportRow.rowNumber)).for("update");
    if (rows.length !== selections.length) throw new Error("Selected row unavailable");
    const domains = [...new Set(rows.filter((row) => row.status === "READY").map((row) => {
      const value = (row.stagedValues as Record<string, unknown>).websiteUrl;
      return typeof value === "string" ? normalizeWebsiteUrl(value) : null;
    }).filter((url): url is string => url !== null).map((url) => new URL(url).hostname))].sort();
    for (const domain of domains) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${domain}, 0))`);
    const urls = await tx.select({ id: listingUrl.listingId, websiteUrl: listingUrl.websiteUrl }).from(listingUrl);
    const applied: string[] = [];
    const appliedRows = new Map<number, string>();
    for (const row of rows) {
      if (row.status !== "READY") {
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id,
          reasonCode: `ROW_${row.status}` });
        continue;
      }
      const candidate = rowCandidate({ ...row, values: row.stagedValues });
      if ((candidate.duplicateOfRow !== null || candidate.duplicateOfListingIds.length > 0) && row.duplicateDecision !== "KEEP_SEPARATE") {
        await tx.update(catalogImportRow).set({ status: "DUPLICATE_REVIEW", updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "DUPLICATE_REVIEW_REQUIRED" });
        continue;
      }
      let listingInput: ReturnType<typeof toDraftListingInput>;
      try { listingInput = toDraftListingInput(candidate); }
      catch {
        await tx.update(catalogImportRow).set({ status: "INVALID", errors: [{ field: "listing", code: "DRAFT_VALIDATION_FAILED" }], updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "DRAFT_VALIDATION_FAILED" });
        continue;
      }
      const price = prices.get(row.id);
      if (price === null || price === undefined) {
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "RETAIL_PRICE_REQUIRED" });
        continue;
      }
      const expectedDuplicates = new Set(candidate.duplicateOfListingIds);
      const normalizedUrl = normalizeWebsiteUrl(listingInput.websiteUrl);
      if (!normalizedUrl) {
        await tx.update(catalogImportRow).set({ status: "INVALID", errors: [{ field: "websiteUrl", code: "INVALID_HTTPS_ORIGIN" }], updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "INVALID_WEBSITE_URL" });
        continue;
      }
      const currentDomain = new URL(normalizedUrl).hostname.toLowerCase();
      const reviewedSameBatchDuplicate = row.duplicateDecision === "KEEP_SEPARATE" && candidate.duplicateOfRow !== null
        ? appliedRows.get(candidate.duplicateOfRow) : undefined;
      const newDuplicates = urls.filter((entry) => new URL(entry.websiteUrl).hostname.toLowerCase() === currentDomain &&
        !expectedDuplicates.has(entry.id) && entry.id !== reviewedSameBatchDuplicate);
      if (newDuplicates.length) {
        const duplicateIds = [...new Set([...candidate.duplicateOfListingIds, ...newDuplicates.map((entry) => entry.id)])];
        await tx.update(catalogImportRow).set({ status: "DUPLICATE_REVIEW", duplicateOfListingIds: duplicateIds,
          warnings: [...new Set([...candidate.warnings, "POSSIBLE_DUPLICATE_DOMAIN"])], duplicateDecision: null, duplicateReason: null,
          duplicateDecidedByUserId: null, duplicateDecidedAt: null, updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "NEW_DUPLICATE_FOUND" });
        continue;
      }
      const terms = { ...listingInput, websiteUrl: normalizedUrl, retailPriceCents: Number(price) } as ListingTerms;
      if (validateListingTerms(terms).length || validateListingRelationships("SUPPLIER_SOURCED", batch.supplierId, batch.supplierId).length) {
        await tx.update(catalogImportRow).set({ status: "INVALID", errors: [{ field: "listing", code: "DRAFT_VALIDATION_FAILED" }], updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
        await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLY_SKIPPED", targetType: "catalog_import_row", targetId: row.id, reasonCode: "DRAFT_VALIDATION_FAILED" });
        continue;
      }
      const created = await insertDraftListingInTransaction(tx, userId, {
        terms, commercialSource: "SUPPLIER_SOURCED", supplierId: batch.supplierId, fulfillmentSupplierId: batch.supplierId, urlVisibleWithoutRecharge: false,
      });
      urls.push({ id: created.id, websiteUrl: terms.websiteUrl });
      await tx.update(catalogImportRow).set({ status: "APPLIED", appliedListingId: created.id, reviewedByUserId: userId,
        reviewedAt: new Date(), updatedAt: new Date() }).where(eq(catalogImportRow.id, row.id));
      appliedRows.set(row.rowNumber, created.id);
      applied.push(created.id);
      await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_ROW_APPLIED", targetType: "catalog_import_row", targetId: row.id,
        metadata: { result: "DRAFT_CREATED", version: 1 } });
    }
    await tx.insert(catalogImportApplyEvent).values({ id: randomUUID(), batchId, actorUserId: userId,
      selectedRowIds: selections.map((selection) => selection.rowId), appliedListingIds: applied });
    const status = await refreshBatchStatus(tx, batchId, batch.appliedAt);
    await appendAuditEvent(tx, { actorUserId: userId, action: "CATALOG_IMPORT_BATCH_APPLY_FINISHED", targetType: "catalog_import_batch", targetId: batchId,
      metadata: { itemCount: selections.length, result: `${applied.length}_DRAFTS_CREATED` } });
    return { appliedCount: applied.length, batchStatus: status };
  });
}
