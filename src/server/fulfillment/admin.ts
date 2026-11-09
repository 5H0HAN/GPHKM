import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier, orderItemWriting, publicationEvidence } from "@/db/order-schema";
import { orderItemContentChangeEvent, orderItemContentVersion } from "@/db/change-request-schema";
import { staffAccount, user } from "@/db/schema";
import { supplier, supplierContact } from "@/db/catalog-schema";
import { customerMilestone, transitionItem, type ItemState } from "@/modules/fulfillment/workflow";
import { contentReviewReasonOptions, customerStatusForMilestone, fulfillmentFollowUpUpdate, mayAssignFulfillment, mayReadFulfillmentContent, validateNextUpdate, validatePublicationUrl } from "@/modules/fulfillment/console";
import { requireStaffAccess } from "@/server/auth/staff";
import { appendAuditEvent } from "@/server/audit/append";
import { nextWritingState, validateWritingText } from "@/modules/orders/writing";
import { getConsentedSupplierPacketContent } from "@/server/orders/content-changes";
import { supplierFulfillmentOutcome, supplierFulfillmentOutcomeResolution, supplierFulfillmentRecovery } from "@/db/supplier-outcome-schema";
import { recordCorrectionReverification } from "@/server/fulfillment/publication-corrections";
import { FULFILLMENT_QUEUE_PAGE_SIZE, fulfillmentQueuePagination, fulfillmentQueueView } from "@/modules/fulfillment/queue-pagination";

const REASONS = new Set([
  "CUSTOMER_ACTION_NEEDED", "CONTENT_REVIEW", "CONTENT_APPROVED", "FULFILLMENT_STARTED",
  "PUBLICATION_UPDATE", "EVIDENCE_RECORDED", "PAUSED_FOR_REVIEW", "RESUMED_WORK",
  ...contentReviewReasonOptions.map(({ value }) => value),
]);
const CONTENT_REVIEW_REASONS = new Set<string>(contentReviewReasonOptions.map(({ value }) => value));

function id(value: string) { return /^[0-9a-f-]{36}$/i.test(value); }

async function staffTx<T>(headers: Headers, work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], actor: { userId: string; role: "ADMIN" | "FINANCE" | "SUPER_ADMIN" }) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

async function currentSupplierHandoffEvidence(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], itemId: string) {
  // Route writers lock the fulfillment item first; this scoped projection reads the route without requiring UPDATE access.
  const result = await tx.execute(sql`select route.supplier_id is not null as has_supplier, exists (
    select 1
      from public.supplier_packet_item pi
      join public.supplier_packet packet on packet.id = pi.packet_id
      join public.supplier_packet_attempt attempt on attempt.packet_id = packet.id
     where pi.order_item_id = route.order_item_id
       and pi.route_generation = route.route_generation
       and packet.supplier_id = route.supplier_id
       and packet.superseded_at is null
       and packet.version = (
         select max(latest.version)
           from public.supplier_packet latest
           join public.supplier_packet_item latest_item on latest_item.packet_id = latest.id
          where latest_item.order_item_id = pi.order_item_id
            and latest.supplier_id = route.supplier_id
            and latest.superseded_at is null
       )
       and (
         (attempt.type = 'SEND' and attempt.state = 'DELIVERED' and attempt.delivered_at is not null)
         or (attempt.type in ('MANUAL_SENT','MANUAL_SEND') and attempt.state = 'MANUAL_SENT'
           and attempt.sent_at is not null and exists (
             select 1 from public.supplier_packet_acknowledgement acknowledgement
              where acknowledgement.packet_id = packet.id and acknowledgement.attempt_id = attempt.id
           ))
       )
  ) as confirmed
    from public.order_item_fulfillment_supplier route
   where route.order_item_id = ${itemId}`);
  return (result as unknown as { rows?: Array<{ has_supplier: boolean; confirmed: boolean }> }).rows?.[0]
    ?? { has_supplier: false, confirmed: false };
}

