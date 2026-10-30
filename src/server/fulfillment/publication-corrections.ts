import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { publicationCorrectionCase, publicationCorrectionEvent } from "@/db/publication-correction-schema";
import { customerOrder, orderItemFulfillment, publicationEvidence } from "@/db/order-schema";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { customerMilestone, transitionItem, type ItemState } from "@/modules/fulfillment/workflow";
import { customerStatusForMilestone, mayReadFulfillmentContent, validateNextUpdate } from "@/modules/fulfillment/console";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function staffTx<T>(headers: Headers, work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export async function openPublicationCorrection(headers: Headers, input: {
  itemId: string; reason: string; nextUpdateAt: string; idempotencyKey: string;
}) {
  if (![input.itemId, input.idempotencyKey].every((value) => UUID.test(value))) throw new Error("Publication correction is unavailable");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    throw new Error("Describe why the original verification was incorrect");
  }
  const nextUpdateAt = validateNextUpdate(input.nextUpdateAt);
  const requestHash = digest({ itemId: input.itemId, reason, nextUpdateAt: input.nextUpdateAt });

  return staffTx(headers, async (tx, actor) => {
    if (actor.role !== "ADMIN" && actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const [fulfillment] = await tx.select().from(orderItemFulfillment)
      .where(eq(orderItemFulfillment.orderItemId, input.itemId)).for("update").limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) {
      throw new Error("Order item unavailable");
    }
    const [prior] = await tx.select().from(publicationCorrectionCase).where(and(
      eq(publicationCorrectionCase.orderItemId, input.itemId),
      eq(publicationCorrectionCase.openedByUserId, actor.userId),
      eq(publicationCorrectionCase.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Publication correction idempotency conflict");
      return { correctionCaseId: prior.id, replayed: true };
    }
    if (fulfillment.state !== "COMPLETED") throw new Error("Only an incorrectly completed item can be corrected");

    const [originalEvidence] = await tx.select({ id: publicationEvidence.id }).from(publicationEvidence)
      .where(eq(publicationEvidence.orderItemId, input.itemId))
      .orderBy(desc(publicationEvidence.verifiedAt), desc(publicationEvidence.id)).limit(1);
    if (!originalEvidence) throw new Error("Original publication evidence is unavailable");

    const priorCases = await tx.select({ id: publicationCorrectionCase.id }).from(publicationCorrectionCase)
      .where(eq(publicationCorrectionCase.orderItemId, input.itemId));
    if (priorCases.length) {
      const events = await tx.select({ correctionCaseId: publicationCorrectionEvent.correctionCaseId, eventType: publicationCorrectionEvent.eventType })
        .from(publicationCorrectionEvent).where(inArray(publicationCorrectionEvent.correctionCaseId, priorCases.map((row) => row.id)));
      if (priorCases.some((row) => !events.some((event) => event.correctionCaseId === row.id && event.eventType === "REVERIFIED"))) {
        throw new Error("Resolve the open publication correction before starting another");
      }
    }

    const now = new Date();
    const correctionCaseId = randomUUID();
    const [order] = await tx.select({ id: customerOrder.id, organizationId: customerOrder.organizationId,
      actorUserId: customerOrder.actorUserId, createdAt: customerOrder.createdAt }).from(customerOrder)
      .where(eq(customerOrder.id, fulfillment.orderId)).limit(1);
    if (!order) throw new Error("Order item unavailable");
    const transition = transitionItem({
      item: {
        id: input.itemId, organizationId: order.organizationId, orderId: fulfillment.orderId, orderedByUserId: order.actorUserId,
        state: fulfillment.state as ItemState, updatedAt: fulfillment.updatedAt.toISOString(),
        purchasedAt: order.createdAt.toISOString(),
        totalPaidMinor: 0, currency: "USD",
      },
      to: "PUBLICATION_PENDING", actorId: actor.userId, actorType: "STAFF", actorRole: actor.role,
      assignedAdminId: fulfillment.assignedAdminId ?? undefined, at: now.toISOString(),
      reason: "Incorrect publication verification", eventId: randomUUID(), correctionCaseId,
    });
    await appendAuditEvent(tx, {
      organizationId: order.organizationId, actorUserId: actor.userId,
      action: "PUBLICATION_CORRECTION_OPENED", targetType: "PUBLICATION_CORRECTION_CASE", targetId: correctionCaseId,
      reasonCode: "INCORRECT_VERIFICATION", metadata: {
        result: "REOPENED_FOR_VERIFICATION", fromState: transition.event.from, toState: transition.event.to,
      },
    });
    await tx.insert(publicationCorrectionCase).values({
      id: correctionCaseId, orderItemId: input.itemId, originalEvidenceId: originalEvidence.id,
      openedByUserId: actor.userId, reason, idempotencyKey: input.idempotencyKey, requestHash, createdAt: now,
    });
    await tx.insert(publicationCorrectionEvent).values({
      id: randomUUID(), correctionCaseId, actorUserId: actor.userId, eventType: "OPENED",
      publicationEvidenceId: null, reason, createdAt: now,
    });
    const milestone = customerMilestone(transition.item.state);
    const customerStatus = customerStatusForMilestone(milestone, transition.item.state);
    await tx.update(orderItemFulfillment).set({ state: transition.item.state, customerStatus,
      nextUpdateAt, updatedAt: now }).where(eq(orderItemFulfillment.orderItemId, input.itemId));
    return { correctionCaseId, replayed: false };
  });
}

export async function listPublicationCorrections(headers: Headers, itemId: string) {
  if (!UUID.test(itemId)) throw new Error("Order item unavailable");
  return staffTx(headers, async (tx, actor) => {
    const [fulfillment] = await tx.select({ assignedAdminId: orderItemFulfillment.assignedAdminId })
      .from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, itemId)).limit(1);
    if (!fulfillment || !mayReadFulfillmentContent({ role: actor.role, userId: actor.userId, assignedAdminId: fulfillment.assignedAdminId })) {
      throw new Error("Order item unavailable");
    }
    const cases = await tx.select({ id: publicationCorrectionCase.id, originalEvidenceId: publicationCorrectionCase.originalEvidenceId,
      reason: publicationCorrectionCase.reason, createdAt: publicationCorrectionCase.createdAt })
      .from(publicationCorrectionCase).where(eq(publicationCorrectionCase.orderItemId, itemId))
      .orderBy(asc(publicationCorrectionCase.createdAt));
    if (!cases.length) return [];
    const caseIds = cases.map((row) => row.id);
    const [events, evidence] = await Promise.all([
      tx.select({ correctionCaseId: publicationCorrectionEvent.correctionCaseId, actorUserId: publicationCorrectionEvent.actorUserId,
        eventType: publicationCorrectionEvent.eventType, publicationEvidenceId: publicationCorrectionEvent.publicationEvidenceId,
        reason: publicationCorrectionEvent.reason, createdAt: publicationCorrectionEvent.createdAt })
        .from(publicationCorrectionEvent).where(inArray(publicationCorrectionEvent.correctionCaseId, caseIds))
        .orderBy(asc(publicationCorrectionEvent.createdAt)),
      tx.select({ id: publicationEvidence.id, liveUrl: publicationEvidence.liveUrl, verifiedAt: publicationEvidence.verifiedAt })
        .from(publicationEvidence).where(inArray(publicationEvidence.id, cases.map((row) => row.originalEvidenceId))),
    ]);
    const evidenceById = new Map(evidence.map((row) => [row.id, row]));
    return cases.map((row) => {
      const caseEvents = events.filter((event) => event.correctionCaseId === row.id);
      return { ...row, originalEvidence: evidenceById.get(row.originalEvidenceId) ?? null,
        open: !caseEvents.some((event) => event.eventType === "REVERIFIED"), events: caseEvents };
    });
  });
}

