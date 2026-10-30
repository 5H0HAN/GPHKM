import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { supplierItemNotice, supplierItemNoticeAttempt, supplierItemNoticeEvent } from "@/db/supplier-notice-schema";
import { supplierPacket, supplierPacketItem } from "@/db/packet-schema";
import { orderItemFulfillment } from "@/db/order-schema";
import { supportCase } from "@/db/support-schema";
import { postHandoffRefundRequest } from "@/db/post-handoff-refund-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { buildSupplierNotice, renderSupplierNoticeEml } from "@/modules/fulfillment/supplier-notice";
import { resendEnvConfigured } from "@/server/fulfillment/packets";
import { readSmallJsonResponse } from "@/modules/security/small-json-response";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type NoticeType = "WITHDRAWAL" | "CORRECTION";
type NoticeState = "SENDING" | "ACCEPTED" | "UNKNOWN" | "RECONCILED_FAILED" | "EXPORTED" | "MANUAL_SENT" | "SUPPLIER_STOP_CONFIRMED" | "SUPPLIER_CONTINUING" | "UNABLE_TO_CONFIRM";
const validId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function staffTx<T>(headers: Headers, work: (tx: Tx, actor: { userId: string; role: "ADMIN" | "FINANCE" | "SUPER_ADMIN" }) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "fulfillment.manage");
  if (actor.role === "FINANCE") throw new Error("Forbidden");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

export async function prepareSupplierItemNotice(headers: Headers, input: { caseId: string; type: NoticeType; reason: string }) {
  if (!validId(input.caseId) || !["WITHDRAWAL", "CORRECTION"].includes(input.type)) throw new Error("Notice unavailable");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) throw new Error("Provide a valid supplier instruction");
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select({ caseId: supportCase.id, organizationId: supportCase.organizationId,
      itemId: supportCase.orderItemId, handedOffAt: orderItemFulfillment.handedOffAt,
      assignedAdminId: orderItemFulfillment.assignedAdminId, packet: supplierPacket.packet,
      packetId: supplierPacket.id, recipient: supplierPacket.recipient,
    }).from(supportCase).innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, supportCase.orderItemId))
      .innerJoin(supplierPacketItem, eq(supplierPacketItem.orderItemId, supportCase.orderItemId))
      .innerJoin(supplierPacket, eq(supplierPacket.id, supplierPacketItem.packetId))
      .where(eq(supportCase.id, input.caseId)).orderBy(desc(supplierPacket.createdAt)).limit(1);
    if (!row || !row.handedOffAt || !row.assignedAdminId || (actor.role === "ADMIN" && row.assignedAdminId !== actor.userId)) throw new Error("Assigned, handed-off item unavailable");
    const packet = row.packet as { items?: Array<{ orderItemId?: string; reference?: string }> };
    const item = packet.items?.find((candidate) => candidate.orderItemId === row.itemId);
    if (!item?.reference) throw new Error("Original packet evidence unavailable");
    const snapshot = buildSupplierNotice(input.type, item.reference, reason);
    const contentHash = hash({ recipient: row.recipient, snapshot });
    const id = randomUUID();
    await tx.insert(supplierItemNotice).values({ id, caseId: row.caseId, orderItemId: row.itemId, packetId: row.packetId,
      noticeType: input.type, recipient: row.recipient, snapshot, contentHash, createdByUserId: actor.userId });
    await appendAuditEvent(tx, { organizationId: row.organizationId, actorUserId: actor.userId,
      action: "SUPPLIER_ITEM_NOTICE_PREPARED", targetType: "SUPPLIER_ITEM_NOTICE", targetId: id,
      reasonCode: input.type, metadata: { result: "PREPARED" } });
    return { noticeId: id };
  });
}

async function getNotice(tx: Tx, noticeId: string, actor: { userId: string; role: "ADMIN" | "FINANCE" | "SUPER_ADMIN" }, lock = false) {
  const query = tx.select().from(supplierItemNotice).where(eq(supplierItemNotice.id, noticeId));
  const [row] = await (lock ? query.for("update").limit(1) : query.limit(1));
  if (!row) throw new Error("Notice unavailable");
  const [fulfillment] = await tx.select({ assignedAdminId: orderItemFulfillment.assignedAdminId, handedOffAt: orderItemFulfillment.handedOffAt })
    .from(orderItemFulfillment).where(eq(orderItemFulfillment.orderItemId, row.orderItemId)).limit(1);
  if (!fulfillment?.handedOffAt || (actor.role !== "SUPER_ADMIN" && fulfillment.assignedAdminId !== actor.userId)) throw new Error("Notice unavailable");
  return row;
}

