"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appendStaffSupportMessage, changeSupportState, recordSupportFinanceDecision } from "@/server/support/cases";
import { decidePostHandoffRefund, requestPostHandoffRefund } from "@/server/support/post-handoff-refunds";
import { parseUsdMinor } from "@/modules/supplier-finance/validation";
import { markStuckSupplierItemNoticeUnknown, prepareSupplierItemNotice, reconcileSupplierItemNotice, recordManualSupplierItemNotice, sendSupplierItemNotice } from "@/server/fulfillment/supplier-notices";

function field(form: FormData, key: string) { const value = form.get(key); return typeof value === "string" ? value : ""; }
export async function supportMessageAction(form: FormData) {
  const caseId = field(form, "caseId");
  const path = `/staff/support/${encodeURIComponent(caseId)}`;
  try { await appendStaffSupportMessage(await headers(), { caseId, audience: field(form, "audience"), body: field(form, "body"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path}?error=1`); }
  redirect(path);
}
export async function supportStateAction(form: FormData) {
  const caseId = field(form, "caseId");
  const path = `/staff/support/${encodeURIComponent(caseId)}`;
  try { await changeSupportState(await headers(), { caseId, expectedState: field(form, "expectedState"), to: field(form, "to"), reason: field(form, "reason"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path}?error=1`); }
  redirect(path);
}
export async function supportFinanceAction(form: FormData) {
  const caseId = field(form, "caseId");
  try { await recordSupportFinanceDecision(await headers(), { caseId, decision: field(form, "decision"), reason: field(form, "reason"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=1`); }
  redirect("/staff/support?reviewed=1");
}
export async function requestPostHandoffRefundAction(form: FormData) {
  const caseId = field(form, "caseId");
  const path = `/staff/support/${encodeURIComponent(caseId)}`;
  try {
    const amountMinor = parseUsdMinor(field(form, "amount"));
    if (!amountMinor) throw new Error("Invalid refund amount");
    await requestPostHandoffRefund(await headers(), {
      caseId, idempotencyKey: field(form, "idempotencyKey"), amountMinor, reason: field(form, "reason"),
    });
  } catch { redirect(`${path}?error=1`); }
  redirect(`${path}?refundRequested=1`);
}

export async function decidePostHandoffRefundAction(form: FormData) {
  const caseId = field(form, "caseId");
  const path = `/staff/support/${encodeURIComponent(caseId)}`;
  try {
    const decision = field(form, "decision");
    if (decision !== "APPROVED" && decision !== "DENIED") throw new Error("Invalid refund decision");
    const parsedAmount = decision === "APPROVED" ? parseUsdMinor(field(form, "amount")) : "0";
    if (!parsedAmount) throw new Error("Invalid refund amount");
    await decidePostHandoffRefund(await headers(), {
      requestId: field(form, "requestId"), decision, amountMinor: parsedAmount,
      idempotencyKey: field(form, "idempotencyKey"), reason: field(form, "reason"),
    });
  } catch { redirect(`${path}?error=1`); }
  redirect(`${path}?refundDecided=1`);
}

export async function prepareSupplierItemNoticeAction(form: FormData) {
  const caseId = field(form, "caseId");
  let noticeId = "";
  try {
    const type = field(form, "type");
    if (type !== "WITHDRAWAL" && type !== "CORRECTION") throw new Error("Invalid notice type");
    const result = await prepareSupplierItemNotice(await headers(), { caseId, type, reason: field(form, "reason") });
    noticeId = result.noticeId;
  } catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=notice`); }
  redirect(`/staff/support/${encodeURIComponent(caseId)}?noticePrepared=${encodeURIComponent(noticeId)}`);
}

export async function sendSupplierItemNoticeAction(form: FormData) {
  const caseId = field(form, "caseId");
  try { await sendSupplierItemNotice(await headers(), field(form, "noticeId")); }
  catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=notice`); }
  redirect(`/staff/support/${encodeURIComponent(caseId)}?noticeSent=1`);
}

export async function reconcileSupplierItemNoticeAction(form: FormData) {
  const caseId = field(form, "caseId");
  try {
    const outcome = field(form, "outcome");
    if (!["ACCEPTED", "RECONCILED_FAILED", "SUPPLIER_STOP_CONFIRMED", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(outcome)) throw new Error("Invalid notice outcome");
    await reconcileSupplierItemNotice(await headers(), { attemptId: field(form, "attemptId"), outcome: outcome as "ACCEPTED" | "RECONCILED_FAILED" | "SUPPLIER_STOP_CONFIRMED" | "SUPPLIER_CONTINUING" | "UNABLE_TO_CONFIRM", reason: field(form, "reason"), reference: field(form, "reference") });
  } catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=notice`); }
  redirect(`/staff/support/${encodeURIComponent(caseId)}?noticeReconciled=1`);
}

export async function markStuckSupplierItemNoticeUnknownAction(form: FormData) {
  const caseId = field(form, "caseId");
  try { await markStuckSupplierItemNoticeUnknown(await headers(), { attemptId: field(form, "attemptId"), reason: field(form, "reason") }); }
  catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=notice`); }
  redirect(`/staff/support/${encodeURIComponent(caseId)}?noticeReconciled=1`);
}

export async function recordManualSupplierItemNoticeAction(form: FormData) {
  const caseId = field(form, "caseId");
  try {
    await recordManualSupplierItemNotice(await headers(), { noticeId: field(form, "noticeId"), recipient: field(form, "recipient"), sentAt: field(form, "sentAt"), messageReference: field(form, "messageReference") });
  } catch { redirect(`/staff/support/${encodeURIComponent(caseId)}?error=notice`); }
  redirect(`/staff/support/${encodeURIComponent(caseId)}?noticeSent=manual`);
}
