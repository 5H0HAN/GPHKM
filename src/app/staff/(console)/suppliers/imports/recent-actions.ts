"use server";

import { headers } from "next/headers";
import { discardStagedImportBatch } from "@/server/catalog/import-discard";
import type { ImportActionState } from "./action-state";

function formString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

function destination(path: string) {
  return process.env.STAFF_APP_URL ? new URL(path, process.env.STAFF_APP_URL).toString() : path;
}

export async function discardRecentImportBatchAction(_previousState: ImportActionState, form: FormData): Promise<ImportActionState> {
  const batchId = formString(form.get("batchId"));
  const reason = formString(form.get("reason"));
  if (formString(form.get("confirmation")) !== "DISCARD") {
    return { redirectTo: destination("/staff/suppliers/imports?error=discard-failed") };
  }

  try {
    await discardStagedImportBatch(await headers(), batchId, reason);
  } catch {
    return { redirectTo: destination("/staff/suppliers/imports?error=discard-failed") };
  }

  return { redirectTo: destination("/staff/suppliers/imports?error=discarded") };
}
