"use server";

import { headers } from "next/headers";
import { applyAllRemainingImportRows, applySelectedImportRows, applyStagedImportUpdate, correctStagedImportRow, decideStagedDuplicate, rejectStagedImportRow, stageInventoryImport } from "@/server/catalog/imports";
import { discardStagedImportBatch } from "@/server/catalog/import-discard";
import type { ImportActionState } from "../action-state";

function safeId(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function target(batchId: string, result: string, page: string, status = "") {
  const parsedPage = /^\d{1,2}$/.test(page) && Number(page) > 0 ? Number(page) : 0;
  const query = new URLSearchParams();
  if (parsedPage > 0) query.set("page", String(parsedPage));
  if (["READY", "NEEDS_REVIEW", "DUPLICATE_REVIEW", "INVALID", "APPLIED", "REJECTED"].includes(status)) query.set("status", status);
  for (const [key, value] of new URLSearchParams(result)) query.set(key, value);
  const path = `/staff/suppliers/imports/${encodeURIComponent(batchId)}${query.size ? `?${query}` : ""}`;
  return process.env.STAFF_APP_URL ? new URL(path, process.env.STAFF_APP_URL).toString() : path;
}

function destination(path: string) {
  return process.env.STAFF_APP_URL ? new URL(path, process.env.STAFF_APP_URL).toString() : path;
}

function redirectResult(path: string): ImportActionState {
  return { redirectTo: destination(path) };
}

type CorrectedRow = Awaited<ReturnType<typeof correctStagedImportRow>>;
type ApplyRowsResult = Awaited<ReturnType<typeof applySelectedImportRows>>;
type CorrectImportRowState = { kind: "saved"; row: CorrectedRow }
  | { kind: "error"; rowId: string; row?: CorrectedRow } | null;
type ApplySingleImportRowState = { kind: "applied"; listing: ApplyRowsResult["appliedListings"][number] }
  | { kind: "skipped"; row: ApplyRowsResult["skippedRows"][number] } | { kind: "error"; message: string } | null;

export async function correctImportRowAction(previousState: CorrectImportRowState, form: FormData): Promise<CorrectImportRowState> {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const corrections: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (key.startsWith("field_") && typeof value === "string") corrections[key.slice(6)] = value;
  const selectedCategories = form.getAll("platformCategory").filter((value): value is string => typeof value === "string");
  const retailPriceUsd = safeId(form.get("proposedRetailPriceUsd"));
  try { return { kind: "saved", row: await correctStagedImportRow(await headers(), batchId, rowId, corrections,
    selectedCategories, retailPriceUsd) }; }
  catch { return { kind: "error", rowId, row: previousState?.kind === "saved" ? previousState.row : undefined }; }
}

export async function applySingleImportRowAction(_previousState: ApplySingleImportRowState, form: FormData): Promise<ApplySingleImportRowState> {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  try {
    const result = await applySelectedImportRows(await headers(), batchId, [{ rowId }]);
    const listing = result.appliedListings.find((item) => item.rowId === rowId);
    if (listing) return { kind: "applied", listing };
    const row = result.skippedRows.find((item) => item.rowId === rowId);
    return row ? { kind: "skipped", row } : { kind: "error", message: "This row could not be created. Review it and try again." };
  } catch (error) {
    return { kind: "error", message: error instanceof Error && error.message === "IMPORT_RETAIL_PRICE_REQUIRED"
      ? "Save a valid USD retail price with the row corrections before creating this draft."
      : "This row could not be created. Review its status and try again." };
  }
}

export async function decideDuplicateAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const page = safeId(form.get("page"));
  const status = safeId(form.get("status"));
  const decision = form.get("decision");
  const reason = safeId(form.get("reason"));
  if (decision !== "KEEP_SEPARATE" && decision !== "REJECT") return redirectResult(target(batchId, "error=decision", page, status));
  try { await decideStagedDuplicate(await headers(), batchId, rowId, decision, reason); }
  catch { return redirectResult(target(batchId, "error=decision", page, status)); }
  return redirectResult(target(batchId, "decision=1", page, status));
}

