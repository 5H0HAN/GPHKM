import "server-only";
import { MAX_CUSTOMER_ORDERS_PAGE_ITEMS } from "@/modules/orders/checkout";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier, orderItemWriting } from "@/db/order-schema";
import { orderItemContentChangeEvent, orderItemContentChangeRequest, orderItemContentVersion } from "@/db/change-request-schema";
import { orderItemEquivalentOffer, orderItemEquivalentOfferEvent } from "@/db/equivalent-offer-schema";
import { supplierContact } from "@/db/catalog-schema";
import { requireStaffAccess } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { appendAuditEvent } from "@/server/audit/append";
import { logSafeFailure } from "@/server/observability/safe-log";
import { contentChangeStatus, hashOrderContent, isStaleRecipientReconsent, mayRequestContentChange, mergeContentChange, validateContentChangePatch, type ContentChangeStatus, type OrderContent } from "@/modules/orders/content-changes";
import { mayReadFulfillmentContent } from "@/modules/fulfillment/console";
import { CONTENT_SHARING_NOTICE_VERSION } from "@/modules/orders/checkout";
import { resolvePacketContentRows, type PacketContent as BatchPacketContent } from "@/modules/orders/packet-content";

const validId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function packetRead<T>(stage: string, buildQuery: () => PromiseLike<T>): Promise<T> {
  let query: PromiseLike<T>;
  try {
    query = buildQuery();
  } catch (error) {
    logSafeFailure("supplier_packet_content_query_failed", error, randomUUID(), { reasonCode: stage });
    throw error;
  }
  return Promise.resolve(query).catch((error: unknown) => {
    logSafeFailure("supplier_packet_content_query_failed", error, randomUUID(), { reasonCode: stage });
    throw error;
  });
}

function toContent(row: { targetUrl: string; anchorText: string; articleText: string | null; instructions?: string | null }): OrderContent {
  return Object.freeze({ targetUrl: row.targetUrl, anchorText: row.anchorText, articleText: row.articleText, instructions: row.instructions ?? "" });
}

