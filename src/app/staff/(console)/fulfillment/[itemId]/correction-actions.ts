"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { openPublicationCorrection } from "@/server/fulfillment/publication-corrections";

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

export async function openPublicationCorrectionAction(form: FormData) {
  const itemId = field(form, "itemId");
  try {
    await openPublicationCorrection(await headers(), {
      itemId, reason: field(form, "reason"), nextUpdateAt: field(form, "nextUpdateAt"),
      idempotencyKey: field(form, "idempotencyKey"),
    });
  } catch {
    redirect(`/staff/fulfillment/${encodeURIComponent(itemId)}?error=publication-correction-failed`);
  }
  redirect(`/staff/fulfillment/${encodeURIComponent(itemId)}?correctionOpened=1`);
}
