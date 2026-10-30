import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { listing, listingSourcing, listingUrl, supplier, supplierContact } from "@/db/catalog-schema";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier, orderItemWriting } from "@/db/order-schema";
import { orderItemContentChangeEvent, orderItemContentChangeRequest, orderItemContentVersion } from "@/db/change-request-schema";
import { orderItemEquivalentOffer, orderItemEquivalentOfferEvent, orderItemEquivalentOfferRoute } from "@/db/equivalent-offer-schema";
import { supportCase } from "@/db/support-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { mayReadFulfillmentContent } from "@/modules/fulfillment/console";
import { hashOrderContent, type OrderContent } from "@/modules/orders/content-changes";
import { CONTENT_SHARING_NOTICE_VERSION } from "@/modules/orders/checkout";
import { getConsentedSupplierPacketContent } from "@/server/orders/content-changes";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validId(value: string) { if (!UUID.test(value)) throw new Error("Equivalent offer is unavailable"); return value; }

async function staffTx<T>(headers: Headers, work: (tx: Tx, actor: { userId: string; role: "ADMIN" | "FINANCE" | "SUPER_ADMIN" }) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role === "FINANCE") throw new Error("Forbidden");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export async function listEquivalentOfferCandidates(headers: Headers, itemId: string) {
  validId(itemId);
  return staffTx(headers, async (tx, actor) => {
    const [item] = await tx.select({ assignedAdminId: orderItemFulfillment.assignedAdminId, currentSupplierId: orderItemFulfillmentSupplier.supplierId })
      .from(orderItemFulfillment).leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, orderItemFulfillment.orderItemId))
      .where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    if (!item || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: item.assignedAdminId })) throw new Error("Item unavailable");
    return tx.select({ id: listing.id, title: listing.title, websiteUrl: listingUrl.websiteUrl,
      supplierId: listingSourcing.fulfillmentSupplierId })
      .from(listing).innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .innerJoin(supplier, eq(supplier.id, listingSourcing.fulfillmentSupplierId))
      .where(and(eq(listing.status, "LIVE"), eq(supplier.status, "ACTIVE"), sql`${listingSourcing.fulfillmentSupplierId} is not null`,
        sql`${listingSourcing.fulfillmentSupplierId} <> ${item.currentSupplierId ?? ""}`))
      .orderBy(listing.title).limit(200);
  });
}

