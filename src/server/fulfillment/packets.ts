import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, exists, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import { getResendWebhookDb } from "@/db/resend-webhook";
import { customerOrder, customerOrderItem, orderItemFulfillment, orderItemFulfillmentSupplier, orderItemWriting } from "@/db/order-schema";
import { supplierPacket, supplierPacketAcknowledgement, supplierPacketAttempt, supplierPacketAttemptEvent, supplierPacketItem, supplierPacketManualEvidence, supplierPacketProviderEvent } from "@/db/packet-schema";
import { supplier, supplierContact } from "@/db/catalog-schema";
import { assertCompletePacketReplacement, assertPacketActionable, buildSupplierPacket, mayAccessSupplierPacket, mayStartManualPacketHandoff, monotonicProviderAttemptState, parseExplicitInstant, recordManualExportAttempt, recordManualHandoff, renderSupplierEmail, resolveUnknownAttempt, startPacketAttempt, supplierShareContentHash, transitionItem, type ItemState, type PacketAttempt, type PacketAttemptState, type PacketItemInput, type SupplierPacket } from "@/modules/fulfillment/workflow";
import { requireStaffAccess } from "@/server/auth/staff";
import { appendAuditEvent } from "@/server/audit/append";
import { MAX_SUPPLIER_PACKET_BYTES } from "@/modules/fulfillment/packet-policy";
import { correlateResendAttempt } from "@/modules/fulfillment/resend-correlation";
import { staffCatalogPagination } from "@/modules/catalog/pagination";
import { buildSupplierPacketPdf } from "@/server/fulfillment/pdf";
import { getConsentedSupplierPacketContent } from "@/server/orders/content-changes";
import { deletePrivateFile, readPrivateFile, savePrivateFile } from "@/server/storage/private-files";
import { readSmallJsonResponse } from "@/modules/security/small-json-response";

type Actor = { userId: string; role: "ADMIN" | "FINANCE" | "SUPER_ADMIN" };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const MAX_ITEMS = 25;
// ponytail: fixed 10-minute recovery heuristic; tune only from observed provider latency, never treat as supplier SLA.
const STUCK_SEND_REVIEW_AFTER_MS = 10 * 60 * 1000;
const WEBHOOK_TYPES = ["email.delivered", "email.bounced", "email.failed", "email.delivery_delayed"] as const;
const RESEND_ATTEMPT_TAG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(value: string) { return /^[0-9a-f-]{36}$/i.test(value); }
function txActor(tx: Tx, actor: Actor) { return tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`); }

async function staffTx<T>(headers: Headers, work: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role === "FINANCE") throw new Error("Forbidden");
  return db.transaction(async (tx) => { await txActor(tx, actor); return work(tx, actor); });
}

async function requirePacketAssignment(tx: Tx, packetId: string, actor: Actor) {
  const assignments = await tx.select({
    packetAdminId: supplierPacketItem.assignedAdminId,
    currentAdminId: orderItemFulfillment.assignedAdminId,
  }).from(supplierPacketItem)
    .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, supplierPacketItem.orderItemId))
    .where(eq(supplierPacketItem.packetId, packetId))
    .for("share", { of: orderItemFulfillment });
  if (!mayAccessSupplierPacket({ actorId: actor.userId, actorRole: actor.role, assignments })) {
    throw new Error("Packet unavailable");
  }
}

function jsonPacket(value: unknown): SupplierPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Packet snapshot unavailable");
  return value as SupplierPacket;
}

function placementRequirements(snapshot: Record<string, unknown>): string[] {
  const requirements = [
    typeof snapshot.linkType === "string" ? `Link type: ${snapshot.linkType}` : null,
    typeof snapshot.linkValidity === "string" ? `Placement term: ${snapshot.linkValidity}` : null,
    snapshot.sponsoredContentMarking === true ? "Mark the article as sponsored content." : null,
    typeof snapshot.buyerRequirements === "string" && snapshot.buyerRequirements.trim() ? snapshot.buyerRequirements.trim() : null,
  ].filter((value): value is string => value !== null);
  return requirements.length ? requirements : ["Follow the agreed publication requirements."];
}

function publicationInstructions(customerInstructions: string | null | undefined): string {
  return customerInstructions?.trim() ?? "";
}

function packetItemInput(input: {
  itemId: string; orderId: string; organizationId: string; supplierId: string; assignedAdminId: string;
  listingSnapshot: Record<string, unknown>; targetUrl: string; anchorText: string; article: string;
  instructions: string; consentNoticeVersion: string; consentedAt: Date; recipient: string;
}): PacketItemInput {
  const content = {
    placementRequirements: placementRequirements(input.listingSnapshot),
    targetUrl: input.targetUrl,
    anchorText: input.anchorText,
    article: input.article,
    instructions: input.instructions,
  };
  return {
    orderItemId: input.itemId,
    organizationId: input.organizationId,
    orderId: input.orderId,
    supplierId: input.supplierId,
    assignedAdminId: input.assignedAdminId,
    reference: `GPH-${input.orderId.slice(0, 8).toUpperCase()}-${input.itemId.slice(0, 8).toUpperCase()}`,
    ...content,
    approvedArticle: input.article.length > 0,
    consent: {
      disclosureVersion: input.consentNoticeVersion,
      contentHash: supplierShareContentHash(content),
      supplierId: input.supplierId,
      recipient: input.recipient.trim().toLowerCase(),
      acceptedAt: input.consentedAt.toISOString(),
    },
  };
}

export async function listPacketCandidates(headers: Headers, orderId: string) {
  if (!validId(orderId)) throw new Error("Order unavailable");
  return staffTx(headers, async (tx, actor) => {
    const rows = await tx.select({
      orderItemId: customerOrderItem.id,
      orderId: customerOrder.id,
      listingTitle: orderItemFulfillment.listingTitle,
      state: orderItemFulfillment.state,
      assignedAdminId: orderItemFulfillment.assignedAdminId,
      writingSelected: customerOrderItem.writingSelected,
      writingState: orderItemWriting.state,
      articleReady: sql<boolean>`case when ${customerOrderItem.writingSelected} then ${orderItemWriting.state} in ('APPROVED_FIRST','APPROVED_FINAL') and ${orderItemWriting.approvedArticleText} is not null else ${customerOrderItem.articleText} is not null end`,
      supplierId: orderItemFulfillmentSupplier.supplierId,
      consent: customerOrderItem.supplierSharingConsented,
      consentNoticeVersion: customerOrderItem.consentNoticeVersion,
    }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemWriting, eq(orderItemWriting.orderItemId, customerOrderItem.id))
      .where(eq(customerOrderItem.orderId, orderId)).orderBy(asc(customerOrderItem.createdAt));
    const scopedRows = actor.role === "ADMIN" ? rows.filter((row) => row.assignedAdminId === actor.userId) : rows;
    return Promise.all(scopedRows.map(async (row) => {
      let contentAvailable = true;
      let consentedContent: Awaited<ReturnType<typeof getConsentedSupplierPacketContent>> = null;
      if (row.supplierId) {
        try { consentedContent = await getConsentedSupplierPacketContent(tx, row.orderItemId); }
        catch { contentAvailable = false; }
      }
      const replacementArticleReady = row.writingState === "CUSTOMER_DECLINED_FINAL" && Boolean(consentedContent?.articleText);
      return {
        ...row,
        eligible: row.state === "READY_FOR_HANDOFF" && row.assignedAdminId !== null && row.supplierId !== null
          && (row.articleReady || replacementArticleReady) && row.consent && contentAvailable && (actor.role === "SUPER_ADMIN" || row.assignedAdminId === actor.userId),
        blockReason: !contentAvailable ? "Resolve the content review and obtain consent for the exact supplier recipient first." :
          row.writingSelected && !row.articleReady && !replacementArticleReady ? "GPHKM Writing must have a customer-approved article before handoff." :
          !row.assignedAdminId ? "Assign an Admin before preparing a packet." :
          !row.supplierId ? "This item uses internal fulfillment and has no supplier packet." :
          row.state !== "READY_FOR_HANDOFF" ? "Move the item to ready for handoff first." : null,
      };
    }));
  });
}

export async function prepareSupplierPackets(headers: Headers, orderId: string, itemIds: string[]) {
  if (!validId(orderId) || itemIds.length < 1 || itemIds.length > MAX_ITEMS || itemIds.some((value) => !validId(value)) || new Set(itemIds).size !== itemIds.length) throw new Error("Select one to 25 distinct order items");
  return staffTx(headers, async (tx, actor) => {
    const [lockedOrder] = await tx.select({ id: customerOrder.id, organizationId: customerOrder.organizationId, createdAt: customerOrder.createdAt, checkoutState: customerOrder.checkoutState })
      .from(customerOrder).where(eq(customerOrder.id, orderId)).for("update").limit(1);
    if (!lockedOrder || lockedOrder.checkoutState !== "PAID") throw new Error("Order unavailable");
    const linkedRows = await tx.select({ packetId: supplierPacketItem.packetId }).from(supplierPacketItem)
      .innerJoin(supplierPacket, eq(supplierPacket.id, supplierPacketItem.packetId))
      .where(and(eq(supplierPacket.orderId, orderId), inArray(supplierPacketItem.orderItemId, itemIds), sql`${supplierPacket.supersededAt} is null`));
    const linkedPacketIds = [...new Set(linkedRows.map((row) => row.packetId))].sort();
    const priorPackets = linkedPacketIds.length ? await tx.select().from(supplierPacket)
      .where(inArray(supplierPacket.id, linkedPacketIds)).orderBy(asc(supplierPacket.id)).for("update") : [];
    const selectedItems = new Set(itemIds);
    for (const prior of priorPackets) {
      const priorItems = await tx.select({ orderItemId: supplierPacketItem.orderItemId }).from(supplierPacketItem)
        .where(eq(supplierPacketItem.packetId, prior.id));
      assertCompletePacketReplacement(priorItems.map(({ orderItemId }) => orderItemId), selectedItems);
      await tx.update(supplierPacket).set({ supersededAt: new Date() }).where(eq(supplierPacket.id, prior.id));
      await appendAuditEvent(tx, { organizationId: prior.organizationId, actorUserId: actor.userId,
        action: "SUPPLIER_PACKET_SUPERSEDED", targetType: "SUPPLIER_PACKET", targetId: prior.id,
        reasonCode: "REPLACEMENT_VERSION_PREPARED", metadata: { version: prior.version, result: "SUPERSEDED" } });
    }
    const rows = await tx.select({
      item: customerOrderItem,
      order: customerOrder,
      fulfillment: orderItemFulfillment,
      supplierId: orderItemFulfillmentSupplier.supplierId,
      writing: orderItemWriting,
    }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemWriting, eq(orderItemWriting.orderItemId, customerOrderItem.id))
      .where(and(eq(customerOrderItem.orderId, orderId), inArray(customerOrderItem.id, itemIds)))
      .orderBy(asc(customerOrderItem.id)).for("update", { of: orderItemFulfillment });
    if (rows.length !== itemIds.length) throw new Error("One or more items are unavailable");
    const groups = new Map<string, typeof rows>();
    const packetContentByItem = new Map<string, Awaited<ReturnType<typeof getConsentedSupplierPacketContent>>>();
    for (const row of rows) {
      const f = row.fulfillment;
      if (f.state !== "READY_FOR_HANDOFF" || !f.assignedAdminId || !row.supplierId || !row.item.supplierSharingConsented) throw new Error("Every selected item must be ready, assigned, consented, and supplier-sourced for fulfillment");
      if (actor.role === "ADMIN" && f.assignedAdminId !== actor.userId) throw new Error("Admin may prepare only currently assigned items");
      const consentedContent = await getConsentedSupplierPacketContent(tx, row.item.id);
      const approvedArticle = row.item.writingSelected
        ? row.writing?.state === "APPROVED_FIRST" || row.writing?.state === "APPROVED_FINAL" ? row.writing.approvedArticleText
          : row.writing?.state === "CUSTOMER_DECLINED_FINAL" ? consentedContent?.articleText ?? null : null
        : row.item.articleText;
      if (!approvedArticle) throw new Error("Writing items require a customer-approved article before handoff");
      packetContentByItem.set(row.item.id, consentedContent);
      const groupKey = `${row.supplierId}:${f.assignedAdminId}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
    }
    const packetIds: string[] = [];
    for (const group of groups.values()) {
      const supplierId = group[0]?.supplierId;
      if (!supplierId) throw new Error("Supplier assignment is unavailable");
      const [supplierRow] = await tx.select({ id: supplier.id, name: supplier.name, email: supplierContact.email })
        .from(supplier).innerJoin(supplierContact, and(eq(supplierContact.supplierId, supplier.id), eq(supplierContact.isPrimary, true)))
        .where(eq(supplier.id, supplierId)).limit(1);
      if (!supplierRow?.email) throw new Error("Supplier primary contact is unavailable");
      const packetId = `pkt_${randomUUID()}`;
      const [latest] = await tx.select({ version: supplierPacket.version }).from(supplierPacket)
        .where(and(eq(supplierPacket.orderId, orderId), eq(supplierPacket.supplierId, supplierId)))
        .orderBy(desc(supplierPacket.version)).limit(1).for("update");
      const version = (latest?.version ?? 0) + 1;
      const createdAt = new Date().toISOString();
      const packet = buildSupplierPacket({
        packetId, version, createdBy: actor.userId, createdByRole: actor.role, createdAt, recipient: supplierRow.email,
        items: group.map(({ item, order, fulfillment, supplierId: itemSupplierId, writing }) => packetItemInput({
          itemId: item.id, orderId: order.id, organizationId: order.organizationId, supplierId: itemSupplierId!,
          assignedAdminId: fulfillment.assignedAdminId!, listingSnapshot: packetContentByItem.get(item.id)?.listingTerms ?? item.customerListingSnapshot,
          targetUrl: packetContentByItem.get(item.id)?.targetUrl ?? item.targetUrl,
          anchorText: packetContentByItem.get(item.id)?.anchorText ?? item.anchorText,
          article: item.writingSelected ? (writing?.state === "CUSTOMER_DECLINED_FINAL" ? packetContentByItem.get(item.id)?.articleText ?? "" : writing?.approvedArticleText ?? "") : packetContentByItem.get(item.id)?.articleText ?? item.articleText!,
          instructions: packetContentByItem.get(item.id)?.instructions ?? publicationInstructions(item.instructions),
          consentNoticeVersion: packetContentByItem.get(item.id)?.noticeVersion ?? item.consentNoticeVersion,
          consentedAt: packetContentByItem.get(item.id)?.consentedAt ?? item.consentedAt, recipient: supplierRow.email!,
        })),
      });
      await tx.insert(supplierPacket).values({
        id: packet.id, version, organizationId: packet.organizationId, orderId: packet.orderId,
        supplierId: packet.supplierId, recipient: packet.recipient, packet: packet as unknown as Record<string, unknown>,
        contentHash: packet.contentHash, createdByUserId: actor.userId,
      });
      await tx.insert(supplierPacketItem).values(group.map(({ item, fulfillment }) => {
        const packetItem = packet.items.find((part) => part.orderItemId === item.id)!;
        return {
          packetId, orderItemId: item.id, assignedAdminId: fulfillment.assignedAdminId!,
          consentNoticeVersion: packetItem.consent.disclosureVersion,
          consentedAt: new Date(packetItem.consent.acceptedAt),
          consentContentHash: packetItem.consent.contentHash,
        };
      }));
      for (const { item, order, fulfillment } of group) {
        const transition = transitionItem({
          item: { id: item.id, organizationId: order.organizationId, orderId: order.id, orderedByUserId: order.actorUserId,
            state: fulfillment.state as ItemState, updatedAt: fulfillment.updatedAt.toISOString(), purchasedAt: order.createdAt.toISOString(),
            totalPaidMinor: 0, currency: "USD" },
          to: "HANDOFF_PENDING", actorId: actor.userId, actorType: "STAFF", actorRole: actor.role,
          assignedAdminId: fulfillment.assignedAdminId ?? undefined, at: createdAt, reason: "PACKET_PREPARED", eventId: randomUUID(),
        });
        await tx.update(orderItemFulfillment).set({ state: transition.item.state, updatedAt: new Date(createdAt) }).where(eq(orderItemFulfillment.orderItemId, item.id));
        await appendAuditEvent(tx, { organizationId: order.organizationId, actorUserId: actor.userId, action: "FULFILLMENT_STATE_CHANGED", targetType: "CUSTOMER_ORDER_ITEM", targetId: item.id, reasonCode: "PACKET_PREPARED", metadata: { fromState: transition.event.from, toState: transition.event.to, result: "UPDATED" } });
      }
      await appendAuditEvent(tx, { organizationId: lockedOrder.organizationId, actorUserId: actor.userId, action: "SUPPLIER_PACKET_PREPARED", targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { version, itemCount: packet.items.length, result: "READY" } });
      packetIds.push(packetId);
    }
    return packetIds;
  });
}