export async function listFulfillmentQueue(headers: Headers, requestedPage?: unknown, requestedView?: unknown) {
  return staffTx(headers, async (tx, actor) => {
    const now = new Date();
    const active = notInArray(orderItemFulfillment.state, ["COMPLETED", "CANCELED_REFUNDED"]);
    const view = fulfillmentQueueView(requestedView);
    const filter = view === "all" ? undefined : active;
    const [count] = await tx.select({ total: sql<number>`count(*)::int` })
      .from(orderItemFulfillment).where(filter);
    const pagination = fulfillmentQueuePagination(requestedPage, count.total);
    const rows = await tx.select({
      orderItemId: orderItemFulfillment.orderItemId,
      orderId: orderItemFulfillment.orderId,
      listingTitle: orderItemFulfillment.listingTitle,
      state: orderItemFulfillment.state,
      customerStatus: orderItemFulfillment.customerStatus,
      assignedAdminId: orderItemFulfillment.assignedAdminId,
      assignedAdminName: user.name,
      fulfillmentSupplierId: orderItemFulfillmentSupplier.supplierId,
      nextUpdateAt: orderItemFulfillment.nextUpdateAt,
      updatedAt: orderItemFulfillment.updatedAt,
      createdAt: orderItemFulfillment.createdAt,
    }).from(orderItemFulfillment)
      .leftJoin(user, eq(user.id, orderItemFulfillment.assignedAdminId))
      .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, orderItemFulfillment.orderItemId))
      .where(filter)
      .orderBy(asc(orderItemFulfillment.nextUpdateAt), desc(orderItemFulfillment.updatedAt), asc(orderItemFulfillment.orderItemId))
      .limit(FULFILLMENT_QUEUE_PAGE_SIZE).offset(pagination.offset);
    const [overdue] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(orderItemFulfillment)
      .where(and(
        lte(orderItemFulfillment.nextUpdateAt, now),
        active,
      ));
    const assignees = await tx.select({ id: staffAccount.userId, name: user.name })
      .from(staffAccount).innerJoin(user, eq(user.id, staffAccount.userId))
      .where(and(eq(staffAccount.role, "ADMIN"), eq(staffAccount.active, true)))
      .orderBy(asc(user.name)).limit(100);
    return { rows, assignees, pagination, view, overdueCount: overdue.count, asOf: now, actorRole: actor.role, actorUserId: actor.userId };
  });
}

