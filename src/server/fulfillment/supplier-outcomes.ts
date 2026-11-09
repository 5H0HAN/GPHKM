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
import { assertSupplierOutcomeMayBeRecorded, normalizeSupplierRecoveryReason } from "@/modules/fulfillment/supplier-outcome";

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
    const [order] = await tx.select({ id: customerOrder.id, organizationId: customerOrder.organizationId,
      ordererId: customerOrder.actorUserId, paid: customerOrder.checkoutState })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(eq(customerOrderItem.id, input.itemId)).limit(1);
    if (!order || order.paid !== "PAID") throw new Error("Supplier outcome is unavailable for this item");

    // Serialize order-scoped case discovery, then use the same item-before-case
    // order as equivalent-offer decisions. Case closure locks only the case and
    // never waits for item rows, so an item lock cannot form a close/accept cycle.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      'gphkm:support-order:' || ${order.organizationId} || ':' || ${order.id}, 0))`);

    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId }) ||
        ["COMPLETED", "CANCELED_REFUNDED"].includes(fulfillment.state)) throw new Error("Order item unavailable");

    const [activeCase] = await tx.select().from(supportCase).where(and(
      eq(supportCase.organizationId, order.organizationId), eq(supportCase.orderId, order.id),
      sql`${supportCase.state} not in ('RESOLVED','CLOSED')`, sql`${supportCase.mergedIntoCaseId} is null`,
    )).for("update").limit(1);

    const [prior] = await tx.select({ id: supplierFulfillmentOutcome.id, supportCaseId: supplierFulfillmentOutcome.supportCaseId,
      requestHash: supplierFulfillmentOutcome.requestHash })
      .from(supplierFulfillmentOutcome).where(and(eq(supplierFulfillmentOutcome.orderItemId, input.itemId),
        eq(supplierFulfillmentOutcome.actorUserId, actor.userId), eq(supplierFulfillmentOutcome.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Supplier outcome idempotency conflict");
      return { outcomeId: prior.id, supportCaseId: prior.supportCaseId, replayed: true };
    }
    assertSupplierOutcomeMayBeRecorded(fulfillment.state);

    const [supplierRow] = await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId })
      .from(orderItemFulfillmentSupplier).where(eq(orderItemFulfillmentSupplier.orderItemId, input.itemId)).limit(1);
    if (!supplierRow?.supplierId) throw new Error("Supplier outcome is unavailable for this item");

    const now = new Date();
    const outcomeId = randomUUID();
    const caseId = activeCase?.id ?? randomUUID();
    const safeSummary = "GPHKM is reviewing an update to this placement.";
    const caseHash = hash({ source: "SUPPLIER_FULFILLMENT_OUTCOME", outcomeId });
    if (!activeCase) {
      await tx.insert(supportCase).values({
        id: caseId, organizationId: order.organizationId, orderId: order.id, orderItemId: input.itemId,
        openedByUserId: order.ordererId, summary: safeSummary, state: "OPEN", idempotencyKey: outcomeId,
        requestHash: caseHash, createdAt: now, updatedAt: now,
      });
    } else if (["WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER"].includes(activeCase.state)) {
      await tx.insert(supportCaseEvent).values({ id: randomUUID(), caseId, actorUserId: actor.userId, actorKind: "STAFF",
        kind: "STATE_CHANGED", audience: "INTERNAL", body: "A new supplier update needs staff review.",
        fromState: activeCase.state, toState: "INVESTIGATING", idempotencyKey: randomUUID(),
        requestHash: hash({ caseId, from: activeCase.state, to: "INVESTIGATING", outcomeId }) });
      await tx.update(supportCase).set({ state: "INVESTIGATING", updatedAt: now }).where(eq(supportCase.id, caseId));
    }
    await tx.insert(supplierFulfillmentOutcome).values({
      id: outcomeId, orderItemId: input.itemId, supplierId: supplierRow.supplierId, supportCaseId: caseId,
      actorUserId: actor.userId, outcome: input.outcome, reason, idempotencyKey: input.idempotencyKey,
      requestHash, createdAt: now,
    });
    await tx.insert(supportCaseEvent).values([
      ...(!activeCase ? [{ id: randomUUID(), caseId, actorUserId: actor.userId, actorKind: "STAFF" as const, kind: "OPENED" as const, audience: "INTERNAL" as const,
        body: safeSummary, toState: "OPEN", idempotencyKey: outcomeId, requestHash: caseHash, createdAt: now }] : []),
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

export async function recoverSupplierFailure(headers: Headers, input: {
  itemId: string; reason: string; idempotencyKey: string;
}) {
  if (![input.itemId, input.idempotencyKey].every((value) => UUID.test(value))) throw new Error("Supplier recovery is unavailable");
  const reason = normalizeSupplierRecoveryReason(input.reason);
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  const requestHash = hash({ itemId: input.itemId, reason });

  return db.transaction(async (tx: Tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select recovery_id, support_case_id, replayed
      from public.gphkm_recover_supplier_failure(${input.itemId}, ${reason}, ${input.idempotencyKey}, ${requestHash})`);
    const command = (result as unknown as { rows?: Array<{ recovery_id: string; support_case_id: string; replayed: boolean }> }).rows?.[0];
    if (!command?.recovery_id || !command.support_case_id) throw new Error("Supplier recovery requires reconciliation");
    if (command.replayed) return { recoveryId: command.recovery_id, supportCaseId: command.support_case_id, replayed: true };

    const [caseRow] = await tx.select({ state: supportCase.state, organizationId: supportCase.organizationId }).from(supportCase)
      .where(eq(supportCase.id, command.support_case_id)).for("update").limit(1);
    if (!caseRow || ["RESOLVED", "CLOSED"].includes(caseRow.state)) throw new Error("Support case changed during recovery");
    const now = new Date();
    if (["WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER"].includes(caseRow.state)) {
      await tx.insert(supportCaseEvent).values({ id: randomUUID(), caseId: command.support_case_id,
        actorUserId: actor.userId, actorKind: "STAFF", kind: "STATE_CHANGED", audience: "INTERNAL",
        body: "Same-supplier recovery was recorded; fulfillment review can continue.",
        fromState: caseRow.state, toState: "INVESTIGATING", idempotencyKey: randomUUID(),
        requestHash: hash({ caseId: command.support_case_id, recoveryId: command.recovery_id, from: caseRow.state, to: "INVESTIGATING" }),
        createdAt: now });
      await tx.update(supportCase).set({ state: "INVESTIGATING", updatedAt: now }).where(eq(supportCase.id, command.support_case_id));
    } else {
      await tx.update(supportCase).set({ updatedAt: now }).where(eq(supportCase.id, command.support_case_id));
    }
    await tx.insert(supportCaseEvent).values([
      { id: randomUUID(), caseId: command.support_case_id, actorUserId: actor.userId, actorKind: "STAFF", kind: "NOTE", audience: "INTERNAL",
        body: `Same-supplier recovery evidence: ${reason}`, idempotencyKey: randomUUID(),
        requestHash: hash({ caseId: command.support_case_id, recoveryId: command.recovery_id, audience: "INTERNAL", reason }), createdAt: now },
      { id: randomUUID(), caseId: command.support_case_id, actorUserId: actor.userId, actorKind: "STAFF", kind: "REPLY", audience: "CUSTOMER",
        body: "We have confirmed that work on your placement can move forward. We are reviewing the approved content and fulfillment details before preparation, and we will share another update here when preparation is complete.",
        idempotencyKey: randomUUID(), requestHash: hash({ caseId: command.support_case_id, recoveryId: command.recovery_id, audience: "CUSTOMER" }), createdAt: now },
    ]);
    await appendAuditEvent(tx, { organizationId: caseRow.organizationId, actorUserId: actor.userId, action: "SUPPLIER_FAILURE_SAME_SUPPLIER_RECOVERED",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId, reasonCode: "SAME_SUPPLIER_RECONFIRMED",
      metadata: { recoveryId: command.recovery_id, supportCaseId: command.support_case_id } });
    return { recoveryId: command.recovery_id, supportCaseId: command.support_case_id, replayed: false };
  });
}