async function latestRequestEvents(tx: Tx, requestId: string) {
  return tx.select({ id: orderItemContentChangeEvent.id, eventType: orderItemContentChangeEvent.eventType, versionId: orderItemContentChangeEvent.versionId, contentHash: orderItemContentChangeEvent.contentHash, noticeVersion: orderItemContentChangeEvent.noticeVersion, reason: orderItemContentChangeEvent.reason, createdAt: orderItemContentChangeEvent.createdAt, createdAtExact: sql<string>`to_char(${orderItemContentChangeEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(orderItemContentChangeEvent).where(eq(orderItemContentChangeEvent.requestId, requestId))
    .orderBy(desc(orderItemContentChangeEvent.createdAt), desc(orderItemContentChangeEvent.id));
}

async function currentConsentedContent(tx: Tx, itemId: string, customer?: { userId: string; organizationId: string }) {
  if (customer) {
    const consents = await tx.select({ requestId: orderItemContentChangeEvent.requestId })
      .from(orderItemContentChangeEvent).innerJoin(orderItemContentChangeRequest, eq(orderItemContentChangeRequest.id, orderItemContentChangeEvent.requestId))
      .where(and(eq(orderItemContentChangeRequest.orderItemId, itemId), eq(orderItemContentChangeEvent.eventType, "CONSENTED")))
      .orderBy(desc(orderItemContentChangeEvent.createdAt), desc(orderItemContentChangeEvent.id)).limit(1);
    if (consents[0]) {
      const result = await tx.execute(sql`select version, target_url, anchor_text, article_text, instructions from public.gphkm_customer_approved_content(${consents[0].requestId}, ${customer.userId}, ${customer.organizationId})`);
      const version = (result as unknown as { rows?: Array<{ version: number; target_url: string; anchor_text: string; article_text: string | null; instructions: string }> }).rows?.[0];
      if (!version) throw new Error("Previous consented content is unavailable");
      return { content: toContent({ targetUrl: version.target_url, anchorText: version.anchor_text, articleText: version.article_text, instructions: version.instructions }), version: version.version };
    }
    const [item] = await tx.select({ targetUrl: customerOrderItem.targetUrl, anchorText: customerOrderItem.anchorText, articleText: customerOrderItem.articleText, instructions: customerOrderItem.instructions, writingSelected: customerOrderItem.writingSelected })
      .from(customerOrderItem).where(eq(customerOrderItem.id, itemId)).limit(1);
    if (!item) throw new Error("Order item unavailable");
    if (item.writingSelected) {
      const [writing] = await tx.select({ approvedArticleText: orderItemWriting.approvedArticleText, state: orderItemWriting.state }).from(orderItemWriting).where(eq(orderItemWriting.orderItemId, itemId)).limit(1);
      return { content: toContent({ targetUrl: item.targetUrl, anchorText: item.anchorText, articleText: writing?.approvedArticleText ?? null, instructions: item.instructions }), version: 1 };
    }
    return { content: toContent(item), version: 1 };
  }
  const versions = await tx.select().from(orderItemContentVersion).where(eq(orderItemContentVersion.orderItemId, itemId))
    .orderBy(desc(orderItemContentVersion.version)).limit(1);
  const latest = versions[0];
  if (latest) {
    const events = await latestRequestEvents(tx, latest.requestId);
    const status = contentChangeStatus(events);
    if (status !== "CONSENTED" || events[0]?.versionId !== latest.id || events[0]?.contentHash !== latest.contentHash) {
      throw new Error("A previous content change still needs customer consent");
    }
    return { content: toContent(latest), version: latest.version };
  }
  const [item] = await tx.select({ targetUrl: customerOrderItem.targetUrl, anchorText: customerOrderItem.anchorText, articleText: customerOrderItem.articleText, instructions: customerOrderItem.instructions, writingSelected: customerOrderItem.writingSelected })
    .from(customerOrderItem).where(eq(customerOrderItem.id, itemId)).limit(1);
  if (!item) throw new Error("Order item unavailable");
  if (item.writingSelected) {
    const [writing] = await tx.select({ approvedArticleText: orderItemWriting.approvedArticleText, state: orderItemWriting.state }).from(orderItemWriting).where(eq(orderItemWriting.orderItemId, itemId)).limit(1);
    return { content: toContent({ targetUrl: item.targetUrl, anchorText: item.anchorText, articleText: writing?.approvedArticleText ?? null, instructions: item.instructions }), version: 1 };
  }
  return { content: toContent(item), version: 1 };
}

export async function submitContentChangeRequest(headers: Headers, organizationId: string, itemId: string, rawPatch: Record<string, unknown>) {
  if (!validId(itemId) || !organizationId || organizationId.length > 128) throw new Error("Order item unavailable");
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    // The customer can read this row but intentionally has no UPDATE privilege,
    // so SELECT FOR UPDATE is filtered by the staff-only UPDATE policy. The
    // insert trigger locks the same row and revalidates the pre-handoff state,
    // serializing this request with handoff without weakening customer RLS.
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    const [item] = await tx.select({ orderId: customerOrder.id, organizationId: customerOrder.organizationId, ordererId: customerOrder.actorUserId, writingSelected: customerOrderItem.writingSelected })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, itemId), eq(customerOrder.organizationId, organizationId))).limit(1);
    if (!item || !fulfillment || !mayRequestContentChange({ requesterId: actor.userId, ordererId: item.ordererId, handedOffAt: fulfillment.handedOffAt, state: fulfillment.state })) throw new Error("Content changes are unavailable for this item");
    const [writing] = item.writingSelected ? await tx.select({ state: orderItemWriting.state }).from(orderItemWriting).where(eq(orderItemWriting.orderItemId, itemId)).limit(1) : [];
    const writingStopped = writing?.state === "CUSTOMER_DECLINED_FINAL";
    const patch = validateContentChangePatch(rawPatch, item.writingSelected, writingStopped);
    const current = await currentConsentedContent(tx, itemId, { userId: actor.userId, organizationId });
    if (item.writingSelected && !writingStopped && !current.content.articleText) throw new Error("Request content changes after you approve the GPHKM Writing draft");
    if (writingStopped && !patch.articleText) throw new Error("Submit the complete customer article to continue this placement");
    const existing = await tx.select({ id: orderItemContentChangeRequest.id }).from(orderItemContentChangeRequest)
      .where(eq(orderItemContentChangeRequest.orderItemId, itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(1);
    if (existing[0]) {
      const events = await latestRequestEvents(tx, existing[0].id);
      if (contentChangeStatus(events) === "REQUESTED" || contentChangeStatus(events) === "APPROVED_AWAITING_CONSENT") throw new Error("A content change is already awaiting review or consent");
    }
    const requestNumber = (existing[0] ? Number((await tx.select({ requestNumber: orderItemContentChangeRequest.requestNumber }).from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.id, existing[0].id)).limit(1))[0]?.requestNumber ?? 0) : 0) + 1;
    const requestId = randomUUID();
    const now = new Date();
    await tx.insert(orderItemContentChangeRequest).values({
      id: requestId, orderItemId: itemId, requestNumber, requestedByUserId: actor.userId, baseVersion: current.version,
      targetUrl: patch.targetUrl ?? null, anchorText: patch.anchorText ?? null,
      articleText: patch.articleText ?? null, instructions: patch.instructions ?? null, createdAt: now,
    });
    await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId, eventType: "REQUESTED", createdAt: now });
    await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "ORDER_CONTENT_CHANGE_REQUESTED", targetType: "CUSTOMER_ORDER_ITEM", targetId: itemId, reasonCode: "CUSTOMER_REQUEST", metadata: { result: "CREATED", version: current.version } });
    return { requestId, status: "REQUESTED" as const };
  });
}

export async function reviewContentChangeRequest(headers: Headers, requestId: string, decision: "APPROVE" | "REJECT", reason = "") {
  if (!validId(requestId) || !["APPROVE", "REJECT"].includes(decision)) throw new Error("Change request unavailable");
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role !== "ADMIN" && actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
  if (decision === "REJECT" && (reason.trim().length < 2 || reason.length > 1000)) throw new Error("A short rejection reason is required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [request] = await tx.select().from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.id, requestId)).limit(1);
    if (!request) throw new Error("Change request unavailable");
    // The database trigger locks and revalidates fulfillment before accepting
    // the consent event. Customer SELECT FOR UPDATE cannot pass the staff-only
    // UPDATE policy, so use the scoped read here and keep the trigger as the
    // concurrency boundary.
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, request.orderItemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Change request unavailable");
    if (!mayRequestContentChange({ requesterId: request.requestedByUserId, ordererId: request.requestedByUserId, handedOffAt: fulfillment.handedOffAt, state: fulfillment.state })) throw new Error("Review is closed after handoff");
    const events = await latestRequestEvents(tx, requestId);
    if (contentChangeStatus(events) !== "REQUESTED") throw new Error("Change request is no longer awaiting review");
    const current = await currentConsentedContent(tx, request.orderItemId);
    if (current.version !== request.baseVersion) throw new Error("The order content changed; refresh before reviewing");
    const [item] = await tx.select({ writingSelected: customerOrderItem.writingSelected }).from(customerOrderItem).where(eq(customerOrderItem.id, request.orderItemId)).limit(1);
    if (!item) throw new Error("Order item unavailable");
    const patch = Object.fromEntries(Object.entries({ targetUrl: request.targetUrl, anchorText: request.anchorText, articleText: request.articleText, instructions: request.instructions }).filter(([, value]) => value !== null)) as Record<string, unknown>;
    const [writing] = item.writingSelected ? await tx.select({ state: orderItemWriting.state }).from(orderItemWriting).where(eq(orderItemWriting.orderItemId, request.orderItemId)).limit(1) : [];
    const writingStopped = writing?.state === "CUSTOMER_DECLINED_FINAL";
    if (item.writingSelected && !writingStopped && !current.content.articleText) throw new Error("Review content changes after the customer approves the GPHKM Writing draft");
    const updated = mergeContentChange(current.content, validateContentChangePatch(patch, item.writingSelected, writingStopped));
    if (writingStopped && !updated.articleText) throw new Error("A complete customer article is required to continue this placement");
    if (decision === "REJECT") {
      await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId, eventType: "REJECTED", reason: reason.trim(), createdAt: new Date() });
      await appendAuditEvent(tx, { actorUserId: actor.userId, action: "ORDER_CONTENT_CHANGE_REJECTED", targetType: "CUSTOMER_ORDER_ITEM", targetId: request.orderItemId, reasonCode: "ADMIN_REVIEW", metadata: { result: "REJECTED", version: request.baseVersion } });
      return { requestId, status: "REJECTED" as const };
    }
    const [supplierRow] = await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId, email: supplierContact.email })
      .from(orderItemFulfillmentSupplier)
      .leftJoin(supplierContact, and(eq(supplierContact.supplierId, orderItemFulfillmentSupplier.supplierId), eq(supplierContact.isPrimary, true)))
      .where(eq(orderItemFulfillmentSupplier.orderItemId, request.orderItemId)).limit(1);
    const versionId = randomUUID();
    const supplierId = supplierRow?.supplierId ?? null;
    const recipientEmail = supplierRow?.email ?? "GPHKM_INTERNAL";
    const contentHash = hashOrderContent(updated, { supplierId, recipientEmail });
    const approvedAt = new Date();
    await tx.insert(orderItemContentVersion).values({
      id: versionId, orderItemId: request.orderItemId, requestId, version: current.version + 1,
      ...updated, supplierId, recipientEmail,
      contentHash, approvedByUserId: actor.userId, approvedAt,
    });
    await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId, eventType: "APPROVED", versionId, contentHash, createdAt: approvedAt });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "ORDER_CONTENT_CHANGE_APPROVED", targetType: "CUSTOMER_ORDER_ITEM", targetId: request.orderItemId, reasonCode: "ADMIN_REVIEW", metadata: { result: "AWAITING_CUSTOMER_CONSENT", version: current.version + 1 } });
    return { requestId, status: "APPROVED_AWAITING_CONSENT" as const, version: current.version + 1 };
  });
}

export async function consentToContentChange(headers: Headers, organizationId: string, requestId: string) {
  const correlationId = randomUUID();
  let stage = "INPUT_VALIDATION";
  try {
    if (!validId(requestId) || !organizationId || organizationId.length > 128) throw new Error("Content consent is unavailable");
    stage = "CUSTOMER_AUTH";
    const actor = await requireVerifiedCustomer(headers);
    stage = "ORGANIZATION_CONTEXT";
    return await withProtectedOrganizationContext(headers, organizationId, async (tx) => {
      stage = "REQUEST_LOOKUP";
      const [request] = await tx.select().from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.id, requestId)).limit(1);
      if (!request || request.requestedByUserId !== actor.userId) throw new Error("Content consent is unavailable");
      stage = "ORDERER_CHECK";
      const [orderRow] = await tx.select({ orderId: customerOrder.id, ordererId: customerOrder.actorUserId })
        .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
        .where(and(eq(customerOrderItem.id, request.orderItemId), eq(customerOrder.organizationId, organizationId))).limit(1);
      if (!orderRow || orderRow.ordererId !== actor.userId) throw new Error("Content consent is unavailable");
      const recipientReconsent = request.purpose === "RECIPIENT_RECONSENT";
      if (recipientReconsent) {
        // Match packet preparation's order -> supplier -> item lock order. The
        // scoped SECURITY DEFINER helper can see the current route without
        // exposing staff-only supplier data through customer RLS.
        stage = "RECIPIENT_LOCKS";
        await tx.execute(sql`select public.gphkm_lock_customer_recipient_reconsent(${requestId})`);
      }
      // The consent-event trigger locks this fulfillment row and rechecks that
      // handoff has not started. Customer row writes stay read-only until the
      // consent event, where the trigger revalidates this locked recipient.
      stage = "FULFILLMENT_GATE";
      const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, request.orderItemId)).limit(1);
      if (!fulfillment || (recipientReconsent
        ? fulfillment.state !== "HANDOFF_PENDING" || !fulfillment.handedOffAt || Boolean(fulfillment.workStartedAt)
        : fulfillment.handedOffAt || ["IN_FULFILLMENT", "PUBLICATION_PENDING", "EVIDENCE_REVIEW", "COMPLETED", "CANCELED_REFUNDED"].includes(fulfillment.state))) {
        throw new Error("Content consent is closed after handoff");
      }
      if (recipientReconsent) {
        stage = "RETRY_ELIGIBILITY";
        const eligibleResult = await tx.execute(sql`select public.gphkm_supplier_packet_retry_eligible(${request.orderItemId}, NULL) as eligible`);
        const eligible = (eligibleResult as unknown as { rows?: Array<{ eligible: boolean }> }).rows?.[0]?.eligible === true;
        if (!eligible) throw new Error("Recipient re-consent is no longer available");
      }
      stage = "APPROVED_CONTENT";
      const events = await latestRequestEvents(tx, requestId);
      if (contentChangeStatus(events) !== "APPROVED_AWAITING_CONSENT" || !events[0]?.versionId) throw new Error("No approved content version is awaiting consent");
      const consentRows = await tx.execute(sql`select version_id, version, content_hash from public.gphkm_customer_approved_content(${requestId}, ${actor.userId}, ${organizationId})`);
      const version = (consentRows as unknown as { rows?: Array<{ version_id: string; version: number; content_hash: string }> }).rows?.[0];
      if (!version || version.version_id !== events[0].versionId || version.content_hash !== events[0].contentHash) throw new Error("Approved content version is unavailable");
      stage = "CONSENT_EVENT_INSERT";
      await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId, eventType: "CONSENTED", versionId: version.version_id, contentHash: version.content_hash, noticeVersion: CONTENT_SHARING_NOTICE_VERSION, createdAt: new Date() });
      stage = "AUDIT_EVENT_INSERT";
      await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "ORDER_CONTENT_CHANGE_CONSENTED", targetType: "CUSTOMER_ORDER_ITEM", targetId: request.orderItemId, reasonCode: "SUPPLIER_SHARING_CONSENT", metadata: { result: "CONSENTED", version: version.version } });
      return { requestId, status: "CONSENTED" as const, version: version.version, purpose: request.purpose };
    });
  } catch (error) {
    logSafeFailure("customer_content_consent_failed", error, correlationId, { organizationId, reasonCode: stage });
    throw error;
  }
}

export type CustomerContentChange = Readonly<{
  id: string;
  requestNumber: number;
  purpose: string;
  status: ContentChangeStatus | "STALE";
  reviewNote: string | null;
  createdAt: Date;
  approvedContent: { version: number; targetUrl: string; anchorText: string; articleText: string | null; instructions: string } | null;
}>;

// Explicit safe projection for UI use; callers never spread database rows into responses.
export async function listContentChangesForCustomerBatch(headers: Headers, organizationId: string, itemIds: string[]): Promise<Map<string, CustomerContentChange[]>> {
  const ids = [...new Set(itemIds)];
  if (!organizationId || organizationId.length > 128 || ids.length > MAX_CUSTOMER_ORDERS_PAGE_ITEMS || ids.some((id) => !validId(id))) {
    throw new Error("Order content is unavailable");
  }
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const items = ids.length ? await tx.select({ itemId: customerOrderItem.id, state: orderItemFulfillment.state,
      handedOffAt: orderItemFulfillment.handedOffAt, workStartedAt: orderItemFulfillment.workStartedAt })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .where(and(inArray(customerOrderItem.id, ids), eq(customerOrder.organizationId, organizationId), eq(customerOrder.actorUserId, actor.userId))) : [];
    const changesByItem = new Map<string, CustomerContentChange[]>(items.map((item) => [item.itemId, []]));
    if (!items.length) return changesByItem;

    const rankedRequests = tx.select({ id: orderItemContentChangeRequest.id,
      itemId: orderItemContentChangeRequest.orderItemId, requestNumber: orderItemContentChangeRequest.requestNumber,
      purpose: orderItemContentChangeRequest.purpose, createdAt: orderItemContentChangeRequest.createdAt,
      rowNumber: sql<number>`row_number() over (partition by ${orderItemContentChangeRequest.orderItemId} order by ${orderItemContentChangeRequest.requestNumber} desc)`.as("row_number"),
    }).from(orderItemContentChangeRequest).where(inArray(orderItemContentChangeRequest.orderItemId, [...changesByItem.keys()])).as("ranked_customer_content_requests");
    const requests = await tx.select({ id: rankedRequests.id, itemId: rankedRequests.itemId,
      requestNumber: rankedRequests.requestNumber, purpose: rankedRequests.purpose, createdAt: rankedRequests.createdAt })
      .from(rankedRequests).where(lte(rankedRequests.rowNumber, 10))
      .orderBy(asc(rankedRequests.itemId), desc(rankedRequests.requestNumber));
    if (!requests.length) return changesByItem;

    const requestIds = requests.map((request) => request.id);
    const [latestEvents, approvedResult] = await Promise.all([
      tx.selectDistinctOn([orderItemContentChangeEvent.requestId], {
        requestId: orderItemContentChangeEvent.requestId, eventType: orderItemContentChangeEvent.eventType,
        reason: orderItemContentChangeEvent.reason,
      }).from(orderItemContentChangeEvent).where(inArray(orderItemContentChangeEvent.requestId, requestIds))
        .orderBy(orderItemContentChangeEvent.requestId, desc(orderItemContentChangeEvent.createdAt), desc(orderItemContentChangeEvent.id)),
      tx.execute(sql`select request.id as request_id, approved.version, approved.target_url, approved.anchor_text,
          approved.article_text, approved.instructions
        from public.order_item_content_change_request request
        left join lateral public.gphkm_customer_approved_content(request.id, ${actor.userId}, ${organizationId}) approved on true
        where request.id in (${sql.join(requestIds.map((requestId) => sql`${requestId}`), sql`, `)})`),
    ]);
    const eventByRequest = new Map(latestEvents.map((event) => [event.requestId, event]));
    const approvedRows = (approvedResult as unknown as { rows?: Array<{ request_id: string; version: number | null;
      target_url: string | null; anchor_text: string | null; article_text: string | null; instructions: string | null }> }).rows ?? [];
    const approvedByRequest = new Map(approvedRows.filter((row) => row.version !== null).map((row) => [row.request_id, row]));
    const itemById = new Map(items.map((item) => [item.itemId, item]));
    for (const request of requests) {
      const event = eventByRequest.get(request.id);
      const status = contentChangeStatus(event ? [event] : []);
      if (!status) continue;
      const approved = approvedByRequest.get(request.id);
      const item = itemById.get(request.itemId);
      const staleReconsent = request.purpose === "RECIPIENT_RECONSENT"
        && (status === "APPROVED_AWAITING_CONSENT" || status === "CONSENTED") && !approved
        && item?.state === "HANDOFF_PENDING" && item.handedOffAt !== null && item.workStartedAt === null;
      changesByItem.get(request.itemId)?.push({
        id: request.id, requestNumber: request.requestNumber, purpose: request.purpose,
        status: staleReconsent ? "STALE" : status,
        reviewNote: staleReconsent ? "The fulfillment contact or delivery status changed. This approval is no longer valid; wait for a refreshed request."
          : status === "REJECTED" ? event?.reason ?? null : null,
        createdAt: request.createdAt,
        approvedContent: approved ? { version: approved.version!, targetUrl: approved.target_url!,
          anchorText: approved.anchor_text!, articleText: approved.article_text, instructions: approved.instructions! } : null,
      });
    }
    return changesByItem;
  });
}

export async function listContentChangesForCustomer(headers: Headers, organizationId: string, itemId: string) {
  if (!validId(itemId)) throw new Error("Order item unavailable");
  const changes = await listContentChangesForCustomerBatch(headers, organizationId, [itemId]);
  return changes.get(itemId) ?? [];
}

export async function listContentChangesForStaff(headers: Headers, itemId: string) {
  if (!validId(itemId)) throw new Error("Order item unavailable");
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Order item unavailable");
    const requests = await tx.select().from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.orderItemId, itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(10);
    if (!requests.length) return [];
    const requestIds = requests.map((request) => request.id);
    const [latestEvents, versions, currentRoute, latestContentVersions] = await Promise.all([
      tx.selectDistinctOn([orderItemContentChangeEvent.requestId], {
        requestId: orderItemContentChangeEvent.requestId, id: orderItemContentChangeEvent.id,
        eventType: orderItemContentChangeEvent.eventType, versionId: orderItemContentChangeEvent.versionId,
        contentHash: orderItemContentChangeEvent.contentHash, noticeVersion: orderItemContentChangeEvent.noticeVersion,
        reason: orderItemContentChangeEvent.reason, createdAt: orderItemContentChangeEvent.createdAt,
        createdAtExact: sql<string>`to_char(${orderItemContentChangeEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      }).from(orderItemContentChangeEvent).where(inArray(orderItemContentChangeEvent.requestId, requestIds))
        .orderBy(orderItemContentChangeEvent.requestId, desc(orderItemContentChangeEvent.createdAt), desc(orderItemContentChangeEvent.id)),
      tx.select().from(orderItemContentVersion).where(inArray(orderItemContentVersion.requestId, requestIds)),
      tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId, recipientEmail: supplierContact.email })
        .from(orderItemFulfillmentSupplier)
        .leftJoin(supplierContact, and(eq(supplierContact.supplierId, orderItemFulfillmentSupplier.supplierId), eq(supplierContact.isPrimary, true)))
        .where(eq(orderItemFulfillmentSupplier.orderItemId, itemId)).limit(1),
      tx.select({ version: orderItemContentVersion.version }).from(orderItemContentVersion)
        .where(eq(orderItemContentVersion.orderItemId, itemId)).orderBy(desc(orderItemContentVersion.version)).limit(1),
    ]);
    const eventByRequest = new Map(latestEvents.map((event) => [event.requestId, event]));
    const versionByRequest = new Map(versions.map((version) => [version.requestId, version]));
    const route = currentRoute[0];
    const latestContentVersionNumber = latestContentVersions[0]?.version ?? null;
    return requests.map((request) => {
      const status = contentChangeStatus(eventByRequest.has(request.id) ? [eventByRequest.get(request.id)!] : []);
      const version = versionByRequest.get(request.id);
      const stale = isStaleRecipientReconsent({
        purpose: request.purpose, status, versionNumber: version?.version ?? null,
        latestContentVersionNumber, versionSupplierId: version?.supplierId ?? null,
        versionRecipientEmail: version?.recipientEmail ?? null, currentSupplierId: route?.supplierId ?? null,
        currentRecipientEmail: route?.recipientEmail ?? null, fulfillmentState: fulfillment.state,
        handedOffAt: fulfillment.handedOffAt, workStartedAt: fulfillment.workStartedAt,
      });
      const reviewNote = stale
        ? !version || !route || version.supplierId !== route.supplierId
          || version.recipientEmail.trim().toLowerCase() !== (route.recipientEmail ?? "").trim().toLowerCase()
          ? "This version is not bound to the current supplier contact. The orderer must approve a version for the current contact before a packet can be prepared."
          : status !== "CONSENTED" && (fulfillment.state !== "HANDOFF_PENDING" || fulfillment.workStartedAt !== null)
            ? "The handoff or work status changed. This recipient approval is no longer active."
            : status === "APPROVED_AWAITING_CONSENT" && latestContentVersionNumber !== null && version.version !== latestContentVersionNumber
              ? "A newer approved content version superseded this approval. Only the current version can be approved for a supplier packet."
              : "This re-consent has no current recipient-bound approval. Refresh it before preparing a supplier packet."
        : status === "REJECTED" ? eventByRequest.get(request.id)?.reason ?? null : null;
      return {
        id: request.id, requestNumber: request.requestNumber, status: stale ? "STALE" : status,
        reviewNote, requestedByUserId: request.requestedByUserId, createdAt: request.createdAt,
        patch: { targetUrl: request.targetUrl, anchorText: request.anchorText, articleText: request.articleText, instructions: request.instructions },
        approvedVersion: version ? { version: version.version, contentHash: version.contentHash, recipientEmail: version.recipientEmail, targetUrl: version.targetUrl, anchorText: version.anchorText, articleText: version.articleText, instructions: version.instructions } : null,
      };
    });
  });
}