export async function getFulfillmentItem(headers: Headers, itemId: string) {
  if (!id(itemId)) throw new Error("Item unavailable");
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) {
      throw new Error("Item unavailable");
    }
    const [item] = await tx.select({
      orderedByUserId: customerOrder.actorUserId,
      targetUrl: customerOrderItem.targetUrl,
      anchorText: customerOrderItem.anchorText,
      instructions: customerOrderItem.instructions,
      articleText: customerOrderItem.articleText,
      writingBrief: customerOrderItem.writingBrief,
      writingSelected: customerOrderItem.writingSelected,
      listingSnapshot: customerOrderItem.customerListingSnapshot,
    }).from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(eq(customerOrderItem.id, itemId)).limit(1);
    if (!item) throw new Error("Item unavailable");
    const [writing] = item.writingSelected ? await tx.select({
      state: orderItemWriting.state, firstDraftText: orderItemWriting.firstDraftText,
      revisionRequestText: orderItemWriting.revisionRequestText, finalDraftText: orderItemWriting.finalDraftText,
      approvedArticleText: orderItemWriting.approvedArticleText, updatedAt: orderItemWriting.updatedAt,
    }).from(orderItemWriting).where(eq(orderItemWriting.orderItemId, itemId)).limit(1) : [];
    // Display the latest consented version even while a newer request is
    // pending. Packet preparation still checks the current recipient and consent.
    const [currentContent] = await tx.select({
      targetUrl: orderItemContentVersion.targetUrl, anchorText: orderItemContentVersion.anchorText,
      articleText: orderItemContentVersion.articleText, instructions: orderItemContentVersion.instructions,
    }).from(orderItemContentVersion).innerJoin(orderItemContentChangeEvent, and(
      eq(orderItemContentChangeEvent.requestId, orderItemContentVersion.requestId),
      eq(orderItemContentChangeEvent.versionId, orderItemContentVersion.id),
      eq(orderItemContentChangeEvent.contentHash, orderItemContentVersion.contentHash),
      eq(orderItemContentChangeEvent.eventType, "CONSENTED"),
    )).where(eq(orderItemContentVersion.orderItemId, itemId)).orderBy(desc(orderItemContentVersion.version)).limit(1);
    const [supplierRow] = await tx.select({ id: supplier.id, name: supplier.name, status: supplier.status,
      routeGeneration: orderItemFulfillmentSupplier.routeGeneration, contactName: supplierContact.name, email: supplierContact.email })
      .from(orderItemFulfillmentSupplier)
      .innerJoin(supplier, eq(supplier.id, orderItemFulfillmentSupplier.supplierId))
      .leftJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
      .where(eq(orderItemFulfillmentSupplier.orderItemId, itemId)).limit(1);
    const handoffEvidence = fulfillment.state === "HANDOFF_PENDING"
      ? await currentSupplierHandoffEvidence(tx, itemId) : { has_supplier: Boolean(supplierRow), confirmed: false };
    const evidence = await tx.select({ id: publicationEvidence.id, liveUrl: publicationEvidence.liveUrl, verifiedAt: publicationEvidence.verifiedAt })
      .from(publicationEvidence).where(eq(publicationEvidence.orderItemId, itemId)).orderBy(desc(publicationEvidence.verifiedAt)).limit(10);
    const outcomes = await tx.select({ id: supplierFulfillmentOutcome.id, outcome: supplierFulfillmentOutcome.outcome,
      reason: supplierFulfillmentOutcome.reason, createdAt: supplierFulfillmentOutcome.createdAt,
      supportCaseId: supplierFulfillmentOutcome.supportCaseId })
      .from(supplierFulfillmentOutcome).where(eq(supplierFulfillmentOutcome.orderItemId, itemId))
      .orderBy(desc(supplierFulfillmentOutcome.createdAt), desc(supplierFulfillmentOutcome.id)).limit(20);
    const [unresolved] = await tx.select({ total: sql<number>`count(*)::int`,
      currentRoute: sql<number>`count(*) filter (where ${supplierFulfillmentOutcome.supplierId} = ${supplierRow?.id ?? ""} and ${supplierFulfillmentOutcome.routeGeneration} = ${supplierRow?.routeGeneration ?? 0})::int`,
      cases: sql<number>`count(distinct ${supplierFulfillmentOutcome.supportCaseId})::int` })
      .from(supplierFulfillmentOutcome).leftJoin(supplierFulfillmentOutcomeResolution,
        eq(supplierFulfillmentOutcomeResolution.outcomeId, supplierFulfillmentOutcome.id))
      .where(and(eq(supplierFulfillmentOutcome.orderItemId, itemId), isNull(supplierFulfillmentOutcomeResolution.outcomeId)));
    const canRecoverSameSupplier = actor.role === "SUPER_ADMIN" && fulfillment.state === "ON_HOLD"
      && fulfillment.assignedAdminId === actor.userId && supplierRow?.status === "ACTIVE"
      && Boolean(supplierRow.email) && unresolved.total > 0 && unresolved.total === unresolved.currentRoute && unresolved.cases === 1;
    const canOfferEquivalent = fulfillment.state === "ON_HOLD"
      && mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })
      && unresolved.total > 0 && unresolved.total === unresolved.currentRoute && unresolved.cases === 1;
    const recoveries = await tx.select({ id: supplierFulfillmentRecovery.id, reason: supplierFulfillmentRecovery.reason,
      routeGeneration: supplierFulfillmentRecovery.routeGeneration, createdAt: supplierFulfillmentRecovery.createdAt,
      actorName: user.name, supportCaseId: supplierFulfillmentRecovery.supportCaseId })
      .from(supplierFulfillmentRecovery).innerJoin(user, eq(user.id, supplierFulfillmentRecovery.actorUserId))
      .where(eq(supplierFulfillmentRecovery.orderItemId, itemId))
      .orderBy(desc(supplierFulfillmentRecovery.createdAt), desc(supplierFulfillmentRecovery.id)).limit(20);
    await appendAuditEvent(tx, {
      actorUserId: actor.userId,
      action: "FULFILLMENT_ITEM_CONTENT_VIEWED",
      targetType: "CUSTOMER_ORDER_ITEM",
      targetId: itemId,
      metadata: { result: "ALLOWED", reasonCode: actor.role === "SUPER_ADMIN" ? "SUPER_ADMIN_ACCESS" : "ASSIGNED_ADMIN_ACCESS" },
    });
    const effectiveItem = currentContent ? {
      ...item, targetUrl: currentContent.targetUrl, anchorText: currentContent.anchorText,
      articleText: currentContent.articleText ?? item.articleText,
      instructions: currentContent.instructions,
    } : item;
    return { fulfillment, item: effectiveItem, writing: writing ?? null, supplier: supplierRow ?? null,
      supplierHandoffConfirmed: handoffEvidence.confirmed,
      evidence, outcomes, recoveries, canRecoverSameSupplier, canOfferEquivalent, actorRole: actor.role };
  });
}

