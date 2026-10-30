import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier } from "@/db/order-schema";
import { supportCase, supportCaseEvent } from "@/db/support-schema";
import { supplierFulfillmentOutcome } from "@/db/supplier-outcome-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { mayReadFulfillmentContent } from "@/modules/fulfillment/console";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Outcome = "REJECTED" | "CANNOT_FULFILL" | "NONRESPONSIVE";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function recordSupplierFailure(headers: Headers, input: {
  itemId: string; outcome: Outcome; reason: string; idempotencyKey: string;
}) {
  if (![input.itemId, input.idempotencyKey].every((value) => UUID.test(value)) ||
      !["REJECTED", "CANNOT_FULFILL", "NONRESPONSIVE"].includes(input.outcome)) throw new Error("Supplier outcome is unavailable");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) throw new Error("Add a valid internal outcome reason");
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role === "FINANCE") throw new Error("Forbidden");
  const requestHash = hash({ itemId: input.itemId, outcome: input.outcome, reason });

  return db.transaction(async (tx: Tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    // Item-first locking serializes this command with cancellation and handoff.
    // Never lock a packet row here: packet delivery locks packet before item.
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId }) ||
        ["COMPLETED", "CANCELED_REFUNDED"].includes(fulfillment.state)) throw new Error("Order item unavailable");

    const [prior] = await tx.select({ id: supplierFulfillmentOutcome.id, supportCaseId: supplierFulfillmentOutcome.supportCaseId,
      requestHash: supplierFulfillmentOutcome.requestHash })
      .from(supplierFulfillmentOutcome).where(and(eq(supplierFulfillmentOutcome.orderItemId, input.itemId),
        eq(supplierFulfillmentOutcome.actorUserId, actor.userId), eq(supplierFulfillmentOutcome.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Supplier outcome idempotency conflict");
      return { outcomeId: prior.id, supportCaseId: prior.supportCaseId, replayed: true };
    }

    const [order] = await tx.select({ id: customerOrder.id, organizationId: customerOrder.organizationId,
      ordererId: customerOrder.actorUserId, paid: customerOrder.checkoutState })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(eq(customerOrderItem.id, input.itemId)).limit(1);
    const [supplierRow] = await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId })
      .from(orderItemFulfillmentSupplier).where(eq(orderItemFulfillmentSupplier.orderItemId, input.itemId)).limit(1);
    if (!order || order.paid !== "PAID" || !supplierRow?.supplierId) throw new Error("Supplier outcome is unavailable for this item");

    const now = new Date();
    const outcomeId = randomUUID();
    const caseId = randomUUID();
    const safeSummary = "GPHKM is reviewing an update to this placement.";
    const caseHash = hash({ source: "SUPPLIER_FULFILLMENT_OUTCOME", outcomeId });
    await tx.insert(supportCase).values({
      id: caseId, organizationId: order.organizationId, orderId: order.id, orderItemId: input.itemId,
      openedByUserId: order.ordererId, summary: safeSummary, state: "OPEN", idempotencyKey: outcomeId,
      requestHash: caseHash, createdAt: now, updatedAt: now,
    });
    await tx.insert(supplierFulfillmentOutcome).values({
      id: outcomeId, orderItemId: input.itemId, supplierId: supplierRow.supplierId, supportCaseId: caseId,
      actorUserId: actor.userId, outcome: input.outcome, reason, idempotencyKey: input.idempotencyKey,
      requestHash, createdAt: now,
    });
    await tx.insert(supportCaseEvent).values([
      { id: randomUUID(), caseId, actorUserId: actor.userId, actorKind: "STAFF", kind: "OPENED", audience: "INTERNAL",
        body: safeSummary, toState: "OPEN", idempotencyKey: outcomeId, requestHash: caseHash, createdAt: now },
      { id: randomUUID(), caseId, actorUserId: actor.userId, actorKind: "STAFF", kind: "NOTE", audience: "INTERNAL",
        body: reason, idempotencyKey: randomUUID(), requestHash: hash({ caseId, outcomeId, audience: "INTERNAL", reason }), createdAt: now },
      { id: randomUUID(), caseId, actorUserId: actor.userId, actorKind: "STAFF", kind: "REPLY", audience: "CUSTOMER",
        body: "We are reviewing an update to your placement. We will keep you informed here.",
        idempotencyKey: randomUUID(), requestHash: hash({ caseId, outcomeId, audience: "CUSTOMER" }), createdAt: now },
    ]);
    if (fulfillment.state !== "ON_HOLD") {
      await tx.update(orderItemFulfillment).set({ state: "ON_HOLD", stateBeforeHold: fulfillment.state, updatedAt: now })
        .where(eq(orderItemFulfillment.orderItemId, input.itemId));
    }
    await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId,
      action: "SUPPLIER_FULFILLMENT_OUTCOME_RECORDED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId,
      reasonCode: input.outcome, metadata: { result: "RECORDED", supportCaseId: caseId } });
    await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId,
      action: "SUPPORT_CASE_OPENED_FOR_SUPPLIER_OUTCOME", targetType: "SUPPORT_CASE", targetId: caseId,
      metadata: { result: "OPENED", orderItemId: input.itemId } });
    return { outcomeId, supportCaseId: caseId, replayed: false };
  });
}