export async function getSupplierPacket(headers: Headers, packetId: string) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(packetId)) throw new Error("Packet unavailable");
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, packetId)).limit(1);
    if (!row) throw new Error("Packet unavailable");
    await requirePacketAssignment(tx, packetId, actor);
    const packet = await loadCurrentPacket(tx, row);
    const [contact] = await tx.select({ name: supplier.name, status: supplier.status })
      .from(supplier).where(eq(supplier.id, row.supplierId)).limit(1);
    const [contactRow] = await tx.select({ name: supplierContact.name, email: supplierContact.email })
      .from(supplierContact).where(and(eq(supplierContact.supplierId, row.supplierId), eq(supplierContact.isPrimary, true))).limit(1);
    const attempts = await tx.select().from(supplierPacketAttempt)
      .where(eq(supplierPacketAttempt.packetId, packetId)).orderBy(desc(supplierPacketAttempt.createdAt));
    const [acknowledgement] = await tx.select().from(supplierPacketAcknowledgement)
      .where(eq(supplierPacketAcknowledgement.packetId, packetId)).limit(1);
    const manualEvidence = await tx.select({ id: supplierPacketManualEvidence.id, attemptId: supplierPacketManualEvidence.attemptId,
      fileKind: supplierPacketManualEvidence.fileKind, createdAt: supplierPacketManualEvidence.createdAt })
      .from(supplierPacketManualEvidence).where(eq(supplierPacketManualEvidence.packetId, packetId)).orderBy(desc(supplierPacketManualEvidence.createdAt));
    const events = attempts.length ? await tx.select().from(supplierPacketAttemptEvent)
      .where(inArray(supplierPacketAttemptEvent.attemptId, attempts.map((attempt) => attempt.id)))
      .orderBy(desc(supplierPacketAttemptEvent.createdAt)) : [];
    const providerEvents = attempts.length ? await tx.select().from(supplierPacketProviderEvent)
      .where(inArray(supplierPacketProviderEvent.attemptId, attempts.map((attempt) => attempt.id))) : [];
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_PREVIEWED", targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { version: row.version, itemCount: packet.items.length, result: "ALLOWED" } });
    const stuckAttemptIds = attempts
      .filter((attempt) => attempt.type === "SEND" && attempt.state === "SENDING" && Date.now() - attempt.createdAt.getTime() >= STUCK_SEND_REVIEW_AFTER_MS)
      .map((attempt) => attempt.id);
    return { packet, holdReason: row.holdReason, heldAt: row.heldAt, supplier: contact ? { name: contact.name, contactName: contactRow?.name ?? null, email: row.recipient } : null, attempts, acknowledgement: acknowledgement ?? null, manualEvidence, events, providerEvents, stuckAttemptIds, actorId: actor.userId, actorRole: actor.role, superseded: row.supersededAt !== null };
  });
}

export async function recordSupplierAcknowledgement(headers: Headers, input: { packetId: string; attemptId: string; reference: string }) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(input.packetId) || !validId(input.attemptId)
      || !input.reference.trim() || input.reference.trim().length > 320 || /[\r\n\0]/.test(input.reference)) {
    throw new Error("Supplier acknowledgement details are invalid");
  }
  return staffTx(headers, async (tx, actor) => {
    await requirePacketAssignment(tx, input.packetId, actor);
    const [attempt] = await tx.select().from(supplierPacketAttempt)
      .where(and(eq(supplierPacketAttempt.id, input.attemptId), eq(supplierPacketAttempt.packetId, input.packetId)))
      .for("update").limit(1);
    if (!attempt || !((attempt.type === "SEND" && attempt.state === "DELIVERED" && attempt.deliveredAt)
      || ((attempt.type === "MANUAL_SENT" || attempt.type === "MANUAL_SEND") && attempt.state === "MANUAL_SENT" && attempt.sentAt))) {
      throw new Error("Only a confirmed delivery or recorded manual handoff can be acknowledged");
    }
    const at = new Date();
    const [record] = await tx.insert(supplierPacketAcknowledgement).values({
      packetId: input.packetId, attemptId: input.attemptId, recordedByUserId: actor.userId,
      acknowledgedAt: at, reference: input.reference.trim(),
    }).onConflictDoNothing().returning({ packetId: supplierPacketAcknowledgement.packetId });
    if (!record) throw new Error("Supplier acknowledgement was already recorded for this packet");
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ACKNOWLEDGEMENT_RECORDED", targetType: "SUPPLIER_PACKET", targetId: input.packetId, reasonCode: "SUPPLIER_ACKNOWLEDGED", metadata: { attemptId: input.attemptId, acknowledgedAt: at.toISOString(), result: "RECORDED" } });
    return { packetId: input.packetId, acknowledgedAt: at };
  });
}

