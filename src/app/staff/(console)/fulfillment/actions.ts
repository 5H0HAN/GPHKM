"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { assignFulfillmentItem, recordPublicationEvidence, saveWritingDraft, updateFulfillmentFollowUp, updateFulfillmentState } from "@/server/fulfillment/admin";
import { recoverSupplierFailure, recordSupplierFailure } from "@/server/fulfillment/supplier-outcomes";
import { createEquivalentOffer } from "@/server/fulfillment/equivalent-offers";
import { fulfillmentItemRedirectTarget, fulfillmentQueueRedirectTarget, isFulfillmentItemId } from "./navigation";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function assignFulfillmentAction(form: FormData): Promise<{ redirectTo: string }> {
  const itemId = field(form, "itemId");
  const assignedAdminId = field(form, "assignedAdminId") || null;
  try { await assignFulfillmentItem(await headers(), itemId, assignedAdminId); }
  catch { return { redirectTo: fulfillmentQueueRedirectTarget(field(form, "page"), field(form, "view"), "assignment-failed") }; }
  return { redirectTo: fulfillmentQueueRedirectTarget(field(form, "page"), field(form, "view"), "updated") };
}

export async function updateFulfillmentAction(form: FormData): Promise<{ redirectTo: string }> {
  const itemId = field(form, "itemId");
  if (!isFulfillmentItemId(itemId)) return { redirectTo: "/staff/fulfillment?invalid-item=1" };
  const to = field(form, "to");
  try {
    await updateFulfillmentState(await headers(), {
      itemId,
      to,
      holdReasonCode: to === "ON_HOLD" ? field(form, "holdReasonCode") : undefined,
      nextUpdateAt: field(form, "nextUpdateAt"),
    });
  } catch (error) {
    if (error instanceof Error && ["Choose a next-update date", "Next-update time must be in the next year"].includes(error.message)) {
      return { redirectTo: fulfillmentItemRedirectTarget(itemId, "next-update-date") };
    }
    if (error instanceof Error && error.message === "Choose a valid reason for pausing this placement") {
      return { redirectTo: fulfillmentItemRedirectTarget(itemId, "hold-reason") };
    }
    if (error instanceof Error && error.message === "Prepare the supplier packet before entering handoff preparation") {
      return { redirectTo: fulfillmentItemRedirectTarget(itemId, "packet-required") };
    }
    if (error instanceof Error && error.message === "Confirm provider delivery or record the actual manual send before starting placement work") {
      return { redirectTo: fulfillmentItemRedirectTarget(itemId, "delivery-required") };
    }
    return { redirectTo: fulfillmentItemRedirectTarget(itemId, "update-failed") };
  }
  return { redirectTo: fulfillmentItemRedirectTarget(itemId, "updated") };
}

export async function updateFulfillmentFollowUpAction(form: FormData): Promise<{ redirectTo: string }> {
  const itemId = field(form, "itemId");
  if (!isFulfillmentItemId(itemId)) return { redirectTo: "/staff/fulfillment?invalid-item=1" };
  try {
    await updateFulfillmentFollowUp(await headers(), {
      itemId, nextUpdateAt: field(form, "nextUpdateAt"), reasonCode: field(form, "reasonCode"),
    });
  } catch (error) {
    if (error instanceof Error && ["Choose a next-update date", "Next-update time must be in the next year"].includes(error.message)) {
      return { redirectTo: fulfillmentItemRedirectTarget(itemId, "next-update-date") };
    }
    return { redirectTo: fulfillmentItemRedirectTarget(itemId, "follow-up-failed") };
  }
  return { redirectTo: fulfillmentItemRedirectTarget(itemId, "follow-up-updated") };
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

export async function recoverSupplierFailureAction(form: FormData) {
  const itemId = field(form, "itemId");
  try {
    await recoverSupplierFailure(await headers(), { itemId, reason: field(form, "reason"), idempotencyKey: field(form, "idempotencyKey") });
  } catch { redirect(`/staff/fulfillment/${itemId}?error=supplier-recovery-failed`); }
  redirect(`/staff/fulfillment/${itemId}?supplierRecovered=1`);
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