export async function saveWritingDraft(headers: Headers, input: { itemId: string; kind: "FIRST_DRAFT" | "FINAL_DRAFT"; text: string }) {
  if (!id(input.itemId) || !["FIRST_DRAFT", "FINAL_DRAFT"].includes(input.kind)) throw new Error("Writing draft is invalid");
  const draft = validateWritingText(input.text, 20_000);
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Item unavailable");
    const [item] = await tx.select({ writingSelected: customerOrderItem.writingSelected })
      .from(customerOrderItem).where(eq(customerOrderItem.id, input.itemId)).limit(1);
    if (!item?.writingSelected) throw new Error("Writing item unavailable");
    const [writing] = await tx.select({ state: orderItemWriting.state }).from(orderItemWriting)
      .where(eq(orderItemWriting.orderItemId, input.itemId)).limit(1);
    if (!writing) throw new Error("Writing item unavailable");
    const expectedState = nextWritingState(writing.state, input.kind);
    const result = await tx.execute(sql`select public.gphkm_advance_order_item_writing(${input.itemId}, ${input.kind}, ${draft}) as state`);
    const state = (result as unknown as { rows?: Array<{ state: string }> }).rows?.[0]?.state;
    if (!state || state !== expectedState) throw new Error("Writing update requires reconciliation");
    const now = new Date();
    await tx.update(orderItemFulfillment).set({ customerStatus: "CONTENT_REVIEW", updatedAt: now })
      .where(eq(orderItemFulfillment.orderItemId, input.itemId));
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "WRITING_DRAFT_SUBMITTED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId,
      reasonCode: input.kind, metadata: {
        fromState: input.kind === "FIRST_DRAFT" ? "WAITING_FOR_FIRST_DRAFT" : "REVISION_REQUESTED",
        toState: state, result: "UPDATED",
      },
    });
    return { itemId: input.itemId, state };
  });
}

export async function assignFulfillmentItem(headers: Headers, itemId: string, assignedAdminId: string | null) {
  if (!id(itemId) || (assignedAdminId !== null && !id(assignedAdminId))) throw new Error("Invalid assignment");
  return staffTx(headers, async (tx, actor) => {
    if (!mayAssignFulfillment(actor.role)) throw new Error("Forbidden");
    const result = await tx.execute(sql`select public.gphkm_assign_fulfillment_item(${itemId}, ${assignedAdminId}) as order_item_id`);
    const assigned = (result as unknown as { rows?: Array<{ order_item_id: string }> }).rows?.[0]?.order_item_id;
    if (assigned !== itemId) throw new Error("Assignment requires reconciliation");
    return { itemId, assignedAdminId };
  });
}