function packetAttemptProjection(row: typeof supplierPacketAttempt.$inferSelect, version: number): PacketAttempt {
  return {
    id: row.id, packetId: row.packetId, packetVersion: version, actorId: row.actorUserId,
    recipient: row.recipient, state: row.state as PacketAttemptState,
    createdAt: row.createdAt.toISOString(),
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.toISOString() } : {}),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt.toISOString() } : {}),
    ...(row.providerReference ? { providerReference: row.providerReference } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
    ...(row.unknownAt ? { unknownAt: row.unknownAt.toISOString() } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
  };
}

async function clearResolvedPacketSizeHold(tx: Tx, packetRow: typeof supplierPacket.$inferSelect, actorId: string) {
  if (packetRow.holdReason !== "PACKET_SIZE_REVIEW") return;
  await tx.update(supplierPacket).set({ holdReason: null, heldAt: null })
    .where(eq(supplierPacket.id, packetRow.id));
  await appendAuditEvent(tx, {
    actorUserId: actorId,
    action: "SUPPLIER_PACKET_SIZE_HOLD_CLEARED",
    targetType: "SUPPLIER_PACKET",
    targetId: packetRow.id,
    reasonCode: "REVIEWED_WITHIN_LIMIT",
    metadata: { version: packetRow.version, result: "CLEARED" },
  });
}

async function markItemsHandedOff(tx: Tx, input: { itemIds: string[]; actorId: string; actorRole: "ADMIN" | "SUPER_ADMIN"; at: Date; reason: string }) {
  const rows = await tx.select({ fulfillment: orderItemFulfillment, order: customerOrder })
    .from(orderItemFulfillment).innerJoin(customerOrder, eq(customerOrder.id, orderItemFulfillment.orderId))
    .where(inArray(orderItemFulfillment.orderItemId, input.itemIds)).orderBy(asc(orderItemFulfillment.orderItemId)).for("update", { of: orderItemFulfillment });
  if (rows.length !== input.itemIds.length) throw new Error("Packet items are unavailable");
  for (const row of rows) {
    if (row.fulfillment.state === "IN_FULFILLMENT") continue;
    if (row.fulfillment.state !== "HANDOFF_PENDING") throw new Error("Item workflow changed while packet was in transit");
    const change = transitionItem({
      item: { id: row.fulfillment.orderItemId, organizationId: row.order.organizationId, orderId: row.order.id, orderedByUserId: row.order.actorUserId, state: "HANDOFF_PENDING", updatedAt: row.fulfillment.updatedAt.toISOString(), purchasedAt: row.order.createdAt.toISOString(), totalPaidMinor: 0, currency: "USD" },
      to: "IN_FULFILLMENT", actorId: input.actorId, actorType: "STAFF", actorRole: input.actorRole,
      assignedAdminId: row.fulfillment.assignedAdminId ?? undefined, at: input.at.toISOString(), reason: input.reason, eventId: randomUUID(),
    });
    await tx.update(orderItemFulfillment).set({ state: change.item.state, customerStatus: "IN_PROGRESS", handedOffAt: row.fulfillment.handedOffAt ?? input.at, workStartedAt: input.at, updatedAt: input.at }).where(eq(orderItemFulfillment.orderItemId, row.fulfillment.orderItemId));
    await appendAuditEvent(tx, { organizationId: row.order.organizationId, actorUserId: input.actorId, action: "FULFILLMENT_STATE_CHANGED", targetType: "CUSTOMER_ORDER_ITEM", targetId: row.fulfillment.orderItemId, reasonCode: input.reason, metadata: { fromState: change.event.from, toState: change.event.to, result: "HANDED_OFF" } });
  }
}

async function lockPacketFulfillmentRows(tx: Tx, packet: SupplierPacket) {
  const itemIds = packet.items.map((item) => item.orderItemId);
  if (!itemIds.length) throw new Error("Packet has no order items");
  const rows = await tx.select({ orderItemId: orderItemFulfillment.orderItemId, state: orderItemFulfillment.state,
    handedOffAt: orderItemFulfillment.handedOffAt, workStartedAt: orderItemFulfillment.workStartedAt })
    .from(orderItemFulfillment).where(inArray(orderItemFulfillment.orderItemId, itemIds))
    .orderBy(asc(orderItemFulfillment.orderItemId)).for("update");
  if (rows.length !== itemIds.length || rows.some((item) => !["HANDOFF_PENDING", "IN_FULFILLMENT"].includes(item.state))) {
    throw new Error("Packet items changed before handoff; reconcile the item state first");
  }
  return rows;
}

async function recordProviderAcceptanceCutoff(tx: Tx, input: { itemIds: string[]; actorId: string; acceptedAt: Date }) {
  const rows = await tx.select({ fulfillment: orderItemFulfillment, order: customerOrder })
    .from(orderItemFulfillment).innerJoin(customerOrder, eq(customerOrder.id, orderItemFulfillment.orderId))
    .where(inArray(orderItemFulfillment.orderItemId, input.itemIds)).orderBy(asc(orderItemFulfillment.orderItemId)).for("update", { of: orderItemFulfillment });
  if (rows.length !== input.itemIds.length) throw new Error("Packet items are unavailable");
  for (const row of rows) {
    if (row.fulfillment.handedOffAt) continue;
    if (row.fulfillment.state !== "HANDOFF_PENDING") throw new Error("Provider acceptance does not match the current item state");
    await tx.update(orderItemFulfillment).set({ handedOffAt: input.acceptedAt, updatedAt: input.acceptedAt }).where(eq(orderItemFulfillment.orderItemId, row.fulfillment.orderItemId));
    await appendAuditEvent(tx, { organizationId: row.order.organizationId, actorUserId: input.actorId, action: "SUPPLIER_HANDOFF_CUTOFF_SET", targetType: "CUSTOMER_ORDER_ITEM", targetId: row.fulfillment.orderItemId, reasonCode: "PROVIDER_ACCEPTED", metadata: { result: "CANCELLATION_LOCKED" } });
  }
}

async function recordWebhookAcceptanceCutoff(tx: Tx, input: { itemIds: string[]; organizationId: string; acceptedAt: Date }) {
  const rows = await tx.select().from(orderItemFulfillment)
    .where(inArray(orderItemFulfillment.orderItemId, input.itemIds))
    .orderBy(asc(orderItemFulfillment.orderItemId)).for("update");
  if (rows.length !== input.itemIds.length) throw new Error("Packet items are unavailable");
  for (const row of rows) {
    if (row.handedOffAt) continue;
    if (row.state !== "HANDOFF_PENDING") throw new Error("Provider acceptance does not match the current item state");
    await tx.update(orderItemFulfillment).set({ handedOffAt: input.acceptedAt, updatedAt: input.acceptedAt })
      .where(eq(orderItemFulfillment.orderItemId, row.orderItemId));
    await appendAuditEvent(tx, {
      organizationId: input.organizationId, actorUserId: null, action: "SUPPLIER_HANDOFF_CUTOFF_SET",
      targetType: "CUSTOMER_ORDER_ITEM", targetId: row.orderItemId, reasonCode: "PROVIDER_ACCEPTED",
      metadata: { result: "CANCELLATION_LOCKED" },
    });
  }
}

async function loadCurrentPacket(tx: Tx, row: typeof supplierPacket.$inferSelect): Promise<SupplierPacket> {
  const stored = jsonPacket(row.packet);
  const links = await tx.select({ item: customerOrderItem, order: customerOrder, fulfillment: orderItemFulfillment, supplierId: orderItemFulfillmentSupplier.supplierId, writing: orderItemWriting })
    .from(supplierPacketItem).innerJoin(customerOrderItem, eq(customerOrderItem.id, supplierPacketItem.orderItemId))
    .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
    .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
    .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, customerOrderItem.id))
    .leftJoin(orderItemWriting, eq(orderItemWriting.orderItemId, customerOrderItem.id))
    .where(eq(supplierPacketItem.packetId, row.id)).orderBy(asc(customerOrderItem.id));
  const [contact] = await tx.select({ email: supplierContact.email }).from(supplierContact)
    .where(and(eq(supplierContact.supplierId, row.supplierId), eq(supplierContact.isPrimary, true))).limit(1);
  if (!contact || contact.email.trim().toLowerCase() !== row.recipient.trim().toLowerCase() || links.length !== stored.items.length) throw new Error("Packet recipient or included items changed; prepare a new version and obtain fresh consent");
  const rebuilt = buildSupplierPacket({
    packetId: row.id, version: row.version, createdBy: row.createdByUserId, createdByRole: "SUPER_ADMIN",
    createdAt: row.createdAt.toISOString(), recipient: contact.email,
    items: await Promise.all(links.map(async ({ item, order, fulfillment, supplierId, writing }) => {
      const consentedContent = await getConsentedSupplierPacketContent(tx, item.id);
      if (!supplierId || supplierId !== row.supplierId || order.id !== row.orderId || order.organizationId !== row.organizationId
        || !["HANDOFF_PENDING", "IN_FULFILLMENT"].includes(fulfillment.state) || !fulfillment.assignedAdminId || !item.supplierSharingConsented
        || (consentedContent?.noticeVersion ?? item.consentNoticeVersion) !== stored.items.find((part) => part.orderItemId === item.id)?.consent.disclosureVersion) throw new Error("Packet item is no longer eligible; prepare a new version and obtain fresh consent");
      const article = item.writingSelected
        ? writing?.state === "APPROVED_FIRST" || writing?.state === "APPROVED_FINAL" ? writing.approvedArticleText
          : writing?.state === "CUSTOMER_DECLINED_FINAL" ? consentedContent?.articleText ?? null : null
        : item.articleText;
      if (!article) throw new Error("The customer-approved final article is no longer available");
      const versionArticle = item.writingSelected ? article : consentedContent?.articleText ?? article;
      return packetItemInput({
        itemId: item.id, orderId: order.id, organizationId: order.organizationId, supplierId,
        assignedAdminId: fulfillment.assignedAdminId, listingSnapshot: consentedContent?.listingTerms ?? item.customerListingSnapshot,
        targetUrl: consentedContent?.targetUrl ?? item.targetUrl,
        anchorText: consentedContent?.anchorText ?? item.anchorText, article: versionArticle,
        instructions: consentedContent?.instructions ?? publicationInstructions(item.instructions),
        consentNoticeVersion: consentedContent?.noticeVersion ?? item.consentNoticeVersion,
        consentedAt: consentedContent?.consentedAt ?? item.consentedAt, recipient: contact.email,
      });
    })),
  });
  if (rebuilt.contentHash !== row.contentHash) throw new Error("Packet content changed after preview; create a new packet version and obtain fresh consent");
  return rebuilt;
}

function resendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const webhookId = process.env.RESEND_WEBHOOK_ID;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const publicBase = process.env.GPHKM_PUBLIC_BASE_URL;
  const dataApproved = process.env.GPHKM_RESEND_DATA_HANDLING_APPROVED === "true";
  if (!apiKey || !from || !webhookId || !webhookSecret || !publicBase || !dataApproved || /[\r\n\0]/.test(from)) return null;
  const address = /<([^<>]+)>/.exec(from)?.[1] ?? from;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  let base: URL;
  try { base = new URL(publicBase); } catch { return null; }
  if (base.protocol !== "https:" && base.hostname !== "localhost") return null;
  return { apiKey, from, senderDomain: address.slice(address.lastIndexOf("@") + 1).toLowerCase(), webhookId, webhookSecret, webhookUrl: new URL("/api/webhooks/resend", base).toString() };
}

export function resendEnvConfigured(): boolean { return resendConfig() !== null; }

async function resendPreflight(config: NonNullable<ReturnType<typeof resendConfig>>) {
  const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" };
  const domainsResponse = await fetch("https://api.resend.com/domains", { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!domainsResponse.ok) throw new Error("Resend account verification failed");
  const domainsPayload = await readSmallJsonResponse<{ data?: Array<{ name?: string; status?: string; capabilities?: { sending?: string } }> }>(domainsResponse);
  const domainVerified = domainsPayload.data?.some((domain) => domain.name?.toLowerCase() === config.senderDomain
    && domain.status === "verified" && domain.capabilities?.sending === "enabled");
  if (!domainVerified) throw new Error("Configured sender domain is not verified for sending");
  const webhookResponse = await fetch(`https://api.resend.com/webhooks/${encodeURIComponent(config.webhookId)}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!webhookResponse.ok) throw new Error("Resend webhook registration is unavailable");
  const webhookPayload = await readSmallJsonResponse<{ endpoint?: string; events?: string[]; signing_secret?: string }>(webhookResponse);
  if (webhookPayload.endpoint !== config.webhookUrl || !WEBHOOK_TYPES.every((event) => webhookPayload.events?.includes(event))
    || webhookPayload.signing_secret !== config.webhookSecret) throw new Error("Resend webhook configuration is incomplete");
  return config;
}

async function transitionPacketAttempt(input: { attemptId: string; state: PacketAttemptState; eventCode: string; actorId: string | null; actorRole?: "ADMIN" | "SUPER_ADMIN"; actorKind: "STAFF" | "PROVIDER"; providerReference?: string; acceptedAt?: Date; deliveredAt?: Date; unknownAt?: Date; resolvedAt?: Date; packetId: string; itemIds: string[] }) {
  return db.transaction(async (tx) => {
    if (input.actorId) await txActor(tx, { userId: input.actorId, role: input.actorRole ?? "ADMIN" });
    else await tx.execute(sql`select set_config('app.resend_webhook_verified', 'true', true)`);
    const [attempt] = await tx.select().from(supplierPacketAttempt).where(eq(supplierPacketAttempt.id, input.attemptId)).for("update").limit(1);
    if (!attempt) throw new Error("Attempt unavailable");
    if (input.providerReference && attempt.providerReference && attempt.providerReference !== input.providerReference) {
      throw new Error("Conflicting provider message reference requires reconciliation");
    }
    const state = input.actorKind === "STAFF"
      ? monotonicProviderAttemptState(attempt.state as PacketAttemptState, input.state)
      : input.state;
    if (attempt.state !== state) {
      await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: input.actorId, actorKind: input.actorKind, fromState: attempt.state, toState: state, reasonCode: input.eventCode, reference: input.providerReference ?? null });
    }
    await tx.update(supplierPacketAttempt).set({
      state,
      providerReference: input.providerReference ?? attempt.providerReference,
      acceptedAt: state === input.state ? input.acceptedAt ?? attempt.acceptedAt : attempt.acceptedAt,
      deliveredAt: state === input.state ? input.deliveredAt ?? attempt.deliveredAt : attempt.deliveredAt,
      unknownAt: state === input.state ? input.unknownAt ?? attempt.unknownAt : attempt.unknownAt,
      resolvedAt: state === input.state ? input.resolvedAt ?? attempt.resolvedAt : attempt.resolvedAt,
      updatedAt: new Date(),
    }).where(eq(supplierPacketAttempt.id, attempt.id));
    if (state === "DELIVERED" || state === "MANUAL_SENT") {
      const at = input.acceptedAt ?? input.deliveredAt ?? attempt.sentAt ?? new Date();
      await markItemsHandedOff(tx, { itemIds: input.itemIds, actorId: input.actorId ?? attempt.actorUserId, actorRole: input.actorRole ?? "SUPER_ADMIN", at, reason: input.eventCode });
    }
    if (state === "ACCEPTED") await recordProviderAcceptanceCutoff(tx, { itemIds: input.itemIds, actorId: input.actorId ?? attempt.actorUserId, acceptedAt: input.acceptedAt ?? attempt.acceptedAt ?? new Date() });
    if (input.actorId) await appendAuditEvent(tx, { actorUserId: input.actorId, action: "SUPPLIER_PACKET_ATTEMPT_UPDATED", targetType: "SUPPLIER_PACKET_ATTEMPT", targetId: attempt.id, reasonCode: input.eventCode, metadata: { fromState: attempt.state, toState: state, result: attempt.state === state && input.state !== state ? "STALE_PROVIDER_RESPONSE_IGNORED" : "UPDATED" } });
    return { id: attempt.id, state };
  });
}

export async function sendSupplierPacket(headers: Headers, packetId: string, resendReason = "", attachPdf = false) {
  const authorized = await requireStaffAccess(headers, "fulfillment.manage");
  if (authorized.role === "FINANCE") throw new Error("Forbidden");
  const config = resendConfig();
  if (!config) throw new Error("Resend is not fully configured or approved");
  await resendPreflight(config);
  const prepared = await staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, packetId)).for("update").limit(1);
    if (!row) throw new Error("Packet unavailable");
    assertPacketActionable({ superseded: row.supersededAt !== null, holdReason: row.holdReason }, true);
    await requirePacketAssignment(tx, packetId, actor);
    await lockPacketFulfillmentRows(tx, jsonPacket(row.packet));
    const packet = await loadCurrentPacket(tx, row);
    const attemptId = randomUUID();
    const pdf = attachPdf ? await buildSupplierPacketPdf(packet) : null;
    const rendered = renderSupplierEmail(packet, Number.MAX_SAFE_INTEGER, pdf ?? undefined);
    const payloadJson = JSON.stringify({ from: config.from, to: [row.recipient], subject: rendered.subject, text: rendered.text, tags: [{ name: "gphkm_packet_attempt", value: attemptId }], ...(pdf ? { attachments: [{ filename: `${packetId}-instructions.pdf`, content: Buffer.from(pdf).toString("base64") }] } : {}) });
    if (Buffer.byteLength(rendered.text, "utf8") + (pdf?.byteLength ?? 0) > MAX_SUPPLIER_PACKET_BYTES || Buffer.byteLength(rendered.eml, "utf8") > MAX_SUPPLIER_PACKET_BYTES || Buffer.byteLength(payloadJson, "utf8") > MAX_SUPPLIER_PACKET_BYTES) {
      await tx.update(supplierPacket).set({ holdReason: "PACKET_SIZE_REVIEW", heldAt: new Date() }).where(eq(supplierPacket.id, packetId));
      return { sizeHeld: true as const };
    }
    const existingRows = await tx.select().from(supplierPacketAttempt).where(eq(supplierPacketAttempt.packetId, packetId));
    const attempts = existingRows.filter((a) => a.type === "SEND" || a.type === "MANUAL_SENT" || a.type === "MANUAL_SEND").map((attempt) => packetAttemptProjection(attempt, row.version));
    const idempotencyKey = `gphkm-packet-${attemptId}`;
    const sendAttempt = startPacketAttempt({ packet, id: attemptId, actorId: actor.userId, actorRole: actor.role, attempts, revalidatedPacketHash: packet.contentHash, currentRecipient: row.recipient, at: new Date().toISOString(), deliberateResend: resendReason.trim().length > 0, resendReason });
    await tx.insert(supplierPacketAttempt).values({ id: sendAttempt.id, packetId, type: "SEND", state: "SENDING", actorUserId: actor.userId, recipient: row.recipient, idempotencyKey, resendReason: resendReason.trim() || null, provider: "RESEND" });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId, actorUserId: actor.userId, actorKind: "STAFF", fromState: null, toState: "SENDING", reasonCode: resendReason.trim() ? "DELIBERATE_RESEND" : "INITIAL_SEND" });
    await clearResolvedPacketSizeHold(tx, row, actor.userId);
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_SEND_STARTED", targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { version: row.version, itemCount: packet.items.length, result: "SENDING", ...(resendReason ? { reasonCode: "DELIBERATE_RESEND" } : {}) } });
    return { sizeHeld: false as const, packet, row, attemptId, idempotencyKey, actorId: actor.userId, rendered, pdf, payloadJson };
  });
  if (prepared.sizeHeld) throw new Error("Packet is over the 5 MiB limit and is held for staff review. It was not sent.");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": prepared.idempotencyKey },
      body: prepared.payloadJson,
    });
  } catch {
    const result = await transitionPacketAttempt({ attemptId: prepared.attemptId, state: "UNKNOWN", eventCode: "PROVIDER_OUTCOME_UNKNOWN", actorId: prepared.actorId, actorKind: "STAFF", unknownAt: new Date(), packetId, itemIds: prepared.packet.items.map((item) => item.orderItemId) });
    return { state: result.state };
  }
  if (!response.ok) {
    const knownFailure = response.status >= 400 && response.status < 500;
    const state = knownFailure ? "RECONCILED_FAILED" : "UNKNOWN";
    const result = await transitionPacketAttempt({ attemptId: prepared.attemptId, state, eventCode: knownFailure ? "PROVIDER_REJECTED" : "PROVIDER_OUTCOME_UNKNOWN", actorId: prepared.actorId, actorKind: "STAFF", ...(knownFailure ? { resolvedAt: new Date() } : { unknownAt: new Date() }), packetId, itemIds: prepared.packet.items.map((item) => item.orderItemId) });
    return { state: result.state };
  }
  let providerReference: string | undefined;
  try { providerReference = (await readSmallJsonResponse<{ id?: string }>(response)).id; } catch { }
  if (!providerReference || /[\r\n\0]/.test(providerReference)) {
    const result = await transitionPacketAttempt({ attemptId: prepared.attemptId, state: "UNKNOWN", eventCode: "PROVIDER_RESPONSE_AMBIGUOUS", actorId: prepared.actorId, actorKind: "STAFF", unknownAt: new Date(), packetId, itemIds: prepared.packet.items.map((item) => item.orderItemId) });
    return { state: result.state };
  }
  const result = await transitionPacketAttempt({ attemptId: prepared.attemptId, state: "ACCEPTED", eventCode: "PROVIDER_ACCEPTED", actorId: prepared.actorId, actorKind: "STAFF", providerReference, acceptedAt: new Date(), packetId, itemIds: prepared.packet.items.map((item) => item.orderItemId) });
  return { state: result.state };
}

export async function exportSupplierPacketEml(headers: Headers, packetId: string, attachPdf = false) {
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, packetId)).for("update").limit(1);
    if (!row) throw new Error("Packet unavailable");
    assertPacketActionable({ superseded: row.supersededAt !== null, holdReason: row.holdReason }, true);
    await requirePacketAssignment(tx, packetId, actor);
    const packet = await loadCurrentPacket(tx, row);
    const pdf = attachPdf ? await buildSupplierPacketPdf(packet) : undefined;
    const rendered = renderSupplierEmail(packet, Number.MAX_SAFE_INTEGER, pdf);
    if (Buffer.byteLength(rendered.text, "utf8") + (pdf?.byteLength ?? 0) > MAX_SUPPLIER_PACKET_BYTES || Buffer.byteLength(rendered.eml, "utf8") > MAX_SUPPLIER_PACKET_BYTES) {
      await tx.update(supplierPacket).set({ holdReason: "PACKET_SIZE_REVIEW", heldAt: new Date() }).where(eq(supplierPacket.id, packetId));
      return { eml: "", filename: `${packet.id}-v${packet.version}.eml`, heldForReview: true };
    }
    const id = randomUUID();
    const attempt = recordManualExportAttempt({ packet, id, actorId: actor.userId, actorRole: actor.role, at: new Date().toISOString() });
    await tx.insert(supplierPacketAttempt).values({ id, packetId, type: "EML_EXPORT", state: "EXPORTED", actorUserId: actor.userId, recipient: row.recipient, idempotencyKey: `eml-export-${id}` });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: id, actorUserId: actor.userId, actorKind: "STAFF", fromState: null, toState: "EXPORTED", reasonCode: "EML_EXPORTED" });
    await clearResolvedPacketSizeHold(tx, row, actor.userId);
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_EXPORTED", targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { version: row.version, result: attempt.state, reasonCode: "EML" } });
    return { eml: rendered.eml, filename: `${packet.id}-v${packet.version}.eml`, heldForReview: false };
  });
}

export async function exportSupplierPacketPdf(headers: Headers, packetId: string) {
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, packetId)).for("update").limit(1);
    if (!row) throw new Error("Packet unavailable");
    assertPacketActionable({ superseded: row.supersededAt !== null, holdReason: row.holdReason }, true);
    await requirePacketAssignment(tx, packetId, actor);
    const packet = await loadCurrentPacket(tx, row);
    const pdf = await buildSupplierPacketPdf(packet);
    const body = renderSupplierEmail(packet, MAX_SUPPLIER_PACKET_BYTES).text;
    if (Buffer.byteLength(body, "utf8") + pdf.byteLength > MAX_SUPPLIER_PACKET_BYTES) {
      await tx.update(supplierPacket).set({ holdReason: "PACKET_SIZE_REVIEW", heldAt: new Date() }).where(eq(supplierPacket.id, packetId));
      return { bytes: null, filename: `${packet.id}-v${packet.version}.pdf`, heldForReview: true };
    }
    const id = randomUUID();
    await tx.insert(supplierPacketAttempt).values({ id, packetId, type: "PDF_EXPORT", state: "EXPORTED", actorUserId: actor.userId, recipient: row.recipient, idempotencyKey: `pdf-export-${id}` });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: id, actorUserId: actor.userId, actorKind: "STAFF", fromState: null, toState: "EXPORTED", reasonCode: "PDF_EXPORTED" });
    await clearResolvedPacketSizeHold(tx, row, actor.userId);
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_EXPORTED", targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { version: row.version, result: "EXPORTED", reasonCode: "PDF" } });
    return { bytes: pdf, filename: `${packet.id}-v${packet.version}.pdf`, heldForReview: false };
  });
}

export async function beginManualSupplierHandoff(headers: Headers, packetId: string, resendReason?: string) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(packetId) || (resendReason?.length ?? 0) > 1000) throw new Error("Manual handoff is invalid");
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, packetId)).for("update").limit(1);
    if (!row || row.supersededAt || row.holdReason) throw new Error("Packet unavailable for handoff");
    await requirePacketAssignment(tx, packetId, actor);
    const packet = await loadCurrentPacket(tx, row);
    const fulfillmentRows = await lockPacketFulfillmentRows(tx, packet);
    const previousRows = await tx.select().from(supplierPacketAttempt).where(eq(supplierPacketAttempt.packetId, packetId));
    const attempts = previousRows.filter((item) => item.type === "SEND" || item.type === "MANUAL_SENT" || item.type === "MANUAL_SEND")
      .map((attempt) => packetAttemptProjection(attempt, row.version));
    const id = randomUUID();
    const resend = resendReason?.trim() ?? "";
    if (!mayStartManualPacketHandoff(fulfillmentRows, resend.length > 0)) throw new Error("Packet items are no longer eligible for handoff");
    const started = startPacketAttempt({ packet, id, actorId: actor.userId,
      actorRole: actor.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "ADMIN", attempts,
      revalidatedPacketHash: packet.contentHash, currentRecipient: row.recipient,
      at: new Date().toISOString(), deliberateResend: resend.length > 0, resendReason: resend });
    await tx.insert(supplierPacketAttempt).values({ id, packetId, type: "MANUAL_SEND", state: "SENDING",
      actorUserId: actor.userId, recipient: started.recipient, idempotencyKey: `manual-send-${id}`,
      resendReason: resend || null, provider: null });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: id,
      actorUserId: actor.userId, actorKind: "STAFF", fromState: null, toState: "SENDING",
      reasonCode: resend ? "DELIBERATE_MANUAL_SEND_RESERVED" : "MANUAL_SEND_RESERVED" });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_MANUAL_HANDOFF_RESERVED",
      targetType: "SUPPLIER_PACKET", targetId: packetId, metadata: { attemptId: id,
        version: row.version, itemCount: packet.items.length, recipient: row.recipient, result: "PENDING" } });
    return { attemptId: id, state: "SENDING" as const };
  });
}

export async function recordManualSupplierHandoff(headers: Headers, input: { packetId: string; attemptId: string; recipient: string; sentAt: string; messageReference: string; evidence?: { kind: "EML" | "PDF"; bytes: Buffer } }) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(input.packetId) || !validId(input.attemptId)
      || input.messageReference.trim().length < 1 || input.messageReference.length > 320 || /[\r\n\0]/.test(input.messageReference)) throw new Error("Manual handoff evidence is invalid");
  const file = input.evidence;
  if (file && (file.bytes.length < 1 || file.bytes.length > 5 * 1024 * 1024 ||
    (file.kind === "PDF" && !file.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) ||
    (file.kind === "EML" && file.bytes.includes(0)))) throw new Error("Evidence must be a PDF or EML up to 5 MiB");
  if (file) {
    const authorized = await requireStaffAccess(headers, "fulfillment.manage");
    if (authorized.role === "FINANCE") throw new Error("Forbidden");
  }
  const storageKey = file ? await savePrivateFile(file.bytes) : null;
  let transactionCallbackReturned = false;
  try {
    const result = await staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, input.packetId)).for("update").limit(1);
    if (!row) throw new Error("Packet unavailable");
    await requirePacketAssignment(tx, input.packetId, actor);
    if (row.supersededAt || row.holdReason) throw new Error("Packet is no longer eligible for handoff");
    const packet = await loadCurrentPacket(tx, row);
    const itemRows = await lockPacketFulfillmentRows(tx, packet);
    const [attempt] = await tx.select().from(supplierPacketAttempt)
      .where(and(eq(supplierPacketAttempt.id, input.attemptId), eq(supplierPacketAttempt.packetId, input.packetId)))
      .for("update").limit(1);
    if (!attempt || attempt.type !== "MANUAL_SEND" || attempt.state !== "SENDING") {
      throw new Error("Pending manual handoff reservation unavailable");
    }
    if (!mayStartManualPacketHandoff(itemRows, Boolean(attempt.resendReason))) throw new Error("Packet items are no longer eligible for handoff");
    const sentAt = parseExplicitInstant(input.sentAt);
    if (!sentAt || sentAt < attempt.createdAt || sentAt.getTime() > Date.now() + 5 * 60_000) throw new Error("Enter the actual sent time with its timezone after beginning the handoff");
    const actorRole = actor.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "ADMIN";
    const record = recordManualHandoff({ packet, actorId: actor.userId, actorRole, sentAt: sentAt.toISOString(), actualRecipient: input.recipient.trim(), messageReference: input.messageReference.trim(), maxEvidenceBytes: 0 });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: actor.userId, actorKind: "STAFF", fromState: "SENDING", toState: "MANUAL_SENT", reasonCode: "MANUAL_HANDOFF_RECORDED", reference: record.messageReference });
    await tx.update(supplierPacketAttempt).set({ state: "MANUAL_SENT",
      manualMessageReference: record.messageReference, sentAt, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(supplierPacketAttempt.id, attempt.id));
    let evidenceAudit: { id: string; kind: "EML" | "PDF"; bytes: number; sha256: string } | null = null;
    if (file && storageKey) {
      evidenceAudit = { id: randomUUID(), kind: file.kind, bytes: file.bytes.byteLength, sha256: createHash("sha256").update(file.bytes).digest("hex") };
      await tx.insert(supplierPacketManualEvidence).values({
        id: evidenceAudit.id, packetId: input.packetId, attemptId: attempt.id, storageKey, fileKind: file.kind,
        fileName: `handoff-${attempt.id}.${file.kind.toLowerCase()}`, byteSize: file.bytes.byteLength,
        contentSha256: evidenceAudit.sha256, uploadedByUserId: actor.userId,
      });
    }
    await markItemsHandedOff(tx, { itemIds: packet.items.map((item) => item.orderItemId), actorId: actor.userId, actorRole, at: sentAt, reason: "MANUAL_HANDOFF_RECORDED" });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_MANUAL_HANDOFF_RECORDED", targetType: "SUPPLIER_PACKET", targetId: input.packetId, metadata: {
      version: row.version, itemCount: packet.items.length, evidenceId: evidenceAudit?.id ?? null,
      evidenceKind: evidenceAudit?.kind ?? null, evidenceBytes: evidenceAudit?.bytes ?? null,
      evidenceSha256: evidenceAudit?.sha256 ?? null, result: "MANUAL_SENT",
      reasonCode: attempt.resendReason ? "DELIBERATE_RESEND" : "MANUAL_HANDOFF",
    } });
    transactionCallbackReturned = true;
    return { attemptId: attempt.id, state: "MANUAL_SENT" as const };
    });
    return result;
  } catch (error) {
    // A lost commit acknowledgement is ambiguous. Preserve bytes once the
    // transaction callback completed so a committed evidence row never dangles.
    if (storageKey && !transactionCallbackReturned) await deletePrivateFile(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function reconcileManualSupplierHandoffUnsent(headers: Headers, input: { packetId: string; attemptId: string; reason: string }) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(input.packetId) || !validId(input.attemptId)
      || !input.reason.trim() || input.reason.trim().length > 1000) throw new Error("Manual reconciliation details are required");
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, input.packetId)).for("update").limit(1);
    if (!row) throw new Error("Packet unavailable");
    await requirePacketAssignment(tx, input.packetId, actor);
    await lockPacketFulfillmentRows(tx, jsonPacket(row.packet));
    const [attempt] = await tx.select().from(supplierPacketAttempt)
      .where(and(eq(supplierPacketAttempt.id, input.attemptId), eq(supplierPacketAttempt.packetId, input.packetId)))
      .for("update").limit(1);
    if (!attempt || attempt.type !== "MANUAL_SEND" || attempt.state !== "SENDING") throw new Error("Pending manual handoff reservation unavailable");
    const now = new Date();
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id,
      actorUserId: actor.userId, actorKind: "STAFF", fromState: "SENDING", toState: "RECONCILED_FAILED",
      reasonCode: "MANUAL_CONFIRMED_NOT_SENT", reference: input.reason.trim().slice(0, 200) });
    await tx.update(supplierPacketAttempt).set({ state: "RECONCILED_FAILED", resolvedAt: now, updatedAt: now }).where(eq(supplierPacketAttempt.id, attempt.id));
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_MANUAL_SEND_RECONCILED_UNSENT",
      targetType: "SUPPLIER_PACKET_ATTEMPT", targetId: attempt.id, reasonCode: "MANUAL_CONFIRMED_NOT_SENT",
      metadata: { packetId: input.packetId, version: row.version, result: "CANCELLATION_ELIGIBILITY_RESTORED" } });
    return { attemptId: attempt.id, state: "RECONCILED_FAILED" as const };
  });
}

export async function downloadSupplierPacketEvidence(headers: Headers, packetId: string, evidenceId: string) {
  if (!/^pkt_[A-Za-z0-9_-]{6,80}$/.test(packetId) || !validId(evidenceId)) throw new Error("Evidence unavailable");
  const row = await staffTx(headers, async (tx, actor) => {
    await requirePacketAssignment(tx, packetId, actor);
    const [evidence] = await tx.select().from(supplierPacketManualEvidence).where(and(
      eq(supplierPacketManualEvidence.id, evidenceId), eq(supplierPacketManualEvidence.packetId, packetId),
    )).limit(1);
    if (!evidence) throw new Error("Evidence unavailable");
    return evidence;
  });
  const bytes = await readPrivateFile(row.storageKey, 5 * 1024 * 1024);
  if (bytes.byteLength !== row.byteSize || createHash("sha256").update(bytes).digest("hex") !== row.contentSha256) throw new Error("Evidence integrity check failed");
  await staffTx(headers, async (tx, actor) => {
    await requirePacketAssignment(tx, packetId, actor);
    const [current] = await tx.select({ storageKey: supplierPacketManualEvidence.storageKey }).from(supplierPacketManualEvidence)
      .where(and(eq(supplierPacketManualEvidence.id, evidenceId), eq(supplierPacketManualEvidence.packetId, packetId))).limit(1);
    if (current?.storageKey !== row.storageKey) throw new Error("Evidence unavailable");
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_MANUAL_EVIDENCE_DOWNLOADED", targetType: "SUPPLIER_PACKET_MANUAL_EVIDENCE", targetId: evidenceId, metadata: { packetId, fileKind: row.fileKind, result: "ALLOWED" } });
  });
  return { bytes, filename: row.fileName };
}

export async function reconcileSupplierPacketAttempt(headers: Headers, input: { attemptId: string; outcome: "ACCEPTED" | "DELIVERY_ISSUE" | "RECONCILED_FAILED"; providerReference?: string; acceptedAt?: string; reason: string }) {
  if (!validId(input.attemptId) || !input.reason.trim() || input.reason.length > 1000) throw new Error("Reconciliation details are required");
  return staffTx(headers, async (tx, actor) => {
    const [attempt] = await tx.select().from(supplierPacketAttempt).where(eq(supplierPacketAttempt.id, input.attemptId)).for("update").limit(1);
    if (!attempt || attempt.type !== "SEND" || attempt.state !== "UNKNOWN") throw new Error("Unknown send attempt unavailable");
    const [packetRow] = await tx.select().from(supplierPacket).where(eq(supplierPacket.id, attempt.packetId)).limit(1);
    if (!packetRow) throw new Error("Packet unavailable");
    await requirePacketAssignment(tx, packetRow.id, actor);
    const resolved = resolveUnknownAttempt({ attempt: packetAttemptProjection(attempt, packetRow.version), outcome: input.outcome, actorId: actor.userId, actorRole: actor.role, at: new Date().toISOString(), reason: input.reason, providerReference: input.providerReference, providerAcceptedAt: input.acceptedAt });
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: actor.userId, actorKind: "STAFF", fromState: attempt.state, toState: resolved.state, reasonCode: "UNKNOWN_OUTCOME_RECONCILED", reference: input.providerReference?.trim() ?? input.reason.trim().slice(0, 200) });
    await tx.update(supplierPacketAttempt).set({ state: resolved.state, providerReference: resolved.providerReference, acceptedAt: resolved.acceptedAt ? new Date(resolved.acceptedAt) : null, resolvedAt: resolved.resolvedAt ? new Date(resolved.resolvedAt) : new Date(), updatedAt: new Date() }).where(eq(supplierPacketAttempt.id, attempt.id));
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_UNKNOWN_RECONCILED", targetType: "SUPPLIER_PACKET_ATTEMPT", targetId: attempt.id, reasonCode: "UNKNOWN_OUTCOME_RECONCILED", metadata: { fromState: attempt.state, toState: resolved.state, result: "RECONCILED" } });
    if (resolved.state === "ACCEPTED" || resolved.state === "DELIVERY_ISSUE") {
      await recordProviderAcceptanceCutoff(tx, {
        itemIds: jsonPacket(packetRow.packet).items.map((item) => item.orderItemId), actorId: actor.userId,
        acceptedAt: resolved.acceptedAt ? new Date(resolved.acceptedAt) : new Date(),
      });
    }
    return { attemptId: attempt.id, state: resolved.state };
  });
}

export async function markStuckSupplierPacketUnknown(headers: Headers, input: { attemptId: string; reason: string }) {
  if (!validId(input.attemptId) || !input.reason.trim() || input.reason.length > 1000) throw new Error("Reconciliation details are required");
  return staffTx(headers, async (tx, actor) => {
    const [attempt] = await tx.select().from(supplierPacketAttempt).where(eq(supplierPacketAttempt.id, input.attemptId)).for("update").limit(1);
    if (!attempt || attempt.type !== "SEND" || attempt.state !== "SENDING" || Date.now() - attempt.createdAt.getTime() < STUCK_SEND_REVIEW_AFTER_MS) throw new Error("Send attempt is not eligible for stuck-send review");
    await requirePacketAssignment(tx, attempt.packetId, actor);
    const now = new Date();
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: actor.userId, actorKind: "STAFF", fromState: "SENDING", toState: "UNKNOWN", reasonCode: "STUCK_SEND_REVIEWED_UNKNOWN", reference: input.reason.trim().slice(0, 200) });
    await tx.update(supplierPacketAttempt).set({ state: "UNKNOWN", unknownAt: now, updatedAt: now }).where(eq(supplierPacketAttempt.id, attempt.id));
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_PACKET_STUCK_SEND_MARKED_UNKNOWN", targetType: "SUPPLIER_PACKET_ATTEMPT", targetId: attempt.id, reasonCode: "STUCK_SEND_REVIEWED_UNKNOWN", metadata: { fromState: "SENDING", toState: "UNKNOWN", result: "RECONCILIATION_REQUIRED" } });
    return { attemptId: attempt.id, state: "UNKNOWN" as const };
  });
}

export async function listSupplierPacketReconciliation(headers: Headers, requestedPages: { attempts?: unknown; events?: unknown; items?: unknown; held?: unknown } = {}) {
  return staffTx(headers, async (tx, actor) => {
    const now = Date.now();
    const attemptStates = ["SENDING", "UNKNOWN", "ACCEPTED", "DELIVERY_ISSUE", "DELIVERED", "MANUAL_SENT", "EXPORTED"];
    const assignedPacketExists = exists(tx.select({ one: sql`1` }).from(supplierPacketItem)
      .where(and(eq(supplierPacketItem.packetId, supplierPacket.id), eq(supplierPacketItem.assignedAdminId, actor.userId))));
    const attemptsWhere = and(inArray(supplierPacketAttempt.state, attemptStates), actor.role === "ADMIN" ? assignedPacketExists : sql`true`);
    const [attemptCount] = await tx.select({ total: count() }).from(supplierPacketAttempt)
      .innerJoin(supplierPacket, eq(supplierPacket.id, supplierPacketAttempt.packetId)).where(attemptsWhere);
    const attemptsPagination = staffCatalogPagination(requestedPages.attempts, attemptCount?.total ?? 0);
    const attempts = await tx.select({
      attemptId: supplierPacketAttempt.id, packetId: supplierPacket.id, orderId: supplierPacket.orderId,
      attemptType: supplierPacketAttempt.type,
      attemptState: supplierPacketAttempt.state, providerReference: supplierPacketAttempt.providerReference,
      createdAt: supplierPacketAttempt.createdAt, sentAt: supplierPacketAttempt.sentAt, acceptedAt: supplierPacketAttempt.acceptedAt,
      deliveredAt: supplierPacketAttempt.deliveredAt,
    }).from(supplierPacketAttempt).innerJoin(supplierPacket, eq(supplierPacket.id, supplierPacketAttempt.packetId))
      .where(attemptsWhere).orderBy(desc(supplierPacketAttempt.updatedAt), desc(supplierPacketAttempt.id))
      .limit(attemptsPagination.limit).offset(attemptsPagination.offset);
    const packetIds = [...new Set(attempts.map((attempt) => attempt.packetId))];
    const acknowledgements = packetIds.length ? await tx.select({ packetId: supplierPacketAcknowledgement.packetId })
      .from(supplierPacketAcknowledgement).where(inArray(supplierPacketAcknowledgement.packetId, packetIds)) : [];
    const acknowledgedPackets = new Set(acknowledgements.map((item) => item.packetId));
    const [latestManualSent, latestManualPending, latestExport, latestDelivered] = packetIds.length ? await Promise.all([
      tx.selectDistinctOn([supplierPacketAttempt.packetId], {
        packetId: supplierPacketAttempt.packetId, attemptId: supplierPacketAttempt.id, at: supplierPacketAttempt.sentAt,
      }).from(supplierPacketAttempt).where(and(inArray(supplierPacketAttempt.packetId, packetIds), inArray(supplierPacketAttempt.type, ["MANUAL_SENT", "MANUAL_SEND"]), eq(supplierPacketAttempt.state, "MANUAL_SENT"), isNotNull(supplierPacketAttempt.sentAt)))
        .orderBy(supplierPacketAttempt.packetId, desc(supplierPacketAttempt.sentAt), desc(supplierPacketAttempt.id)),
      tx.selectDistinctOn([supplierPacketAttempt.packetId], {
        packetId: supplierPacketAttempt.packetId, createdAt: supplierPacketAttempt.createdAt,
      }).from(supplierPacketAttempt).where(and(inArray(supplierPacketAttempt.packetId, packetIds), eq(supplierPacketAttempt.type, "MANUAL_SEND"), eq(supplierPacketAttempt.state, "SENDING")))
        .orderBy(supplierPacketAttempt.packetId, desc(supplierPacketAttempt.createdAt), desc(supplierPacketAttempt.id)),
      tx.selectDistinctOn([supplierPacketAttempt.packetId], {
        packetId: supplierPacketAttempt.packetId, attemptId: supplierPacketAttempt.id, at: supplierPacketAttempt.createdAt,
      }).from(supplierPacketAttempt).where(and(inArray(supplierPacketAttempt.packetId, packetIds), eq(supplierPacketAttempt.state, "EXPORTED")))
        .orderBy(supplierPacketAttempt.packetId, desc(supplierPacketAttempt.createdAt), desc(supplierPacketAttempt.id)),
      tx.selectDistinctOn([supplierPacketAttempt.packetId], {
        packetId: supplierPacketAttempt.packetId, attemptId: supplierPacketAttempt.id, at: supplierPacketAttempt.deliveredAt,
      }).from(supplierPacketAttempt).where(and(inArray(supplierPacketAttempt.packetId, packetIds), eq(supplierPacketAttempt.state, "DELIVERED"), isNotNull(supplierPacketAttempt.deliveredAt)))
        .orderBy(supplierPacketAttempt.packetId, desc(supplierPacketAttempt.deliveredAt), desc(supplierPacketAttempt.id)),
    ]) : [[], [], [], []];
    const latestManualSentByPacket = new Map(latestManualSent.map((attempt) => [attempt.packetId, attempt.at!]));
    const pendingManualPackets = new Set(latestManualPending.map((attempt) => attempt.packetId));
    const latestExportByPacket = new Map(latestExport.map((attempt) => [attempt.packetId, { id: attempt.attemptId, at: attempt.at }]));
    const followUpAttemptByPacket = new Map<string, { id: string; at: Date }>();
    for (const attempt of [...latestManualSent, ...latestDelivered]) {
      if (!attempt.at) continue;
      const current = followUpAttemptByPacket.get(attempt.packetId);
      if (!current || attempt.at > current.at || (attempt.at.getTime() === current.at.getTime() && attempt.attemptId > current.id)) {
        followUpAttemptByPacket.set(attempt.packetId, { id: attempt.attemptId, at: attempt.at });
      }
    }
    const packetItems = packetIds.length ? await tx.select({
      packetId: supplierPacketItem.packetId, orderItemId: supplierPacketItem.orderItemId,
      state: orderItemFulfillment.state, assignedAdminId: orderItemFulfillment.assignedAdminId,
      handedOffAt: orderItemFulfillment.handedOffAt,
    }).from(supplierPacketItem).innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, supplierPacketItem.orderItemId))
      .where(inArray(supplierPacketItem.packetId, packetIds)) : [];
    const itemsByPacket = new Map<string, typeof packetItems>();
    for (const item of packetItems) itemsByPacket.set(item.packetId, [...(itemsByPacket.get(item.packetId) ?? []), item]);
    const relevant = attempts.flatMap((attempt) => {
      const items = itemsByPacket.get(attempt.packetId) ?? [];
      if (actor.role === "ADMIN" && (!items.length || items.some((item) => item.assignedAdminId !== actor.userId))) return [];
      const manualSentAt = latestManualSentByPacket.get(attempt.packetId);
      const latestExportForPacket = latestExportByPacket.get(attempt.packetId);
      const unconfirmedManualExport = attempt.attemptState === "EXPORTED"
        && latestExportForPacket?.id === attempt.attemptId && !pendingManualPackets.has(attempt.packetId)
        && (!manualSentAt || manualSentAt < attempt.createdAt);
      const delayed = attempt.attemptState === "ACCEPTED" && attempt.acceptedAt && now - attempt.acceptedAt.getTime() >= 72 * 60 * 60 * 1000;
      const ackStart = attempt.attemptState === "DELIVERED" ? attempt.deliveredAt : (attempt.attemptType === "MANUAL_SENT" || attempt.attemptType === "MANUAL_SEND") ? attempt.sentAt : null;
      const acknowledgementOverdue = !acknowledgedPackets.has(attempt.packetId)
        && followUpAttemptByPacket.get(attempt.packetId)?.id === attempt.attemptId
        && ackStart && now - ackStart.getTime() >= 72 * 60 * 60 * 1000;
      const mismatch = attempt.attemptState === "DELIVERED" && items.some((item) => item.state === "HANDOFF_PENDING")
        || attempt.attemptState === "ACCEPTED" && items.some((item) => item.state === "HANDOFF_PENDING" && !item.handedOffAt);
      const manualPending = attempt.attemptType === "MANUAL_SEND" && attempt.attemptState === "SENDING";
      const stuck = attempt.attemptType === "SEND" && attempt.attemptState === "SENDING" && now - attempt.createdAt.getTime() >= STUCK_SEND_REVIEW_AFTER_MS;
      const reason = manualPending ? "MANUAL_SEND_PENDING" : unconfirmedManualExport ? "MANUAL_EXPORT_NO_SEND" : attempt.attemptState === "UNKNOWN" ? "UNKNOWN_OUTCOME" : stuck ? "STUCK_SEND_REVIEW" : attempt.attemptState === "DELIVERY_ISSUE" ? "DELIVERY_ISSUE" : delayed ? "DELIVERY_FOLLOW_UP_72H" : acknowledgementOverdue ? "SUPPLIER_ACKNOWLEDGEMENT_FOLLOW_UP_72H" : mismatch ? "PACKET_ORDER_STATE_MISMATCH" : null;
      return reason ? [{ attemptId: attempt.attemptId, packetId: attempt.packetId, orderReference: attempt.orderId.slice(0, 8).toUpperCase(), state: attempt.attemptState, providerReference: attempt.providerReference, createdAt: attempt.createdAt, acceptedAt: attempt.acceptedAt, deliveredAt: attempt.deliveredAt, reason }] : [];
    });

    const articleReady = sql<boolean>`case when ${customerOrderItem.writingSelected}
      then ${orderItemWriting.state} in ('APPROVED_FIRST','APPROVED_FINAL') and ${orderItemWriting.approvedArticleText} is not null
      else ${customerOrderItem.articleText} is not null end`;
    const unpacketWhere = and(
      eq(orderItemFulfillment.state, "READY_FOR_HANDOFF"), isNotNull(orderItemFulfillmentSupplier.supplierId),
      isNotNull(orderItemFulfillment.assignedAdminId), eq(customerOrderItem.supplierSharingConsented, true), articleReady,
      actor.role === "ADMIN" ? eq(orderItemFulfillment.assignedAdminId, actor.userId) : sql`true`,
      notExists(tx.select({ one: sql`1` }).from(supplierPacketItem).where(eq(supplierPacketItem.orderItemId, customerOrderItem.id))),
    );
    const [unpacketCount] = await tx.select({ total: count() }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemWriting, eq(orderItemWriting.orderItemId, customerOrderItem.id)).where(unpacketWhere);
    const unpacketItemsPagination = staffCatalogPagination(requestedPages.items, unpacketCount?.total ?? 0);
    const eligibleItems = await tx.select({
      itemId: customerOrderItem.id, orderId: customerOrder.id, updatedAt: orderItemFulfillment.updatedAt,
    }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemFulfillmentSupplier, eq(orderItemFulfillmentSupplier.orderItemId, customerOrderItem.id))
      .leftJoin(orderItemWriting, eq(orderItemWriting.orderItemId, customerOrderItem.id))
      .where(unpacketWhere).orderBy(desc(orderItemFulfillment.updatedAt), desc(customerOrderItem.id))
      .limit(unpacketItemsPagination.limit).offset(unpacketItemsPagination.offset);
    const unpacketItems = eligibleItems.map((item) => ({ itemId: item.itemId, orderReference: item.orderId.slice(0, 8).toUpperCase(), updatedAt: item.updatedAt }));

    const heldWhere = and(isNotNull(supplierPacket.holdReason), actor.role === "ADMIN" ? assignedPacketExists : sql`true`);
    const [heldCount] = await tx.select({ total: count() }).from(supplierPacket).where(heldWhere);
    const heldPacketsPagination = staffCatalogPagination(requestedPages.held, heldCount?.total ?? 0);
    const heldPacketRows = await tx.select({ packetId: supplierPacket.id, orderId: supplierPacket.orderId, holdReason: supplierPacket.holdReason, heldAt: supplierPacket.heldAt })
      .from(supplierPacket).where(heldWhere).orderBy(desc(supplierPacket.heldAt), desc(supplierPacket.id))
      .limit(heldPacketsPagination.limit).offset(heldPacketsPagination.offset);
    const heldPacketItems = heldPacketRows.length ? await tx.select({ packetId: supplierPacketItem.packetId, assignedAdminId: supplierPacketItem.assignedAdminId })
      .from(supplierPacketItem).where(inArray(supplierPacketItem.packetId, heldPacketRows.map((packet) => packet.packetId))) : [];
    const heldPackets = heldPacketRows.filter((packet) => {
      const assigned = heldPacketItems.filter((item) => item.packetId === packet.packetId);
      return actor.role === "SUPER_ADMIN" || (assigned.length > 0 && assigned.every((item) => item.assignedAdminId === actor.userId));
    }).map((packet) => ({ packetId: packet.packetId, orderReference: packet.orderId.slice(0, 8).toUpperCase(), holdReason: packet.holdReason, updatedAt: packet.heldAt }));

    const eventWhere = actor.role === "SUPER_ADMIN" ? eq(supplierPacketProviderEvent.state, "RECONCILIATION_REQUIRED") : and(
      eq(supplierPacketProviderEvent.state, "RECONCILIATION_REQUIRED"), isNotNull(supplierPacketProviderEvent.attemptId),
      exists(tx.select({ one: sql`1` }).from(supplierPacketAttempt)
        .innerJoin(supplierPacket, eq(supplierPacket.id, supplierPacketAttempt.packetId))
        .innerJoin(supplierPacketItem, eq(supplierPacketItem.packetId, supplierPacket.id))
        .where(and(eq(supplierPacketAttempt.id, supplierPacketProviderEvent.attemptId), eq(supplierPacketItem.assignedAdminId, actor.userId)))),
    );
    const [eventCount] = await tx.select({ total: count() }).from(supplierPacketProviderEvent).where(eventWhere);
    const unmatchedEventsPagination = staffCatalogPagination(requestedPages.events, eventCount?.total ?? 0);
    const unmatchedEvents = await tx.select({
      eventId: supplierPacketProviderEvent.id, providerEventId: supplierPacketProviderEvent.providerEventId,
      eventType: supplierPacketProviderEvent.eventType, receivedAt: supplierPacketProviderEvent.receivedAt,
      state: supplierPacketProviderEvent.state, attemptId: supplierPacketProviderEvent.attemptId,
      packetId: supplierPacketAttempt.packetId, orderId: supplierPacket.orderId,
    }).from(supplierPacketProviderEvent)
      .leftJoin(supplierPacketAttempt, eq(supplierPacketAttempt.id, supplierPacketProviderEvent.attemptId))
      .leftJoin(supplierPacket, eq(supplierPacket.id, supplierPacketAttempt.packetId))
      .where(eventWhere).orderBy(desc(supplierPacketProviderEvent.receivedAt), desc(supplierPacketProviderEvent.id))
      .limit(unmatchedEventsPagination.limit).offset(unmatchedEventsPagination.offset);
    return { attempts: relevant, attemptsPagination, unmatchedEvents, unmatchedEventsPagination, unpacketItems, unpacketItemsPagination, heldPackets, heldPacketsPagination };
  });
}

export async function processResendWebhook(input: { body: string; eventId: string; eventType: string; emailId: string; taggedAttemptId?: string | null; payloadHash: string }) {
  if (!WEBHOOK_TYPES.includes(input.eventType as typeof WEBHOOK_TYPES[number]) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.eventId) || !input.emailId
    || input.emailId.length > 320 || /[\r\n\0]/.test(input.emailId) || !/^[0-9a-f]{64}$/.test(input.payloadHash)) throw new Error("Webhook event is invalid");
  const resendDb = getResendWebhookDb();
  return resendDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.resend_webhook_verified', 'true', true)`);
    await tx.execute(sql`select set_config('app.resend_webhook_email_id', ${input.emailId}, true)`);
    await tx.execute(sql`select set_config('app.resend_webhook_event_id', ${input.eventId}, true)`);
    await tx.execute(sql`select set_config('app.resend_webhook_attempt_id', ${input.taggedAttemptId && RESEND_ATTEMPT_TAG_ID.test(input.taggedAttemptId) ? input.taggedAttemptId : ""}, true)`);
    const [priorEvent] = await tx.select().from(supplierPacketProviderEvent).where(eq(supplierPacketProviderEvent.providerEventId, input.eventId)).limit(1);
    if (priorEvent) {
      const tagMatches = !input.taggedAttemptId || priorEvent.attemptId === input.taggedAttemptId;
      if (priorEvent.providerEmailId !== input.emailId || !tagMatches || priorEvent.payloadHash !== input.payloadHash) {
        return { matched: false, duplicate: true, conflict: true };
      }
      return { matched: priorEvent.attemptId !== null, duplicate: true };
    }

    const tagPresent = input.taggedAttemptId !== undefined && input.taggedAttemptId !== null;
    const tagValid = !tagPresent || RESEND_ATTEMPT_TAG_ID.test(input.taggedAttemptId!);
    const [tagAttempt] = tagPresent && tagValid ? await tx.select().from(supplierPacketAttempt).where(and(
      eq(supplierPacketAttempt.id, input.taggedAttemptId!), eq(supplierPacketAttempt.provider, "RESEND"), eq(supplierPacketAttempt.type, "SEND"),
    )).for("update").limit(1) : [];
    const [referenceAttempt] = await tx.select().from(supplierPacketAttempt).where(and(
      eq(supplierPacketAttempt.provider, "RESEND"), eq(supplierPacketAttempt.providerReference, input.emailId),
    )).limit(1);
    const correlation = correlateResendAttempt({ emailId: input.emailId, taggedAttemptId: tagValid ? input.taggedAttemptId : "",
      taggedAttempt: tagAttempt, referenceAttempt });
    const correlationConflict = correlation.conflict;
    const attempt = correlation.attemptId ? tagPresent ? tagAttempt : referenceAttempt : undefined;
    const eventId = randomUUID();
    const isKnownState = attempt && ["SENDING", "UNKNOWN", "ACCEPTED", "DELIVERY_ISSUE", "DELIVERED"].includes(attempt.state);
    const conflictingAfterDelivery = attempt?.state === "DELIVERED" && input.eventType !== "email.delivered";
    const [inserted] = await tx.insert(supplierPacketProviderEvent).values({
      id: eventId, providerEventId: input.eventId, providerEmailId: input.emailId, attemptId: attempt?.id ?? null, eventType: input.eventType,
      payloadHash: input.payloadHash, state: isKnownState && !conflictingAfterDelivery ? "PROCESSED" : "RECONCILIATION_REQUIRED",
      processedAt: isKnownState && !conflictingAfterDelivery ? new Date() : null,
    }).onConflictDoNothing().returning({ id: supplierPacketProviderEvent.id });
    if (!inserted) return { matched: Boolean(attempt), duplicate: true };
    if (!attempt) return { matched: false, ...(correlationConflict ? { conflict: true } : {}) };
    if (!attempt.providerReference) {
      await tx.update(supplierPacketAttempt).set({ providerReference: input.emailId, updatedAt: new Date() }).where(eq(supplierPacketAttempt.id, attempt.id));
    }
    if (input.eventType === "email.delivery_delayed") return { matched: true, state: attempt.state };
    if (!isKnownState || conflictingAfterDelivery) return { matched: true, state: "RECONCILIATION_REQUIRED" };
    const state = input.eventType === "email.delivered" ? "DELIVERED" : "DELIVERY_ISSUE";
    const eventCode = input.eventType === "email.delivered" ? "PROVIDER_DELIVERED" : input.eventType === "email.bounced" ? "PROVIDER_BOUNCED" : "PROVIDER_FAILED";
    if (attempt.state === state || attempt.state === "DELIVERED") {
      if (state === "DELIVERY_ISSUE" && attempt.state !== "DELIVERED") {
        const acceptedAt = attempt.acceptedAt ?? new Date();
        if (!attempt.acceptedAt) await tx.update(supplierPacketAttempt).set({ acceptedAt, updatedAt: acceptedAt }).where(eq(supplierPacketAttempt.id, attempt.id));
        const [packetRow] = await tx.select({ organizationId: supplierPacket.organizationId })
          .from(supplierPacket).where(eq(supplierPacket.id, attempt.packetId)).limit(1);
        const itemIds = await tx.select({ orderItemId: supplierPacketItem.orderItemId })
          .from(supplierPacketItem).where(eq(supplierPacketItem.packetId, attempt.packetId));
        if (!packetRow || !itemIds.length) throw new Error("Provider acceptance evidence cannot be matched to items");
        await tx.execute(sql`select set_config('app.organization_id', ${packetRow.organizationId}, true)`);
        await recordWebhookAcceptanceCutoff(tx, { itemIds: itemIds.map((item) => item.orderItemId), organizationId: packetRow.organizationId, acceptedAt });
      }
      return { matched: true, state: attempt.state };
    }
    await tx.insert(supplierPacketAttemptEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: null, actorKind: "PROVIDER", fromState: attempt.state, toState: state, reasonCode: eventCode, reference: input.eventId });
    const providerEventAt = new Date();
    await tx.update(supplierPacketAttempt).set({
      state, acceptedAt: state === "DELIVERY_ISSUE" ? attempt.acceptedAt ?? providerEventAt : attempt.acceptedAt,
      deliveredAt: state === "DELIVERED" ? providerEventAt : attempt.deliveredAt,
      resolvedAt: attempt.state === "UNKNOWN" ? providerEventAt : attempt.resolvedAt, updatedAt: providerEventAt,
    }).where(eq(supplierPacketAttempt.id, attempt.id));
    if (state === "DELIVERED" || state === "DELIVERY_ISSUE") {
      const [packetRow] = await tx.select({ packet: supplierPacket.packet, organizationId: supplierPacket.organizationId })
        .from(supplierPacket).where(eq(supplierPacket.id, attempt.packetId)).limit(1);
      const itemIds = await tx.select({ orderItemId: supplierPacketItem.orderItemId }).from(supplierPacketItem).where(eq(supplierPacketItem.packetId, attempt.packetId));
      if (!packetRow || !itemIds.length) throw new Error("Packet delivery evidence cannot be matched to items");
      await tx.execute(sql`select set_config('app.organization_id', ${packetRow.organizationId}, true)`);
      const ids = itemIds.map((item) => item.orderItemId);
      if (state === "DELIVERY_ISSUE") {
        await recordWebhookAcceptanceCutoff(tx, { itemIds: ids, organizationId: packetRow.organizationId, acceptedAt: attempt.acceptedAt ?? providerEventAt });
      } else {
        const handedOffAt = providerEventAt;
        const rows = await tx.select({ fulfillment: orderItemFulfillment })
          .from(orderItemFulfillment).where(inArray(orderItemFulfillment.orderItemId, ids)).for("update");
        for (const row of rows) {
          if (row.fulfillment.state !== "HANDOFF_PENDING") continue;
          await tx.update(orderItemFulfillment).set({ state: "IN_FULFILLMENT", customerStatus: "IN_PROGRESS", handedOffAt, workStartedAt: handedOffAt, updatedAt: handedOffAt }).where(eq(orderItemFulfillment.orderItemId, row.fulfillment.orderItemId));
          await appendAuditEvent(tx, { organizationId: packetRow.organizationId, actorUserId: null, action: "FULFILLMENT_STATE_CHANGED", targetType: "CUSTOMER_ORDER_ITEM", targetId: row.fulfillment.orderItemId, reasonCode: "PROVIDER_DELIVERED", metadata: { fromState: "HANDOFF_PENDING", toState: "IN_FULFILLMENT", result: "PROVIDER_CONFIRMED" } });
        }
      }
    }
    return { matched: true, state };
  });
}