async function appendAttempt(tx: Tx, input: { noticeId: string; actorId: string; state: NoticeState; reason: string; reference?: string | null; providerReference?: string | null; sentAt?: Date | null }) {
  const id = randomUUID();
  await tx.insert(supplierItemNoticeAttempt).values({ id, noticeId: input.noticeId, state: input.state,
    actorUserId: input.actorId, idempotencyKey: `supplier-notice-${id}`, providerReference: input.providerReference ?? null,
    manualReference: input.reference ?? null, sentAt: input.sentAt ?? null });
  await tx.insert(supplierItemNoticeEvent).values({ id: randomUUID(), attemptId: id, actorUserId: input.actorId,
    actorKind: "STAFF", fromState: null, toState: input.state, reason: input.reason, reference: input.reference ?? input.providerReference ?? null });
  return id;
}

export async function recordManualSupplierItemNotice(headers: Headers, input: { noticeId: string; recipient: string; sentAt: string; messageReference: string }) {
  if (!validId(input.noticeId) || input.messageReference.trim().length < 1 || input.messageReference.length > 320 || /[\u0000-\u001f\u007f]/.test(input.messageReference)) throw new Error("Manual notice evidence is invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.sentAt)) throw new Error("Enter an ISO 8601 sent time with its timezone");
  const sentAt = new Date(input.sentAt);
  if (!Number.isFinite(sentAt.getTime()) || sentAt.getTime() > Date.now() + 5 * 60_000) throw new Error("Enter the actual sent time");
  return staffTx(headers, async (tx, actor) => {
    const notice = await getNotice(tx, input.noticeId, actor, true);
    const actualRecipient = input.recipient.trim().toLowerCase();
    if (actualRecipient !== notice.recipient.trim().toLowerCase() || sentAt < notice.createdAt) throw new Error("Manual send details do not match this notice snapshot");
    const prior = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.noticeId, notice.id));
    if (!prior.some((attempt) => attempt.state === "EXPORTED")) throw new Error("Export the reviewed notice before recording a manual send");
    if (prior.some((attempt) => ["SENDING", "UNKNOWN", "ACCEPTED", "MANUAL_SENT", "SUPPLIER_STOP_CONFIRMED", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(attempt.state))) throw new Error("Resolve the earlier notice attempt before recording another send");
    const attemptId = await appendAttempt(tx, { noticeId: notice.id, actorId: actor.userId, state: "MANUAL_SENT", reason: "MANUAL_NOTICE_SEND_RECORDED", reference: input.messageReference.trim(), sentAt });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_MANUAL_SENT", targetType: "SUPPLIER_ITEM_NOTICE", targetId: notice.id, reasonCode: "MANUAL_SENT", metadata: { result: "RECORDED" } });
    return { attemptId, state: "MANUAL_SENT" as const };
  });
}

export async function exportSupplierItemNotice(headers: Headers, noticeId: string) {
  if (!validId(noticeId)) throw new Error("Notice unavailable");
  return staffTx(headers, async (tx, actor) => {
    const row = await getNotice(tx, noticeId, actor, true);
    const snapshot = row.snapshot as { subject: string; body: string };
    const eml = renderSupplierNoticeEml({ recipient: row.recipient, subject: snapshot.subject, body: snapshot.body });
    await appendAttempt(tx, { noticeId, actorId: actor.userId, state: "EXPORTED", reason: "EML_EXPORTED" });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_EXPORTED", targetType: "SUPPLIER_ITEM_NOTICE", targetId: noticeId, reasonCode: "EML", metadata: { result: "EXPORTED" } });
    return { eml, filename: `${noticeId}.eml` };
  });
}

function mailConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  const address = /<([^<>]+)>/.exec(from ?? "")?.[1] ?? from;
  if (!resendEnvConfigured() || !apiKey || !from || !address || /[\r\n\0]/.test(from) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  return { apiKey, from, senderDomain: address.slice(address.lastIndexOf("@") + 1).toLowerCase() };
}

async function verifyNoticeSenderDomain(config: NonNullable<ReturnType<typeof mailConfig>>) {
  if (Date.now() - verifiedSenderDomainAt < 60_000) return;
  const response = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Resend sender domain check failed");
  const payload = await readSmallJsonResponse<{ data?: Array<{ name?: string; status?: string; capabilities?: { sending?: string } }> }>(response);
  if (!payload.data?.some((domain) => domain.name?.toLowerCase() === config.senderDomain && domain.status === "verified" && domain.capabilities?.sending === "enabled")) throw new Error("Resend sender domain is not verified");
  verifiedSenderDomainAt = Date.now();
}
let verifiedSenderDomainAt = 0;