export async function updateFulfillmentFollowUp(headers: Headers, input: { itemId: string; nextUpdateAt: string; reasonCode: string }) {
  if (!id(input.itemId)) throw new Error("Item unavailable");
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment) throw new Error("Item unavailable");
    const update = fulfillmentFollowUpUpdate({ ...input, ...actor, assignedAdminId: fulfillment.assignedAdminId, state: fulfillment.state });
    await tx.update(orderItemFulfillment).set(update)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId));
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "FULFILLMENT_FOLLOW_UP_CHANGED",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId,
      reasonCode: input.reasonCode, metadata: { result: "UPDATED" },
    });
    return { itemId: input.itemId, nextUpdateAt: update.nextUpdateAt };
  });
}

export async function updateFulfillmentState(headers: Headers, input: { itemId: string; to: string; reasonCode: string; nextUpdateAt: string }) {
  if (!id(input.itemId) || !REASONS.has(input.reasonCode)) throw new Error("Invalid update");
  // Completion is only allowed through recordPublicationEvidence, which writes
  // the verified URL and state change in the same transaction.
  if (input.to === "COMPLETED") throw new Error("Record live publication evidence to complete an item");
  const nextUpdateAt = input.to === "COMPLETED" || input.to === "CANCELED_REFUNDED" ? null : validateNextUpdate(input.nextUpdateAt);
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Item unavailable");
    if (input.to === "HANDOFF_PENDING" && fulfillment.state === "READY_FOR_HANDOFF") {
      throw new Error("Prepare the supplier packet before entering handoff preparation");
    }
    const [item] = await tx.select().from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(eq(customerOrderItem.id, input.itemId)).limit(1);
    if (!item) throw new Error("Item unavailable");
    if ((input.to as ItemState) === "IN_FULFILLMENT") {
      const handoffEvidence = await currentSupplierHandoffEvidence(tx, input.itemId);
      if (handoffEvidence.has_supplier && !handoffEvidence.confirmed) {
        throw new Error("Confirm supplier delivery before starting placement work");
      }
    }
    const orderItem = item.customer_order_item;
    const order = item.customer_order;
    const writing = orderItem.writingSelected ? await tx.select({ state: orderItemWriting.state })
      .from(orderItemWriting).where(eq(orderItemWriting.orderItemId, input.itemId)).for("update").limit(1) : [];
    const consentedReplacement = writing.some(({ state }) => state === "CUSTOMER_DECLINED_FINAL")
      ? await getConsentedSupplierPacketContent(tx, input.itemId).catch(() => null) : null;
    const writingApproved = !orderItem.writingSelected || writing.some(({ state }) => state === "APPROVED_FIRST" || state === "APPROVED_FINAL")
      || (writing.some(({ state }) => state === "CUSTOMER_DECLINED_FINAL") && Boolean(consentedReplacement?.articleText));
    if (CONTENT_REVIEW_REASONS.has(input.reasonCode) && (input.to as ItemState) !== "ON_HOLD") {
      throw new Error("Content review reason codes can only be used when placing an item on hold");
    }
    const now = new Date();
    const result = transitionItem({
      item: {
        id: orderItem.id, organizationId: order.organizationId, orderId: order.id,
        orderedByUserId: order.actorUserId, state: fulfillment.state as ItemState,
        updatedAt: fulfillment.updatedAt.toISOString(), purchasedAt: order.createdAt.toISOString(),
        ...(fulfillment.workStartedAt ? { workStartedAt: fulfillment.workStartedAt.toISOString() } : {}),
        ...(fulfillment.stateBeforeHold ? { stateBeforeHold: fulfillment.stateBeforeHold as ItemState } : {}),
        ...(fulfillment.stateBeforeCancellation ? { stateBeforeCancellation: fulfillment.stateBeforeCancellation as ItemState } : {}),
        writingSelected: orderItem.writingSelected,
        writingApproved,
        totalPaidMinor: 0, currency: "USD",
      },
      to: input.to as ItemState,
      actorId: actor.userId,
      actorType: "STAFF",
      actorRole: actor.role,
      assignedAdminId: fulfillment.assignedAdminId ?? undefined,
      at: now.toISOString(),
      reason: input.reasonCode,
      eventId: randomUUID(),
    });
    const milestone = customerMilestone(result.item.state);
    const customerStatus = customerStatusForMilestone(milestone, result.item.state);
    await tx.update(orderItemFulfillment).set({
      state: result.item.state,
      stateBeforeHold: result.item.stateBeforeHold ?? null,
      stateBeforeCancellation: result.item.stateBeforeCancellation ?? null,
      customerStatus,
      nextUpdateAt,
      workStartedAt: result.item.workStartedAt ? new Date(result.item.workStartedAt) : null,
      updatedAt: now,
    }).where(eq(orderItemFulfillment.orderItemId, input.itemId));
    await appendAuditEvent(tx, {
      organizationId: order.organizationId,
      actorUserId: actor.userId,
      action: "FULFILLMENT_STATE_CHANGED",
      targetType: "CUSTOMER_ORDER_ITEM",
      targetId: input.itemId,
      reasonCode: input.reasonCode,
      metadata: { fromState: result.event.from, toState: result.event.to, result: "UPDATED" },
    });
    return { state: result.item.state, customerStatus, nextUpdateAt };
  });
}

