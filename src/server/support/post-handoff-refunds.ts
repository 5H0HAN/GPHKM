import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { postHandoffRefundRequest } from "@/db/post-handoff-refund-schema";
import type { DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { validatePostHandoffRefundDecision, validatePostHandoffRefundRequest } from "@/modules/support/post-handoff-refunds";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function staffTx<T>(headers: Headers, permission: "audit.read" | "fulfillment.manage" | "refund.exception.approve", work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, permission);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export async function requestPostHandoffRefund(headers: Headers, input: {
  caseId: string; idempotencyKey: string; amountMinor: string; reason: string;
}) {
  const request = validatePostHandoffRefundRequest(input);
  return staffTx(headers, "fulfillment.manage", async (tx, actor) => {
    if (actor.role !== "ADMIN" && actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const requestId = randomUUID();
    const requestHash = digest(request);
    const result = await tx.execute(sql`select * from public.gphkm_request_post_handoff_refund(
      ${requestId}, ${request.caseId}, ${request.idempotencyKey}, ${requestHash}, ${request.amountMinor}, ${request.reason}
    )`);
    const row = (result as unknown as { rows?: Array<{ request_id: string; state: string; requested_amount_minor: string; organization_id: string; order_item_id: string; applied: boolean }> }).rows?.[0];
    if (!row) throw new Error("Refund request requires reconciliation");
    return { requestId: row.request_id, state: row.state, requestedAmountMinor: row.requested_amount_minor };
  });
}

export async function decidePostHandoffRefund(headers: Headers, input: {
  requestId: string; decision: string; amountMinor: string; idempotencyKey: string; reason: string;
}) {
  const decision = validatePostHandoffRefundDecision(input);
  return staffTx(headers, "refund.exception.approve", async (tx) => {
    const decisionHash = digest(decision);
    const result = await tx.execute(sql`select * from public.gphkm_decide_post_handoff_refund(
      ${decision.requestId}, ${decision.decision}, ${decision.amountMinor}, ${decision.reason}, ${decision.idempotencyKey}, ${decisionHash}
    )`);
    const row = (result as unknown as { rows?: Array<{ request_id: string; outcome: string; amount_minor: string; ledger_id: string | null; organization_id: string; case_id: string; order_item_id: string; applied: boolean }> }).rows?.[0];
    if (!row) throw new Error("Refund decision requires reconciliation");
    return { requestId: row.request_id, decision: row.outcome, refundMinor: row.amount_minor, ledgerEntryId: row.ledger_id };
  });
}

export async function listPostHandoffRefundsForCase(headers: Headers, caseId: string) {
  if (!UUID.test(caseId)) throw new Error("Support case unavailable");
  return staffTx(headers, "audit.read", async (tx) => tx.select({
    id: postHandoffRefundRequest.id,
    requestNumber: postHandoffRefundRequest.requestNumber,
    state: postHandoffRefundRequest.state,
    requestedAmountMinor: postHandoffRefundRequest.requestedAmountMinor,
    requestReason: postHandoffRefundRequest.requestReason,
    requestedAt: postHandoffRefundRequest.requestedAt,
    decisionReason: postHandoffRefundRequest.decisionReason,
    refundMinor: postHandoffRefundRequest.refundMinor,
    decidedAt: postHandoffRefundRequest.decidedAt,
  }).from(postHandoffRefundRequest).where(eq(postHandoffRefundRequest.caseId, caseId))
    .orderBy(desc(postHandoffRefundRequest.requestNumber)).limit(10));
}

export async function listPendingPostHandoffRefunds(headers: Headers) {
  return staffTx(headers, "refund.exception.approve", async (tx) => tx.select({
    id: postHandoffRefundRequest.id,
    caseId: postHandoffRefundRequest.caseId,
    orderId: postHandoffRefundRequest.orderId,
    orderItemId: postHandoffRefundRequest.orderItemId,
    organizationId: postHandoffRefundRequest.organizationId,
    requestNumber: postHandoffRefundRequest.requestNumber,
    requestedAmountMinor: postHandoffRefundRequest.requestedAmountMinor,
    requestReason: postHandoffRefundRequest.requestReason,
    requestedAt: postHandoffRefundRequest.requestedAt,
  }).from(postHandoffRefundRequest).where(eq(postHandoffRefundRequest.state, "REQUESTED"))
    .orderBy(postHandoffRefundRequest.requestedAt).limit(100));
}