export async function createEquivalentOffer(headers: Headers, input: {
  itemId: string; caseId: string; listingId: string; equivalenceNote: string;
}) {
  validId(input.itemId); validId(input.caseId); validId(input.listingId);
  const equivalenceNote = input.equivalenceNote.trim();
  if (equivalenceNote.length < 5 || equivalenceNote.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(equivalenceNote)) throw new Error("Provide a customer-safe explanation of the alternative");
  return staffTx(headers, async (tx, actor) => {
    // Lock only the item, never the packet/case row. Packet sends lock packet then item;
    // refund decisions lock case then item. This avoids reversing either lock order.
    const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId }) ||
        ["COMPLETED", "CANCELED_REFUNDED"].includes(fulfillment.state)) throw new Error("Item unavailable");
    const [support] = await tx.select({ id: supportCase.id }).from(supportCase)
      .where(and(eq(supportCase.id, input.caseId), eq(supportCase.orderItemId, input.itemId), sql`${supportCase.state} not in ('RESOLVED','CLOSED')`)).limit(1);
    if (!support) throw new Error("An active item Support case is required");
    const [itemRow] = await tx.select({ item: customerOrderItem, order: customerOrder })
      .from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, input.itemId), eq(customerOrder.checkoutState, "PAID"))).limit(1);
    if (!itemRow) throw new Error("Paid order item unavailable");
    const [replacement] = await tx.select({
      listingRow: listing, websiteUrl: listingUrl.websiteUrl,
      supplierId: listingSourcing.fulfillmentSupplierId, contactEmail: supplierContact.email,
    }).from(listing).innerJoin(listingUrl, eq(listingUrl.listingId, listing.id))
      .innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .innerJoin(supplier, eq(supplier.id, listingSourcing.fulfillmentSupplierId))
      .innerJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
      .where(and(eq(listing.id, input.listingId), eq(listing.status, "LIVE"), eq(supplier.status, "ACTIVE"))).limit(1);
    const [currentRoute] = await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId })
      .from(orderItemFulfillmentSupplier).where(eq(orderItemFulfillmentSupplier.orderItemId, input.itemId)).limit(1);
    if (!replacement?.supplierId || replacement.supplierId === currentRoute?.supplierId || !replacement.contactEmail) throw new Error("Select a live alternative with an active fulfillment contact");

    const existing = await tx.select({ id: orderItemEquivalentOffer.id }).from(orderItemEquivalentOffer)
      .where(eq(orderItemEquivalentOffer.orderItemId, input.itemId)).orderBy(desc(orderItemEquivalentOffer.createdAt)).limit(20);
    for (const offer of existing) {
      const [latest] = await tx.select({ eventType: orderItemEquivalentOfferEvent.eventType }).from(orderItemEquivalentOfferEvent)
        .where(eq(orderItemEquivalentOfferEvent.offerId, offer.id)).orderBy(desc(orderItemEquivalentOfferEvent.createdAt), desc(orderItemEquivalentOfferEvent.id)).limit(1);
      if (latest?.eventType === "OFFERED") throw new Error("Resolve the pending equivalent offer first");
    }

    let content: OrderContent;
    const currentConsented = await getConsentedSupplierPacketContent(tx, input.itemId);
    if (currentConsented) {
      content = { targetUrl: currentConsented.targetUrl, anchorText: currentConsented.anchorText,
        articleText: currentConsented.articleText, instructions: currentConsented.instructions };
    } else {
      const item = itemRow.item;
      let articleText = item.articleText;
      if (item.writingSelected) {
        const [writing] = await tx.select({ state: orderItemWriting.state, approvedArticleText: orderItemWriting.approvedArticleText })
          .from(orderItemWriting).where(eq(orderItemWriting.orderItemId, item.id)).limit(1);
        if (!writing || !["APPROVED_FIRST", "APPROVED_FINAL"].includes(writing.state) || !writing.approvedArticleText) throw new Error("Customer-approved writing content is required before an equivalent offer");
        articleText = writing.approvedArticleText;
      }
      if (!articleText) throw new Error("Approved publication content is unavailable");
      content = { targetUrl: item.targetUrl, anchorText: item.anchorText, articleText, instructions: "" };
    }
    const previous = await tx.select({ version: orderItemContentVersion.version }).from(orderItemContentVersion)
      .where(eq(orderItemContentVersion.orderItemId, input.itemId)).orderBy(desc(orderItemContentVersion.version)).limit(1);
    const currentVersion = previous[0]?.version ?? 1;
    const nextVersion = Number(currentVersion) + 1;
    const now = new Date();
    const requestId = randomUUID();
    const versionId = randomUUID();
    const offerId = randomUUID();
    const requestNumberRows = await tx.select({ requestNumber: orderItemContentChangeRequest.requestNumber }).from(orderItemContentChangeRequest)
      .where(eq(orderItemContentChangeRequest.orderItemId, input.itemId)).orderBy(desc(orderItemContentChangeRequest.requestNumber)).limit(1);
    const requestNumber = (requestNumberRows[0]?.requestNumber ?? 0) + 1;
    const boundHash = hashOrderContent(content, { supplierId: replacement.supplierId, recipientEmail: replacement.contactEmail });
    const lockedPriceMinor = (BigInt(itemRow.item.placementPriceMinor) + BigInt(itemRow.item.writingPriceMinor)).toString();
    await tx.insert(orderItemContentChangeRequest).values({
      id: requestId, orderItemId: input.itemId, requestNumber, requestedByUserId: itemRow.order.actorUserId,
      baseVersion: currentVersion, targetUrl: content.targetUrl, anchorText: content.anchorText,
      articleText: content.articleText, instructions: content.instructions || null,
      targetSupplierId: replacement.supplierId, createdAt: now,
    });
    await tx.insert(orderItemContentVersion).values({
      id: versionId, orderItemId: input.itemId, requestId, version: nextVersion,
      targetUrl: content.targetUrl, anchorText: content.anchorText, articleText: content.articleText,
      instructions: content.instructions, supplierId: replacement.supplierId, recipientEmail: replacement.contactEmail,
      contentHash: boundHash, approvedByUserId: actor.userId, approvedAt: now,
    });
    await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId, actorUserId: actor.userId,
      eventType: "APPROVED", versionId, contentHash: boundHash, createdAt: now });
    const l = replacement.listingRow;
    const terms = {
      title: l.title, websiteUrl: replacement.websiteUrl, description: l.description, categories: l.categories,
      countryCode: l.countryCode, language: l.primaryLanguage, linkType: l.linkType, linkValidity: l.linkValidity,
      turnaroundDays: l.turnaroundDays, buyerRequirements: l.buyerRequirements,
      sponsoredContentMarking: l.sponsoredContentMarking,
    };
    await tx.insert(orderItemEquivalentOffer).values({
      id: offerId, orderItemId: input.itemId, supportCaseId: input.caseId, contentRequestId: requestId,
      contentVersionId: versionId, title: l.title, websiteUrl: replacement.websiteUrl, description: l.description,
      equivalenceNote, categories: l.categories, countryCode: l.countryCode, language: l.primaryLanguage,
      linkType: l.linkType, linkValidity: l.linkValidity, turnaroundDays: l.turnaroundDays,
      buyerRequirements: l.buyerRequirements, sponsoredContentMarking: l.sponsoredContentMarking,
      terms, lockedPriceMinor, offeredByUserId: actor.userId, createdAt: now,
    });
    await tx.insert(orderItemEquivalentOfferRoute).values({ offerId, supplierId: replacement.supplierId,
      recipientEmail: replacement.contactEmail, contentHash: boundHash, createdAt: now });
    await tx.insert(orderItemEquivalentOfferEvent).values({ id: randomUUID(), offerId, actorUserId: actor.userId,
      eventType: "OFFERED", contentHash: boundHash, createdAt: now });
    if (fulfillment.state !== "ON_HOLD") {
      await tx.update(orderItemFulfillment).set({ state: "ON_HOLD", stateBeforeHold: fulfillment.state, updatedAt: now })
        .where(eq(orderItemFulfillment.orderItemId, input.itemId));
    }
    await appendAuditEvent(tx, { organizationId: itemRow.order.organizationId, actorUserId: actor.userId,
      action: "SUPPLIER_EQUIVALENT_OFFER_CREATED", targetType: "CUSTOMER_ORDER_ITEM", targetId: input.itemId,
      reasonCode: "SUPPLIER_FAILURE", metadata: { result: "AWAITING_CUSTOMER_DECISION", offerId, lockedPriceMinor } });
    return { offerId, lockedPriceMinor };
  });
}