// Packet builders call this inside their existing transaction before rendering
// or sending a packet. `null` means use the original immutable order snapshot.
export async function getConsentedSupplierPacketContent(tx: Tx, itemId: string) {
  const requests = await tx.select({ id: orderItemContentChangeRequest.id }).from(orderItemContentChangeRequest)
    .where(eq(orderItemContentChangeRequest.orderItemId, itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(1);
  if (requests[0]) {
    const latestRequestEventsForItem = await latestRequestEvents(tx, requests[0].id);
    if (contentChangeStatus(latestRequestEventsForItem) === "REQUESTED" || contentChangeStatus(latestRequestEventsForItem) === "APPROVED_AWAITING_CONSENT") {
      const [declinedEquivalent] = await tx.select({ id: orderItemEquivalentOffer.id }).from(orderItemEquivalentOffer)
        .innerJoin(orderItemEquivalentOfferEvent, eq(orderItemEquivalentOfferEvent.offerId, orderItemEquivalentOffer.id))
        .where(and(eq(orderItemEquivalentOffer.contentRequestId, requests[0].id), eq(orderItemEquivalentOfferEvent.eventType, "DECLINED"))).limit(1);
      if (!declinedEquivalent) throw new Error("Supplier packet is blocked until the latest customer content change is resolved");
    }
  }
  const [currentSupplier] = await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId, email: supplierContact.email })
    .from(orderItemFulfillmentSupplier)
    .leftJoin(supplierContact, and(eq(supplierContact.supplierId, orderItemFulfillmentSupplier.supplierId), eq(supplierContact.isPrimary, true)))
    .where(eq(orderItemFulfillmentSupplier.orderItemId, itemId)).limit(1);
  const currentSupplierId = currentSupplier?.supplierId ?? null;
  const recipientEmail = currentSupplier?.email ?? "GPHKM_INTERNAL";
  const versions = await tx.select().from(orderItemContentVersion).where(eq(orderItemContentVersion.orderItemId, itemId))
    .orderBy(desc(orderItemContentVersion.version)).limit(50);
  let latestVersion: (typeof versions)[number] | undefined;
  let events: Awaited<ReturnType<typeof latestRequestEvents>> = [];
  for (const version of versions) {
    const candidateEvents = await latestRequestEvents(tx, version.requestId);
    if (contentChangeStatus(candidateEvents) === "CONSENTED" && candidateEvents[0]?.versionId === version.id && candidateEvents[0]?.contentHash === version.contentHash &&
      version.supplierId === currentSupplierId && version.recipientEmail === recipientEmail) {
      latestVersion = version;
      events = candidateEvents;
      break;
    }
  }
  if (!latestVersion) {
    if (versions.length === 0) return null;
    throw new Error("Supplier packet is blocked until the customer consents to the exact approved content and recipient");
  }
  const matchingConsent = events.find((event) => event.eventType === "CONSENTED" && event.versionId === latestVersion!.id && event.contentHash === latestVersion!.contentHash);
  if (!matchingConsent) throw new Error("Supplier packet consent evidence is unavailable");
  const [acceptedEquivalent] = await tx.select({ terms: orderItemEquivalentOffer.terms })
    .from(orderItemEquivalentOffer).innerJoin(orderItemEquivalentOfferEvent, eq(orderItemEquivalentOfferEvent.offerId, orderItemEquivalentOffer.id))
    .where(and(eq(orderItemEquivalentOffer.contentRequestId, latestVersion.requestId),
      eq(orderItemEquivalentOfferEvent.eventType, "ACCEPTED"), eq(orderItemEquivalentOfferEvent.contentHash, latestVersion.contentHash)))
    .orderBy(desc(orderItemEquivalentOfferEvent.createdAt)).limit(1);
  return Object.freeze({
    version: latestVersion.version, targetUrl: latestVersion.targetUrl, anchorText: latestVersion.anchorText,
    articleText: latestVersion.articleText,
    instructions: latestVersion.instructions, supplierId: latestVersion.supplierId,
    recipientEmail: latestVersion.recipientEmail, contentHash: latestVersion.contentHash,
    noticeVersion: matchingConsent.noticeVersion, consentEventId: matchingConsent.id,
    consentedAt: matchingConsent.createdAtExact,
    ...(acceptedEquivalent ? { listingTerms: acceptedEquivalent.terms } : {}),
  });
}