export async function recordCorrectionReverification(tx: DbTransaction, input: {
  itemId: string; evidenceId: string; actorUserId: string;
}) {
  const cases = await tx.select({ id: publicationCorrectionCase.id }).from(publicationCorrectionCase)
    .where(eq(publicationCorrectionCase.orderItemId, input.itemId));
  if (!cases.length) return;
  const events = await tx.select({ correctionCaseId: publicationCorrectionEvent.correctionCaseId, eventType: publicationCorrectionEvent.eventType })
    .from(publicationCorrectionEvent).where(inArray(publicationCorrectionEvent.correctionCaseId, cases.map((row) => row.id)));
  const openCase = cases.find((row) => !events.some((event) => event.correctionCaseId === row.id && event.eventType === "REVERIFIED"));
  if (!openCase) return;
  const reason = "New live publication evidence recorded after correction review";
  await appendAuditEvent(tx, { actorUserId: input.actorUserId, action: "PUBLICATION_CORRECTION_REVERIFIED",
    targetType: "PUBLICATION_CORRECTION_CASE", targetId: openCase.id, reasonCode: "NEW_EVIDENCE",
    metadata: { result: "RESOLVED", orderItemId: input.itemId, publicationEvidenceId: input.evidenceId } });
  await tx.insert(publicationCorrectionEvent).values({ id: randomUUID(), correctionCaseId: openCase.id,
    actorUserId: input.actorUserId, eventType: "REVERIFIED", publicationEvidenceId: input.evidenceId, reason });
}
