import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItemCancellationRequest } from "@/db/cancellation-schema";
import { customerOrder, customerOrderItem } from "@/db/order-schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identity(value: string) { if (!UUID.test(value)) throw new Error("Cancellation request is unavailable"); return value; }
function boundedText(value: string, max: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error("Invalid cancellation details");
  return normalized;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function staffTx<T>(headers: Headers, work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "refund.pre-handoff.approve");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export async function requestOrderItemCancellation(headers: Headers, organizationId: string, input: {
  itemId: string; idempotencyKey: string; reason: string;
}) {
  identity(input.itemId);
  identity(input.idempotencyKey);
  const reason = boundedText(input.reason, 2000);
  const actor = await requireVerifiedCustomer(headers);
  const requestHash = digest({ itemId: input.itemId, reason });
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const [item] = await tx.select({ orderId: customerOrder.id }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, input.itemId), eq(customerOrder.organizationId, organizationId), eq(customerOrder.checkoutState, "PAID"))).limit(1);
    if (!item) throw new Error("Order item unavailable");
    const id = randomUUID();
    const result = await tx.execute(sql`select public.gphkm_request_order_item_cancellation(
      ${input.itemId}, ${id}, ${input.idempotencyKey}, ${requestHash}, ${reason}
    ) as request_id`);
    const requestId = (result as unknown as { rows?: Array<{ request_id: string }> }).rows?.[0]?.request_id;
    if (!requestId) throw new Error("Cancellation request requires reconciliation");
    const [row] = await tx.select().from(orderItemCancellationRequest).where(eq(orderItemCancellationRequest.id, requestId)).limit(1);
    if (!row) throw new Error("Cancellation request unavailable");
    if (row.requestedByUserId === actor.userId && row.state === "REQUESTED" && row.id === id) {
      await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "ORDER_ITEM_CANCELLATION_REQUESTED",
        targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId, metadata: { result: "REQUESTED" } });
    }
    return { requestId, state: row.state };
  });
}

export async function getCustomerOrderItemCancellations(headers: Headers, organizationId: string, itemId: string) {
  identity(itemId);
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const rows = await tx.select({ id: orderItemCancellationRequest.id, state: orderItemCancellationRequest.state,
      reason: orderItemCancellationRequest.reason, decisionReason: orderItemCancellationRequest.decisionReason,
      refundMinor: orderItemCancellationRequest.refundMinor, requestedAt: orderItemCancellationRequest.requestedAt,
      decidedAt: orderItemCancellationRequest.decidedAt })
      .from(orderItemCancellationRequest).where(and(eq(orderItemCancellationRequest.orderItemId, itemId), eq(orderItemCancellationRequest.organizationId, organizationId)))
      .orderBy(desc(orderItemCancellationRequest.requestedAt)).limit(20);
    const access = await tx.execute(sql`select public.gphkm_customer_can_request_item_cancellation(
      ${itemId}, ${actor.userId}, ${organizationId}
    ) as can_request`);
    const canRequest = (access as unknown as { rows?: Array<{ can_request: boolean }> }).rows?.[0]?.can_request === true;
    return { history: rows.reverse(), canRequest };
  });
}

export async function listPreHandoffCancellationRequests(headers: Headers, requestedPage?: unknown) {
  return staffTx(headers, async (tx) => {
    const scope = eq(orderItemCancellationRequest.state, "REQUESTED");
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(orderItemCancellationRequest).where(scope);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({
    id: orderItemCancellationRequest.id, organizationId: orderItemCancellationRequest.organizationId,
    orderId: orderItemCancellationRequest.orderId, orderItemId: orderItemCancellationRequest.orderItemId,
    requestedByUserId: orderItemCancellationRequest.requestedByUserId, reason: orderItemCancellationRequest.reason,
    state: orderItemCancellationRequest.state, requestedAt: orderItemCancellationRequest.requestedAt,
    }).from(orderItemCancellationRequest).where(scope)
      .orderBy(orderItemCancellationRequest.requestedAt, orderItemCancellationRequest.id).limit(pagination.limit).offset(pagination.offset);
    return { ...pagination, rows };
  });
}

export async function decidePreHandoffCancellation(headers: Headers, input: {
  requestId: string; decision: "APPROVED" | "DENIED"; reason: string;
}) {
  identity(input.requestId);
  const reason = boundedText(input.reason, 1000);
  if (reason.length < 5) throw new Error("Add a brief decision reason");
  return staffTx(headers, async (tx, actor) => {
    const result = await tx.execute(sql`select * from public.gphkm_decide_order_item_cancellation(
      ${input.requestId}, ${input.decision}, ${reason}
    )`);
    const row = (result as unknown as { rows?: Array<{ request_id: string; outcome: string; amount_minor: string; ledger_id: string | null; organization_id: string; order_item_id: string; applied: boolean }> }).rows?.[0];
    if (!row) throw new Error("Cancellation decision requires reconciliation");
    if (row.applied) await appendAuditEvent(tx, { organizationId: row.organization_id, actorUserId: actor.userId,
      action: row.outcome === "APPROVED" ? "ORDER_ITEM_CANCELLATION_APPROVED" : "ORDER_ITEM_CANCELLATION_DENIED",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: row.order_item_id, reasonCode: "PRE_HANDOFF_CANCELLATION",
      metadata: { result: row.outcome, ...(row.outcome === "APPROVED" ? { amountMinor: row.amount_minor } : {}) } });
    return { requestId: row.request_id, state: row.outcome, refundMinor: row.amount_minor, ledgerEntryId: row.ledger_id };
  });
}
