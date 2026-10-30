"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assignFulfillmentItem, recordPublicationEvidence, saveWritingDraft, updateFulfillmentFollowUp, updateFulfillmentState } from "@/server/fulfillment/admin";
import { recordSupplierFailure } from "@/server/fulfillment/supplier-outcomes";
import { createEquivalentOffer } from "@/server/fulfillment/equivalent-offers";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function assignFulfillmentAction(form: FormData) {
  const itemId = field(form, "itemId");
  const assignedAdminId = field(form, "assignedAdminId") || null;
  try { await assignFulfillmentItem(await headers(), itemId, assignedAdminId); }
  catch { redirect("/staff/fulfillment?error=assignment-failed"); }
  redirect("/staff/fulfillment?updated=1");
}

export async function updateFulfillmentAction(form: FormData) {
  const itemId = field(form, "itemId");
  try {
    await updateFulfillmentState(await headers(), {
      itemId,
      to: field(form, "to"),
      reasonCode: field(form, "reasonCode"),
      nextUpdateAt: field(form, "nextUpdateAt"),
    });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=update-failed`); }
  redirect(`/staff/fulfillment/${itemId}?updated=1`);
}

export async function updateFulfillmentFollowUpAction(form: FormData) {
  const itemId = field(form, "itemId");
  try {
    await updateFulfillmentFollowUp(await headers(), {
      itemId, nextUpdateAt: field(form, "nextUpdateAt"), reasonCode: field(form, "reasonCode"),
    });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=follow-up-failed`); }
  redirect(`/staff/fulfillment/${itemId}?updated=1`);
}

export async function recordPublicationEvidenceAction(form: FormData) {
  const itemId = field(form, "itemId");
  try { await recordPublicationEvidence(await headers(), { itemId, liveUrl: field(form, "liveUrl") }); }
  catch { redirect(`/staff/fulfillment/${itemId}?error=evidence-failed`); }
  redirect(`/staff/fulfillment/${itemId}?verified=1`);
}

export async function saveWritingDraftAction(form: FormData) {
  const itemId = field(form, "itemId");
  const kind = field(form, "kind");
  try {
    if (kind !== "FIRST_DRAFT" && kind !== "FINAL_DRAFT") throw new Error("Invalid writing stage");
    await saveWritingDraft(await headers(), { itemId, kind, text: field(form, "draftText") });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=writing-draft-failed`); }
  redirect(`/staff/fulfillment/${itemId}?writing=1`);
}

export async function recordSupplierFailureAction(form: FormData) {
  const itemId = field(form, "itemId");
  const outcome = field(form, "outcome");
  try {
    if (outcome !== "REJECTED" && outcome !== "CANNOT_FULFILL" && outcome !== "NONRESPONSIVE") throw new Error("Invalid outcome");
    await recordSupplierFailure(await headers(), { itemId, outcome, reason: field(form, "reason"), idempotencyKey: field(form, "idempotencyKey") });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=supplier-outcome-failed`); }
  redirect(`/staff/fulfillment/${itemId}?supplierOutcome=1`);
}

export async function createEquivalentOfferAction(form: FormData) {
  const itemId = field(form, "itemId");
  try {
    await createEquivalentOffer(await headers(), {
      itemId, caseId: field(form, "caseId"), listingId: field(form, "listingId"),
      equivalenceNote: field(form, "equivalenceNote"),
    });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=equivalent-offer-failed`); }
  redirect(`/staff/fulfillment/${itemId}?equivalentOffered=1`);
}