export async function listCustomerEquivalentOffers(headers: Headers, organizationId: string, itemIds: string[]) {
  const actor = await requireVerifiedCustomer(headers);
  if (itemIds.length === 0) return [];
  if (itemIds.length > 100 || itemIds.some((id) => !UUID.test(id))) throw new Error("Equivalent offers are unavailable");
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const rows = await tx.select().from(orderItemEquivalentOffer).where(inArray(orderItemEquivalentOffer.orderItemId, itemIds))
      .orderBy(orderItemEquivalentOffer.createdAt);
    const result = [];
    for (const row of rows) {
      const events = await tx.select({ eventType: orderItemEquivalentOfferEvent.eventType, createdAt: orderItemEquivalentOfferEvent.createdAt })
        .from(orderItemEquivalentOfferEvent).where(eq(orderItemEquivalentOfferEvent.offerId, row.id))
        .orderBy(orderItemEquivalentOfferEvent.createdAt, orderItemEquivalentOfferEvent.id);
      const latest = events.at(-1)?.eventType ?? "OFFERED";
      const [order] = await tx.select({ ordererId: customerOrder.actorUserId }).from(customerOrderItem)
        .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
        .where(and(eq(customerOrderItem.id, row.orderItemId), eq(customerOrder.organizationId, organizationId))).limit(1);
      result.push({
        id: row.id, orderItemId: row.orderItemId, title: row.title, websiteUrl: row.websiteUrl,
        description: row.description, equivalenceNote: row.equivalenceNote, categories: row.categories,
        countryCode: row.countryCode, language: row.language, linkType: row.linkType,
        linkValidity: row.linkValidity, turnaroundDays: row.turnaroundDays, buyerRequirements: row.buyerRequirements,
        sponsoredContentMarking: row.sponsoredContentMarking, lockedPriceMinor: row.lockedPriceMinor,
        status: latest, canDecide: latest === "OFFERED" && order?.ordererId === actor.userId,
        createdAt: row.createdAt,
      });
    }
    return result;
  });
}

