import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier, orderItemWriting } from "@/db/order-schema";
import { orderItemContentChangeEvent, orderItemContentChangeRequest, orderItemContentVersion } from "@/db/change-request-schema";
import { orderItemEquivalentOffer, orderItemEquivalentOfferEvent } from "@/db/equivalent-offer-schema";
import { supplierContact } from "@/db/catalog-schema";
import { requireStaffAccess } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { appendAuditEvent } from "@/server/audit/append";
import { contentChangeStatus, hashOrderContent, mayRequestContentChange, mergeContentChange, validateContentChangePatch, type OrderContent } from "@/modules/orders/content-changes";
import { mayReadFulfillmentContent } from "@/modules/fulfillment/console";
import { CONTENT_SHARING_NOTICE_VERSION } from "@/modules/orders/checkout";

const validId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toContent(row: { targetUrl: string; anchorText: string; articleText: string | null; instructions?: string | null }): OrderContent {
  return Object.freeze({ targetUrl: row.targetUrl, anchorText: row.anchorText, articleText: row.articleText, instructions: row.instructions ?? "" });
}

async function latestRequestEvents(tx: Tx, requestId: string) {
  return tx.select({ eventType: orderItemContentChangeEvent.eventType, versionId: orderItemContentChangeEvent.versionId, contentHash: orderItemContentChangeEvent.contentHash, noticeVersion: orderItemContentChangeEvent.noticeVersion, reason: orderItemContentChangeEvent.reason, createdAt: orderItemContentChangeEvent.createdAt })
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
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, itemId)).for("update").limit(1);
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
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, request.orderItemId)).for("update").limit(1);
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
  if (!validId(requestId) || !organizationId || organizationId.length > 128) throw new Error("Content consent is unavailable");
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const [request] = await tx.select().from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.id, requestId)).limit(1);
    if (!request || request.requestedByUserId !== actor.userId) throw new Error("Content consent is unavailable");
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, request.orderItemId)).for("update").limit(1);
    if (!fulfillment || fulfillment.handedOffAt || ["IN_FULFILLMENT", "PUBLICATION_PENDING", "EVIDENCE_REVIEW", "COMPLETED", "CANCELED_REFUNDED"].includes(fulfillment.state)) throw new Error("Content consent is closed after handoff");
    const events = await latestRequestEvents(tx, requestId);
    if (contentChangeStatus(events) !== "APPROVED_AWAITING_CONSENT" || !events[0]?.versionId) throw new Error("No approved content version is awaiting consent");
    const consentRows = await tx.execute(sql`select version_id, version, content_hash from public.gphkm_customer_approved_content(${requestId}, ${actor.userId}, ${organizationId})`);
    const version = (consentRows as unknown as { rows?: Array<{ version_id: string; version: number; content_hash: string }> }).rows?.[0];
    if (!version || version.version_id !== events[0].versionId || version.content_hash !== events[0].contentHash) throw new Error("Approved content version is unavailable");
    await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId, eventType: "CONSENTED", versionId: version.version_id, contentHash: version.content_hash, noticeVersion: CONTENT_SHARING_NOTICE_VERSION, createdAt: new Date() });
    await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "ORDER_CONTENT_CHANGE_CONSENTED", targetType: "CUSTOMER_ORDER_ITEM", targetId: request.orderItemId, reasonCode: "SUPPLIER_SHARING_CONSENT", metadata: { result: "CONSENTED", version: version.version } });
    return { requestId, status: "CONSENTED" as const, version: version.version };
  });
}

// Explicit safe projection for UI use; callers never spread database rows into responses.
export async function listContentChangesForCustomer(headers: Headers, organizationId: string, itemId: string) {
  if (!validId(itemId)) throw new Error("Order item unavailable");
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [item] = await tx.select({ ordererId: customerOrder.actorUserId, writingSelected: customerOrderItem.writingSelected })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId)).where(and(eq(customerOrderItem.id, itemId), eq(customerOrder.organizationId, organizationId))).limit(1);
    if (!item || item.ordererId !== actor.userId) return [];
    const requests = await tx.select({ id: orderItemContentChangeRequest.id, requestNumber: orderItemContentChangeRequest.requestNumber, createdAt: orderItemContentChangeRequest.createdAt })
      .from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.orderItemId, itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(10);
    const result = [];
    for (const request of requests) {
      const events = await latestRequestEvents(tx, request.id);
      const status = contentChangeStatus(events);
      const contentResult = status === "APPROVED_AWAITING_CONSENT" || status === "CONSENTED"
        ? await tx.execute(sql`select version, target_url, anchor_text, article_text, instructions from public.gphkm_customer_approved_content(${request.id}, ${actor.userId}, ${organizationId})`)
        : null;
      const versions = contentResult ? (contentResult as unknown as { rows?: Array<{ version: number; target_url: string; anchor_text: string; article_text: string | null; instructions: string }> }).rows ?? [] : [];
      result.push({ id: request.id, requestNumber: request.requestNumber, status, reviewNote: status === "REJECTED" ? events[0]?.reason ?? null : null, createdAt: request.createdAt, approvedContent: versions[0] ? { version: versions[0].version, targetUrl: versions[0].target_url, anchorText: versions[0].anchor_text, articleText: versions[0].article_text, instructions: versions[0].instructions } : null });
    }
    return result;
  });
}

export async function listContentChangesForStaff(headers: Headers, itemId: string) {
  if (!validId(itemId)) throw new Error("Order item unavailable");
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) throw new Error("Order item unavailable");
    const requests = await tx.select().from(orderItemContentChangeRequest).where(eq(orderItemContentChangeRequest.orderItemId, itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(10);
    const result = [];
    for (const request of requests) {
      const events = await latestRequestEvents(tx, request.id);
      const status = contentChangeStatus(events);
      const version = status === "APPROVED_AWAITING_CONSENT" || status === "CONSENTED" ? (await tx.select().from(orderItemContentVersion).where(eq(orderItemContentVersion.requestId, request.id)).limit(1))[0] : null;
      result.push({ id: request.id, requestNumber: request.requestNumber, status, requestedByUserId: request.requestedByUserId, createdAt: request.createdAt, patch: { targetUrl: request.targetUrl, anchorText: request.anchorText, articleText: request.articleText, instructions: request.instructions }, approvedVersion: version ? { version: version.version, contentHash: version.contentHash, recipientEmail: version.recipientEmail, targetUrl: version.targetUrl, anchorText: version.anchorText, articleText: version.articleText, instructions: version.instructions } : null });
    }
    return result;
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
    noticeVersion: matchingConsent.noticeVersion, consentedAt: matchingConsent.createdAt,
    ...(acceptedEquivalent ? { listingTerms: acceptedEquivalent.terms } : {}),
  });
}