export async function sendSupplierItemNotice(headers: Headers, noticeId: string) {
  if (!validId(noticeId)) throw new Error("Notice unavailable");
  const authorized = await requireStaffAccess(headers, "fulfillment.manage");
  if (authorized.role === "FINANCE") throw new Error("Forbidden");
  const config = mailConfig();
  if (!config) throw new Error("Supplier email is not configured and approved");
  await verifyNoticeSenderDomain(config);
  const prepared = await staffTx(headers, async (tx, actor) => {
    const row = await getNotice(tx, noticeId, actor, true);
    const prior = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.noticeId, noticeId));
    if (prior.some((attempt) => ["SENDING", "UNKNOWN", "ACCEPTED", "MANUAL_SENT", "SUPPLIER_STOP_CONFIRMED", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(attempt.state))) throw new Error("A prior notice attempt must be reconciled before resending");
    const snapshot = row.snapshot as { subject: string; body: string };
    const attemptId = await appendAttempt(tx, { noticeId, actorId: actor.userId, state: "SENDING", reason: "PROVIDER_SEND_STARTED" });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_SEND_STARTED", targetType: "SUPPLIER_ITEM_NOTICE", targetId: noticeId, metadata: { result: "SENDING" } });
    return { attemptId, actorId: actor.userId, row, snapshot };
  });
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `gphkm-notice-${prepared.attemptId}` },
      body: JSON.stringify({ from: config.from, to: [prepared.row.recipient], subject: prepared.snapshot.subject, text: prepared.snapshot.body }),
    });
  } catch { await recordNoticeAttemptOutcome(headers, prepared.attemptId, "UNKNOWN", "Provider outcome unclear after send request"); return { state: "UNKNOWN" as const }; }
  if (!response.ok) {
    const state = response.status >= 400 && response.status < 500 ? "RECONCILED_FAILED" : "UNKNOWN";
    await recordNoticeAttemptOutcome(headers, prepared.attemptId, state, state === "UNKNOWN" ? "Provider outcome unclear" : "Provider rejected the request");
    return { state };
  }
  let providerReference: string | undefined;
  try { providerReference = (await readSmallJsonResponse<{ id?: string }>(response)).id; } catch { }
  if (!providerReference || /[\r\n\0]/.test(providerReference)) {
    await recordNoticeAttemptOutcome(headers, prepared.attemptId, "UNKNOWN", "Provider response lacked a usable message reference");
    return { state: "UNKNOWN" as const };
  }
  await recordNoticeAttemptOutcome(headers, prepared.attemptId, "ACCEPTED", "Provider accepted notice", providerReference);
  return { state: "ACCEPTED" as const };
}

async function recordNoticeAttemptOutcome(headers: Headers, attemptId: string, state: NoticeState, reason: string, providerReference?: string) {
  return staffTx(headers, async (tx, actor) => {
    const [attempt] = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.id, attemptId)).for("update").limit(1);
    if (!attempt || attempt.state !== "SENDING") throw new Error("Notice attempt changed");
    await getNotice(tx, attempt.noticeId, actor, true);
    await tx.update(supplierItemNoticeAttempt).set({ state, providerReference: providerReference ?? null, updatedAt: new Date() }).where(eq(supplierItemNoticeAttempt.id, attemptId));
    await tx.insert(supplierItemNoticeEvent).values({ id: randomUUID(), attemptId, actorUserId: actor.userId, actorKind: "STAFF", fromState: attempt.state, toState: state, reason, reference: providerReference ?? null });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_ATTEMPT_UPDATED", targetType: "SUPPLIER_ITEM_NOTICE_ATTEMPT", targetId: attemptId, reasonCode: state, metadata: { fromState: attempt.state, toState: state, result: "RECORDED" } });
  });
}

export async function reconcileSupplierItemNotice(headers: Headers, input: { attemptId: string; outcome: "ACCEPTED" | "RECONCILED_FAILED" | "SUPPLIER_STOP_CONFIRMED" | "SUPPLIER_CONTINUING" | "UNABLE_TO_CONFIRM"; reason: string; reference?: string }) {
  if (!validId(input.attemptId) || !["ACCEPTED", "RECONCILED_FAILED", "SUPPLIER_STOP_CONFIRMED", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(input.outcome) || input.reason.trim().length < 5 || input.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Reconciliation evidence is required");
  return staffTx(headers, async (tx, actor) => {
    const [attempt] = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.id, input.attemptId)).for("update").limit(1);
    if (!attempt || !(attempt.state === "UNKNOWN" || attempt.state === "ACCEPTED" || attempt.state === "MANUAL_SENT")) throw new Error("Notice does not need reconciliation");
    const providerResolution = attempt.state === "UNKNOWN" && ["ACCEPTED", "RECONCILED_FAILED"].includes(input.outcome);
    const supplierResolution = ["ACCEPTED", "MANUAL_SENT"].includes(attempt.state) && ["SUPPLIER_STOP_CONFIRMED", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(input.outcome);
    if (!providerResolution && !supplierResolution) throw new Error("The selected result does not match the notice attempt state");
    const notice = await getNotice(tx, attempt.noticeId, actor, true);
    await tx.update(supplierItemNoticeAttempt).set({ state: input.outcome,
      providerReference: input.outcome === "ACCEPTED" ? input.reference?.trim() || attempt.providerReference : attempt.providerReference,
      updatedAt: new Date() }).where(eq(supplierItemNoticeAttempt.id, attempt.id));
    await tx.insert(supplierItemNoticeEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: actor.userId, actorKind: "STAFF", fromState: attempt.state, toState: input.outcome, reason: input.reason.trim(), reference: input.reference?.trim() || null });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_RECONCILED", targetType: "SUPPLIER_ITEM_NOTICE_ATTEMPT", targetId: attempt.id, reasonCode: input.outcome, metadata: { fromState: attempt.state, toState: input.outcome, result: "RECONCILED" } });
    return { noticeId: notice.id, state: input.outcome };
  });
}

