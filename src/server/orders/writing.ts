import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { customerOrder, customerOrderItem, orderItemWriting } from "@/db/order-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireVerifiedCustomer, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { nextWritingState, validateWritingText, type WritingCommand } from "@/modules/orders/writing";

export type CustomerWritingCommand = Extract<WritingCommand, "REQUEST_REVISION" | "APPROVE" | "DECLINE_FINAL">;

export async function updateCustomerWriting(
  headers: Headers,
  organizationId: string,
  itemId: string,
  command: CustomerWritingCommand,
  text = "",
) {
  if (!/^[0-9a-f-]{36}$/i.test(itemId) || !organizationId || organizationId.length > 128) throw new Error("Writing item unavailable");
  if (command === "REQUEST_REVISION") text = validateWritingText(text, 2_000);
  if ((command === "APPROVE" || command === "DECLINE_FINAL") && text !== "") throw new Error("Invalid writing decision");
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const [row] = await tx.select({
      organizationId: customerOrder.organizationId, actorUserId: customerOrder.actorUserId,
      itemId: customerOrderItem.id, writingSelected: customerOrderItem.writingSelected,
    }).from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, itemId), eq(customerOrder.organizationId, organizationId))).limit(1);
    if (!row || !row.writingSelected || row.actorUserId !== actor.userId) throw new Error("Writing item unavailable");
    const [writing] = await tx.select({ state: orderItemWriting.state }).from(orderItemWriting)
      .where(eq(orderItemWriting.orderItemId, itemId)).limit(1);
    if (!writing) throw new Error("Writing item unavailable");
    const expectedState = command === "DECLINE_FINAL" && writing.state === "CUSTOMER_DECLINED_FINAL"
      ? "CUSTOMER_DECLINED_FINAL" : nextWritingState(writing.state, command);
    const result = command === "DECLINE_FINAL"
      ? await tx.execute(sql`select state, refund_minor from public.gphkm_decline_order_item_writing(${itemId})`)
      : await tx.execute(sql`select public.gphkm_advance_order_item_writing(${itemId}, ${command}, ${command === "APPROVE" ? null : text}) as state, 0::numeric as refund_minor`);
    const response = (result as unknown as { rows?: Array<{ state: string; refund_minor: string }> }).rows?.[0];
    const state = response?.state;
    if (!state || state !== expectedState) throw new Error("Writing update requires reconciliation");
    await appendAuditEvent(tx, {
      organizationId, actorUserId: actor.userId,
      action: command === "APPROVE" ? "WRITING_DRAFT_APPROVED" : command === "DECLINE_FINAL" ? "WRITING_FINAL_DECLINED" : "WRITING_REVISION_REQUESTED",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: itemId,
      reasonCode: command === "APPROVE" ? "CUSTOMER_APPROVED_DRAFT" : command === "DECLINE_FINAL" ? "FINAL_WRITING_DECLINED" : "INCLUDED_REVISION_REQUESTED",
      metadata: {
        fromState: command === "REQUEST_REVISION" ? "FIRST_DRAFT_READY" : "FINAL_DRAFT_READY",
        toState: state, result: "UPDATED", ...(command === "DECLINE_FINAL" ? { walletCreditMinor: response?.refund_minor ?? "0" } : {}),
      },
    });
    return { itemId, state, ...(command === "DECLINE_FINAL" ? { refundMinor: response?.refund_minor ?? "0" } : {}) };
  });
}
