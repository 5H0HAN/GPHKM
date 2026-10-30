"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { correctStagedImportRow, decideStagedDuplicate, rejectStagedImportRow, applySelectedImportRows } from "@/server/catalog/imports";

function safeId(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}

function target(batchId: string, result: string, page: string) {
  const parsedPage = /^\d{1,2}$/.test(page) && Number(page) > 0 ? Number(page) : 0;
  return `/staff/suppliers/imports/${encodeURIComponent(batchId)}?page=${parsedPage}&${result}`;
}

export async function correctImportRowAction(form: FormData) {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const page = safeId(form.get("page"));
  const corrections: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (key.startsWith("field_") && typeof value === "string") corrections[key.slice(6)] = value;
  try { await correctStagedImportRow(await headers(), batchId, rowId, corrections); }
  catch { redirect(target(batchId, "error=correct", page)); }
  redirect(target(batchId, "corrected=1", page));
}

export async function decideDuplicateAction(form: FormData) {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const page = safeId(form.get("page"));
  const decision = form.get("decision");
  const reason = safeId(form.get("reason"));
  if (decision !== "KEEP_SEPARATE" && decision !== "REJECT") redirect(target(batchId, "error=decision", page));
  try { await decideStagedDuplicate(await headers(), batchId, rowId, decision, reason); }
  catch { redirect(target(batchId, "error=decision", page)); }
  redirect(target(batchId, "decision=1", page));
}

export async function rejectImportRowAction(form: FormData) {
  const batchId = safeId(form.get("batchId"));
  const rowId = safeId(form.get("rowId"));
  const page = safeId(form.get("page"));
  const reason = safeId(form.get("reason"));
  try { await rejectStagedImportRow(await headers(), batchId, rowId, reason); }
  catch { redirect(target(batchId, "error=reject", page)); }
  redirect(target(batchId, "rejected=1", page));
}

export async function applySelectedImportAction(form: FormData) {
  const batchId = safeId(form.get("batchId"));
  const page = safeId(form.get("page"));
  const rowIds = form.getAll("rowId").filter((value): value is string => typeof value === "string");
  const selections = rowIds.map((rowId) => ({ rowId, retailPriceUsd: safeId(form.get(`price_${rowId}`)) }));
  let result: { appliedCount: number };
  try { result = await applySelectedImportRows(await headers(), batchId, selections); }
  catch { redirect(target(batchId, "error=apply", page)); }
  redirect(target(batchId, `applied=${result.appliedCount}`, page));
}