export async function markStuckSupplierItemNoticeUnknown(headers: Headers, input: { attemptId: string; reason: string }) {
  if (!validId(input.attemptId) || input.reason.trim().length < 5 || input.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Review details are required");
  return staffTx(headers, async (tx, actor) => {
    const [attempt] = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.id, input.attemptId)).for("update").limit(1);
    if (!attempt || attempt.state !== "SENDING" || Date.now() - attempt.createdAt.getTime() < 10 * 60 * 1000) throw new Error("Notice send is not eligible for recovery review");
    const notice = await getNotice(tx, attempt.noticeId, actor);
    await tx.update(supplierItemNoticeAttempt).set({ state: "UNKNOWN", updatedAt: new Date() }).where(eq(supplierItemNoticeAttempt.id, attempt.id));
    await tx.insert(supplierItemNoticeEvent).values({ id: randomUUID(), attemptId: attempt.id, actorUserId: actor.userId,
      actorKind: "STAFF", fromState: "SENDING", toState: "UNKNOWN", reason: input.reason.trim() });
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ITEM_NOTICE_STUCK_SEND_REVIEWED", targetType: "SUPPLIER_ITEM_NOTICE_ATTEMPT", targetId: attempt.id, reasonCode: "UNKNOWN", metadata: { fromState: "SENDING", toState: "UNKNOWN", result: notice.id } });
    return { attemptId: attempt.id, state: "UNKNOWN" as const };
  });
}

export async function listSupplierItemNoticesForCase(headers: Headers, caseId: string) {
  if (!validId(caseId)) return [];
  return staffTx(headers, async (tx, actor) => {
    const notices = await tx.select().from(supplierItemNotice).where(eq(supplierItemNotice.caseId, caseId)).orderBy(desc(supplierItemNotice.createdAt));
    const rows = [];
    for (const notice of notices) {
      const noticeRow = await getNotice(tx, notice.id, actor).catch(() => null);
      if (!noticeRow) continue;
      const attempts = await tx.select().from(supplierItemNoticeAttempt).where(eq(supplierItemNoticeAttempt.noticeId, notice.id)).orderBy(desc(supplierItemNoticeAttempt.createdAt));
      rows.push({ ...notice, attempts });
    }
    return rows;
  });
}

export async function listApprovedAfterDispatchNoticeReconciliation(headers: Headers) {
  return staffTx(headers, async (tx, actor) => {
    if (actor.role !== "SUPER_ADMIN") throw new Error("Super Admin access required");
    const rows = await tx.select({ notice: supplierItemNotice, attempt: supplierItemNoticeAttempt, refund: postHandoffRefundRequest })
      .from(postHandoffRefundRequest).innerJoin(supplierItemNotice, eq(supplierItemNotice.caseId, postHandoffRefundRequest.caseId))
      .innerJoin(supplierItemNoticeAttempt, eq(supplierItemNoticeAttempt.noticeId, supplierItemNotice.id))
      .where(eq(postHandoffRefundRequest.state, "APPROVED"))
      .orderBy(desc(supplierItemNoticeAttempt.createdAt)).limit(200);
    const latest = new Map<string, typeof rows[number]>();
    for (const row of rows) if (!latest.has(row.notice.id)) latest.set(row.notice.id, row);
    const result = [];
    for (const row of latest.values()) {
      if (!["SENDING", "UNKNOWN", "ACCEPTED", "RECONCILED_FAILED", "EXPORTED", "MANUAL_SENT", "SUPPLIER_CONTINUING", "UNABLE_TO_CONFIRM"].includes(row.attempt.state)) continue;
      if (row.notice.orderItemId !== row.refund.orderItemId) continue;
      const access = await getNotice(tx, row.notice.id, actor).catch(() => null);
      if (access) result.push(row);
    }
    return result;
  });
}