export async function rejectImportRowAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const page = safeId(form.get("page"));
  const status = safeId(form.get("status"));
  const reason = safeId(form.get("reason"));
  try { await rejectStagedImportRow(await headers(), batchId, rowId, reason); }
  catch { return redirectResult(target(batchId, "error=reject", page, status)); }
  return redirectResult(target(batchId, "rejected=1", page, status));
}

export async function applySelectedImportAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  const page = safeId(form.get("page"));
  const status = safeId(form.get("status"));
  const rowIds = form.getAll("rowId").filter((value): value is string => typeof value === "string");
  const selections = rowIds.map((rowId) => ({ rowId }));
  let result: { appliedCount: number };
  try { result = await applySelectedImportRows(await headers(), batchId, selections); }
  catch (error) { return redirectResult(target(batchId, error instanceof Error && error.message === "IMPORT_RETAIL_PRICE_REQUIRED" ? "error=price" : "error=apply", page, status)); }
  return redirectResult(target(batchId, `applied=${result.appliedCount}`, page, status));
}

export async function applyAllImportRowsAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  try {
    const result = await applyAllRemainingImportRows(await headers(), batchId);
    return redirectResult(target(batchId, `allApplied=${result.appliedCount}${result.stoppedEarly ? "&partial=1" : ""}`, "", ""));
  } catch (error) {
    const code = error instanceof Error && error.message === "IMPORT_BATCH_ROWS_REQUIRE_REVIEW" ? "all-review"
      : error instanceof Error && error.message === "IMPORT_RETAIL_PRICE_REQUIRED" ? "all-price" : "all-apply";
    return redirectResult(target(batchId, `error=${code}`, "", ""));
  }
}

export async function updateImportMatchAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const listingId = safeId(form.get("listingId"));
  const page = safeId(form.get("page"));
  const status = safeId(form.get("status"));
  const reason = safeId(form.get("reason"));
  try { await applyStagedImportUpdate(await headers(), batchId, rowId, listingId, reason); }
  catch { return redirectResult(target(batchId, "error=update", page, status)); }
  return redirectResult(target(batchId, "updated=1", page, status));
}

export async function discardImportBatchAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = safeId(form.get("batchId"));
  const reason = safeId(form.get("reason"));
  const confirmation = safeId(form.get("confirmation"));
  if (confirmation !== "DISCARD") return redirectResult(`/staff/suppliers/imports/${encodeURIComponent(batchId)}?error=discard`);
  try {
    await discardStagedImportBatch(await headers(), batchId, reason);
  } catch {
    return redirectResult(`/staff/suppliers/imports/${encodeURIComponent(batchId)}?error=discard`);
  }
  return redirectResult("/staff/suppliers/imports?error=discarded");
}

export async function refreshGoogleSheetAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const supplierId = safeId(form.get("supplierId"));
  const sourceReference = safeId(form.get("sourceReference"));
  const match = /^([A-Za-z0-9_-]{20,128}):(\d{1,12})$/.exec(sourceReference);
  if (!/^[0-9a-f-]{36}$/i.test(supplierId) || !match) return redirectResult("/staff/suppliers/imports?error=source");
  let result: { batchId: string; rowCount: number };
  try {
    result = await stageInventoryImport(await headers(), {
      supplierId,
      sourceType: "GOOGLE_SHEETS",
      sheetReference: `https://docs.google.com/spreadsheets/d/${match[1]}/edit?gid=${match[2]}`,
      mappingMode: "AUTO",
      mapping: {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = message.includes("MAPPING") ? "mapping"
      : message === "SHEET_RESPONSE_TOO_LARGE" ? "sheet-size"
      : message === "SHEET_ACCESS_DENIED" ? "sheet-access"
      : message === "SHEET_EXPORT_UNAVAILABLE" ? "sheet-export" : "sheet-fetch";
    return redirectResult(`/staff/suppliers/imports?error=${code}`);
  }
  return redirectResult(`/staff/suppliers/imports/${result.batchId}?staged=${result.rowCount}`);
}