export async function decideCustomerEquivalentOffer(headers: Headers, organizationId: string, input: {
  offerId: string; decision: "ACCEPT" | "DECLINE"; reason?: string;
}) {
  validId(input.offerId);
  if (input.decision !== "ACCEPT" && input.decision !== "DECLINE") throw new Error("Equivalent offer unavailable");
  const reason = (input.reason ?? "").trim();
  if (input.decision === "DECLINE" && (reason.length < 2 || reason.length > 1000)) throw new Error("Add a brief reason");
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const lockResult = await tx.execute(sql`select public.gphkm_lock_equivalent_offer_item(${input.offerId}, ${actor.userId}, ${organizationId}) as item_id`);
    const lockedItemId = (lockResult as unknown as { rows?: Array<{ item_id: string }> }).rows?.[0]?.item_id;
    if (!lockedItemId) throw new Error("Equivalent offer unavailable");
    const [offer] = await tx.select().from(orderItemEquivalentOffer).where(eq(orderItemEquivalentOffer.id, input.offerId)).limit(1);
    if (!offer) throw new Error("Equivalent offer unavailable");
    if (offer.orderItemId !== lockedItemId) throw new Error("Equivalent offer unavailable");
    const [item] = await tx.select({ ordererId: customerOrder.actorUserId }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, offer.orderItemId), eq(customerOrder.organizationId, organizationId))).limit(1);
    if (!item || item.ordererId !== actor.userId) throw new Error("Only the ordering customer can decide this offer");
    const [latest] = await tx.select({ eventType: orderItemEquivalentOfferEvent.eventType }).from(orderItemEquivalentOfferEvent)
      .where(eq(orderItemEquivalentOfferEvent.offerId, offer.id)).orderBy(desc(orderItemEquivalentOfferEvent.createdAt), desc(orderItemEquivalentOfferEvent.id)).limit(1);
    if (latest?.eventType !== "OFFERED") throw new Error("This equivalent offer was already resolved");
    const consentResult = await tx.execute(sql`select * from public.gphkm_customer_equivalent_offer_consent_data(${offer.id}, ${actor.userId}, ${organizationId})`);
    const route = (consentResult as unknown as { rows?: Array<{ supplier_id: string; recipient_email: string; content_hash: string; request_id: string; version_id: string }> }).rows?.[0];
    if (!route) throw new Error("Equivalent offer consent data is unavailable");
    const now = new Date();
    if (input.decision === "DECLINE") {
      await tx.insert(orderItemEquivalentOfferEvent).values({ id: randomUUID(), offerId: offer.id, actorUserId: actor.userId,
        eventType: "DECLINED", reason, createdAt: now });
      const [fulfillment] = await tx.select().from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, offer.orderItemId)).limit(1);
      if (fulfillment?.state === "ON_HOLD" && fulfillment.stateBeforeHold && !fulfillment.handedOffAt) {
        await tx.update(orderItemFulfillment).set({ state: fulfillment.stateBeforeHold, stateBeforeHold: null, updatedAt: now })
          .where(eq(orderItemFulfillment.orderItemId, offer.orderItemId));
      }
      await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "SUPPLIER_EQUIVALENT_OFFER_DECLINED",
        targetType: "CUSTOMER_ORDER_ITEM", targetId: offer.orderItemId, metadata: { result: "DECLINED", offerId: offer.id } });
      return { state: "DECLINED" as const };
    }
    await tx.insert(orderItemEquivalentOfferEvent).values({ id: randomUUID(), offerId: offer.id, actorUserId: actor.userId,
      eventType: "ACCEPTED", contentHash: route.content_hash, noticeVersion: CONTENT_SHARING_NOTICE_VERSION, createdAt: now });
    await tx.insert(orderItemContentChangeEvent).values({ id: randomUUID(), requestId: route.request_id,
      actorUserId: actor.userId, eventType: "CONSENTED", versionId: route.version_id,
      contentHash: route.content_hash, noticeVersion: CONTENT_SHARING_NOTICE_VERSION, createdAt: now });
    await tx.execute(sql`select public.gphkm_apply_equivalent_offer_acceptance(${offer.id}, ${actor.userId}, ${organizationId})`);
    await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "SUPPLIER_EQUIVALENT_OFFER_ACCEPTED",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: offer.orderItemId, reasonCode: "FRESH_PARTNER_CONSENT",
      metadata: { result: "ACCEPTED", offerId: offer.id, lockedPriceMinor: offer.lockedPriceMinor } });
    return { state: "ACCEPTED" as const };
  });
}