export async function recordPublicationEvidence(headers: Headers, input: { itemId: string; liveUrl: string }) {
  if (!id(input.itemId)) throw new Error("Item unavailable");
  const liveUrl = validatePublicationUrl(input.liveUrl);
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Item unavailable");
    if (fulfillment.state !== "PUBLICATION_PENDING" && fulfillment.state !== "EVIDENCE_REVIEW") throw new Error("Item is not ready for link verification");
    const [item] = await tx.select().from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(eq(customerOrderItem.id, input.itemId)).limit(1);
    if (!item) throw new Error("Item unavailable");
    const now = new Date();
    const orderItem = item.customer_order_item;
    const order = item.customer_order;
    const snapshot = {
      id: orderItem.id, organizationId: order.organizationId, orderId: order.id,
      orderedByUserId: order.actorUserId, state: fulfillment.state as ItemState,
      updatedAt: fulfillment.updatedAt.toISOString(), purchasedAt: order.createdAt.toISOString(),
      totalPaidMinor: 0, currency: "USD" as const,
    };
    let current = snapshot;
    if (current.state === "PUBLICATION_PENDING") {
      const review = transitionItem({ item: current, to: "EVIDENCE_REVIEW", actorId: actor.userId, actorType: "STAFF", actorRole: actor.role, assignedAdminId: fulfillment.assignedAdminId ?? undefined, at: now.toISOString(), reason: "EVIDENCE_RECORDED", eventId: randomUUID() });
      current = review.item;
      await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId, action: "FULFILLMENT_STATE_CHANGED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId, reasonCode: "EVIDENCE_RECORDED", metadata: { fromState: review.event.from, toState: review.event.to, result: "UPDATED" } });
    }
    const evidenceId = randomUUID();
    await tx.insert(publicationEvidence).values({ id: evidenceId, orderItemId: input.itemId, liveUrl, method: "STAFF_MANUAL", verifiedByUserId: actor.userId, verifiedAt: now });
    await recordCorrectionReverification(tx, { itemId: input.itemId, evidenceId, actorUserId: actor.userId });
    const completed = transitionItem({ item: current, to: "COMPLETED", actorId: actor.userId, actorType: "STAFF", actorRole: actor.role, assignedAdminId: fulfillment.assignedAdminId ?? undefined, at: now.toISOString(), reason: "EVIDENCE_RECORDED", eventId: randomUUID() });
    await tx.update(orderItemFulfillment).set({ state: "COMPLETED", customerStatus: "COMPLETE", nextUpdateAt: null, updatedAt: now }).where(eq(orderItemFulfillment.orderItemId, input.itemId));
    await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId, action: "PUBLICATION_EVIDENCE_RECORDED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId, reasonCode: "STAFF_MANUAL_VERIFICATION", metadata: { result: "VERIFIED" } });
    await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId, action: "FULFILLMENT_STATE_CHANGED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId, reasonCode: "EVIDENCE_RECORDED", metadata: { fromState: completed.event.from, toState: completed.event.to, result: "COMPLETED" } });
    return { itemId: input.itemId, state: "COMPLETED", verifiedAt: now.toISOString() };
  });
}