const MAX_PACKET_CONTENT_VERSIONS_PER_ITEM = 50;

// Multi-item packet screens resolve consent in bounded queries. Keep the
// single-item helper above for commands whose scope is one item.
export async function getConsentedSupplierPacketContentBatch(tx: Tx, itemIds: string[]) {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return new Map();

  const rankedVersions = tx.select({
    id: orderItemContentVersion.id,
    itemId: orderItemContentVersion.orderItemId,
    requestId: orderItemContentVersion.requestId,
    version: orderItemContentVersion.version,
    targetUrl: orderItemContentVersion.targetUrl,
    anchorText: orderItemContentVersion.anchorText,
    articleText: orderItemContentVersion.articleText,
    instructions: orderItemContentVersion.instructions,
    supplierId: orderItemContentVersion.supplierId,
    recipientEmail: orderItemContentVersion.recipientEmail,
    contentHash: orderItemContentVersion.contentHash,
    rowNumber: sql<number>`row_number() over (partition by ${orderItemContentVersion.orderItemId} order by ${orderItemContentVersion.version} desc)`.as("row_number"),
  }).from(orderItemContentVersion).where(inArray(orderItemContentVersion.orderItemId, ids)).as("ranked_packet_content_versions");

  const latestRequests = await packetRead("LATEST_REQUESTS", () => tx.selectDistinctOn([orderItemContentChangeRequest.orderItemId], {
      itemId: orderItemContentChangeRequest.orderItemId,
      requestId: orderItemContentChangeRequest.id,
    }).from(orderItemContentChangeRequest)
      .where(inArray(orderItemContentChangeRequest.orderItemId, ids))
      .orderBy(orderItemContentChangeRequest.orderItemId, desc(orderItemContentChangeRequest.requestNumber), desc(orderItemContentChangeRequest.id)));
  const routes = await packetRead("CURRENT_ROUTES", () => tx.select({
      itemId: orderItemFulfillmentSupplier.orderItemId,
      supplierId: orderItemFulfillmentSupplier.supplierId,
      email: supplierContact.email,
    }).from(orderItemFulfillmentSupplier)
      .leftJoin(supplierContact, and(eq(supplierContact.supplierId, orderItemFulfillmentSupplier.supplierId), eq(supplierContact.isPrimary, true)))
      .where(inArray(orderItemFulfillmentSupplier.orderItemId, ids)));
  const versions = await packetRead("LATEST_VERSIONS", () => tx.select({
      id: rankedVersions.id,
      itemId: rankedVersions.itemId,
      requestId: rankedVersions.requestId,
      version: rankedVersions.version,
      targetUrl: rankedVersions.targetUrl,
      anchorText: rankedVersions.anchorText,
      articleText: rankedVersions.articleText,
      instructions: rankedVersions.instructions,
      supplierId: rankedVersions.supplierId,
      recipientEmail: rankedVersions.recipientEmail,
      contentHash: rankedVersions.contentHash,
    }).from(rankedVersions)
      .where(lte(rankedVersions.rowNumber, MAX_PACKET_CONTENT_VERSIONS_PER_ITEM))
      .orderBy(rankedVersions.itemId, desc(rankedVersions.version)));

  const requestIds = [...new Set([
    ...latestRequests.map((request) => request.requestId),
    ...versions.map((version) => version.requestId),
  ])];
  const latestEvents = requestIds.length ? await packetRead("LATEST_EVENTS", () => tx.selectDistinctOn([orderItemContentChangeEvent.requestId], {
      requestId: orderItemContentChangeEvent.requestId,
      eventType: orderItemContentChangeEvent.eventType,
      versionId: orderItemContentChangeEvent.versionId,
      contentHash: orderItemContentChangeEvent.contentHash,
      noticeVersion: orderItemContentChangeEvent.noticeVersion,
      id: orderItemContentChangeEvent.id,
      createdAt: orderItemContentChangeEvent.createdAt,
      createdAtExact: sql<string>`to_char(${orderItemContentChangeEvent.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(orderItemContentChangeEvent)
      .where(inArray(orderItemContentChangeEvent.requestId, requestIds))
      .orderBy(orderItemContentChangeEvent.requestId, desc(orderItemContentChangeEvent.createdAt), desc(orderItemContentChangeEvent.id))) : [];
  const declinedRequests = latestRequests.length ? await packetRead("DECLINED_OFFERS", () => tx.selectDistinctOn([orderItemEquivalentOffer.contentRequestId], {
      requestId: orderItemEquivalentOffer.contentRequestId,
    }).from(orderItemEquivalentOffer)
      .innerJoin(orderItemEquivalentOfferEvent, eq(orderItemEquivalentOfferEvent.offerId, orderItemEquivalentOffer.id))
      .where(and(inArray(orderItemEquivalentOffer.contentRequestId, latestRequests.map((request) => request.requestId)), eq(orderItemEquivalentOfferEvent.eventType, "DECLINED")))
      .orderBy(orderItemEquivalentOffer.contentRequestId)) : [];

  const selectedVersionHashes = versions.filter((version) => {
    const event = latestEvents.find((candidate) => candidate.requestId === version.requestId);
    const route = routes.find((candidate) => candidate.itemId === version.itemId);
    return event?.eventType === "CONSENTED" && event.versionId === version.id && event.contentHash === version.contentHash
      && version.supplierId === (route?.supplierId ?? null)
      && version.recipientEmail === (route?.email ?? "GPHKM_INTERNAL");
  });
  const acceptedEquivalentRows = selectedVersionHashes.length ? await packetRead("ACCEPTED_TERMS", () => tx.selectDistinctOn(
    [orderItemEquivalentOffer.contentRequestId, orderItemEquivalentOfferEvent.contentHash],
    {
      requestId: orderItemEquivalentOffer.contentRequestId,
      contentHash: orderItemEquivalentOfferEvent.contentHash,
      terms: orderItemEquivalentOffer.terms,
    },
  ).from(orderItemEquivalentOffer)
    .innerJoin(orderItemEquivalentOfferEvent, eq(orderItemEquivalentOfferEvent.offerId, orderItemEquivalentOffer.id))
    .where(and(
      eq(orderItemEquivalentOfferEvent.eventType, "ACCEPTED"),
      or(...selectedVersionHashes.map((version) => and(
        eq(orderItemEquivalentOffer.contentRequestId, version.requestId),
        eq(orderItemEquivalentOfferEvent.contentHash, version.contentHash),
      ))!),
    ))
    .orderBy(orderItemEquivalentOffer.contentRequestId, orderItemEquivalentOfferEvent.contentHash,
      desc(orderItemEquivalentOfferEvent.createdAt), desc(orderItemEquivalentOfferEvent.id))) : [];
  return resolvePacketContentRows({
    itemIds: ids,
    latestRequests,
    routes: routes.map((route) => ({ itemId: route.itemId, supplierId: route.supplierId, recipientEmail: route.email })),
    versions,
    latestEvents,
    declinedRequestIds: declinedRequests.map((request) => request.requestId),
    acceptedTerms: acceptedEquivalentRows,
  }) as Map<string, { content: BatchPacketContent | null; error?: Error }>;
}
