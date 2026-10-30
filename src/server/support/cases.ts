import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { supportCase, supportCaseEvent } from "@/db/support-schema";
import { customerOrder, customerOrderItem } from "@/db/order-schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { assertSupportTransition, customerSupportProjection, financeOutcome, supportState, supportText, type SupportAudience } from "@/modules/support/cases";
import { staffCatalogPagination } from "@/modules/catalog/pagination";
import { decodeSupportEventCursor, encodeSupportEventCursor } from "@/modules/support/event-cursor";
import { logSafeFailure } from "@/server/observability/safe-log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identity(value: string) { if (!UUID.test(value)) throw new Error("Support request is unavailable"); return value; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
type CaseRow = typeof supportCase.$inferSelect;

async function staffTx<T>(headers: Headers, work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "audit.read");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

async function lockedCase(tx: DbTransaction, caseId: string) {
  await tx.execute(sql`select public.gphkm_lock_support_case(${identity(caseId)})`);
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1);
  if (!row) throw new Error("Support request is unavailable");
  return row;
}

async function appendHistory(tx: DbTransaction, input: {
  caseId: string; actorUserId: string; actorKind: "CUSTOMER" | "STAFF"; kind: "REPLY" | "NOTE" | "STATE_CHANGED" | "FINANCE_DECISION";
  audience: SupportAudience; body: string; idempotencyKey: string; fromState?: string; toState?: string; decision?: string;
}) {
  const idempotencyKey = identity(input.idempotencyKey);
  const requestHash = digest({ ...input, idempotencyKey: undefined });
  const [prior] = await tx.select({ requestHash: supportCaseEvent.requestHash }).from(supportCaseEvent).where(and(
    eq(supportCaseEvent.caseId, input.caseId), eq(supportCaseEvent.actorUserId, input.actorUserId), eq(supportCaseEvent.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error("Support action idempotency conflict");
    return false;
  }
  await tx.insert(supportCaseEvent).values({ id: randomUUID(), ...input, idempotencyKey, requestHash });
  return true;
}

async function audit(tx: DbTransaction, row: Pick<CaseRow, "id" | "organizationId">, actorUserId: string, action: string, result: string) {
  await appendAuditEvent(tx, { organizationId: row.organizationId, actorUserId, action, targetType: "SUPPORT_CASE", targetId: row.id, metadata: { result } });
}

export async function openCustomerSupportCase(headers: Headers, organizationId: string, input: { orderItemId: string; summary: string; idempotencyKey: string }) {
  identity(input.orderItemId); identity(input.idempotencyKey);
  const summary = supportText(input.summary, 2000);
  const actor = await requireVerifiedCustomer(headers);
  const requestHash = digest({ orderItemId: input.orderItemId, summary });
  const requestId = randomUUID();
  let stage = "order_item_scope";
  try { return await withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    // PostgreSQL ON CONFLICT performs checks against RLS-hidden rows and can
    // reject this insert for the restricted runtime role. Serialize by the
    // scoped idempotency key, then use an ordinary insert under customer RLS.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      'gphkm:support-open:' || ${organizationId} || ':' || ${actor.userId} || ':' || ${input.idempotencyKey}, 0))`);
    const [prior] = await tx.select().from(supportCase).where(and(eq(supportCase.organizationId, organizationId),
      eq(supportCase.openedByUserId, actor.userId), eq(supportCase.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Support action idempotency conflict");
      return { caseId: prior.id };
    }
    const [item] = await tx.select({ orderId: customerOrder.id }).from(customerOrderItem)
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(eq(customerOrderItem.id, input.orderItemId), eq(customerOrder.organizationId, organizationId), eq(customerOrder.checkoutState, "PAID"))).limit(1);
    if (!item) throw new Error("Order item is unavailable");
    stage = "case_insert";
    const caseId = randomUUID();
    const inserted = await tx.insert(supportCase).values({
      id: caseId, organizationId, orderId: item.orderId, orderItemId: input.orderItemId,
      openedByUserId: actor.userId, summary, idempotencyKey: input.idempotencyKey, requestHash,
    });
    if (inserted.rowCount !== 1) throw new Error("Support request could not be recorded");
    stage = "opening_event_insert";
    await tx.insert(supportCaseEvent).values({ id: randomUUID(), caseId, actorUserId: actor.userId,
      actorKind: "CUSTOMER", kind: "OPENED", audience: "INTERNAL", body: summary, toState: "OPEN",
      idempotencyKey: input.idempotencyKey, requestHash });
    stage = "audit_insert";
    await audit(tx, { id: caseId, organizationId }, actor.userId, "SUPPORT_CASE_OPENED", "OPEN");
    return { caseId };
  }); } catch (error) {
    logSafeFailure("customer_support_open_failed", error, requestId, { actorId: actor.userId, organizationId, reasonCode: stage });
    throw error;
  }
}

export async function listCustomerSupportCases(headers: Headers, organizationId: string, requestedPage?: unknown) {
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const scope = and(eq(supportCase.organizationId, organizationId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(supportCase).where(scope);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select().from(supportCase).where(scope)
      .orderBy(desc(supportCase.updatedAt), desc(supportCase.id)).limit(pagination.limit).offset(pagination.offset);
    return { ...pagination, items: rows.map((row) => customerSupportProjection(row)) };
  });
}

export async function getCustomerSupportCase(headers: Headers, organizationId: string, caseId: string, before?: string) {
  identity(caseId);
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [row] = await tx.select().from(supportCase).where(and(eq(supportCase.id, caseId), eq(supportCase.organizationId, organizationId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`)).limit(1);
    if (!row) throw new Error("Support request is unavailable");
    const cursor = decodeSupportEventCursor(before);
    const scope = and(eq(supportCaseEvent.caseId, caseId), eq(supportCaseEvent.audience, "CUSTOMER"));
    const eventQuery = tx.select().from(supportCaseEvent).where(cursor ? and(scope, or(
      lt(supportCaseEvent.createdAt, cursor.createdAt),
      and(eq(supportCaseEvent.createdAt, cursor.createdAt), lt(supportCaseEvent.id, cursor.id)),
    )) : scope);
    const fetched = await eventQuery.orderBy(desc(supportCaseEvent.createdAt), desc(supportCaseEvent.id)).limit(51);
    const hasMore = fetched.length > 50;
    const history = (hasMore ? fetched.slice(0, 50) : fetched).reverse();
    const last = history[0];
    const olderCursor = hasMore && last ? encodeSupportEventCursor({ createdAt: last.createdAt, id: last.id }) : null;
    return { ...customerSupportProjection(row, history), canReply: row.state !== "CLOSED", olderCursor };
  });
}

export async function replyToCustomerSupportCase(headers: Headers, organizationId: string, input: { caseId: string; body: string; idempotencyKey: string }) {
  identity(input.caseId); identity(input.idempotencyKey);
  const body = supportText(input.body);
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const row = await lockedCase(tx, input.caseId);
    if (row.organizationId !== organizationId) throw new Error("Support request is unavailable");
    const inserted = await appendHistory(tx, { caseId: row.id, actorUserId: actor.userId, actorKind: "CUSTOMER", kind: "REPLY", audience: "CUSTOMER", body, idempotencyKey: input.idempotencyKey });
    if (inserted) {
      await audit(tx, row, actor.userId, "SUPPORT_CUSTOMER_REPLY", "RECORDED");
    }
  });
}

export async function listStaffSupportCases(headers: Headers, requestedPage?: unknown) {
  return staffTx(headers, async (tx, actor) => {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(supportCase);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({ id: supportCase.id, orderId: supportCase.orderId, orderItemId: supportCase.orderItemId,
      state: supportCase.state, summary: supportCase.summary, updatedAt: supportCase.updatedAt })
      .from(supportCase).orderBy(desc(supportCase.updatedAt), desc(supportCase.id)).limit(pagination.limit).offset(pagination.offset);
    return { rows, actorRole: actor.role, pagination };
  });
}

export async function getStaffSupportCase(headers: Headers, caseId: string, before?: string) {
  identity(caseId);
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1);
    if (!row) throw new Error("Support request is unavailable");
    const cursor = decodeSupportEventCursor(before);
    const eventQuery = tx.select({ id: supportCaseEvent.id, kind: supportCaseEvent.kind, audience: supportCaseEvent.audience,
      actorKind: supportCaseEvent.actorKind, body: supportCaseEvent.body, fromState: supportCaseEvent.fromState,
      toState: supportCaseEvent.toState, decision: supportCaseEvent.decision, createdAt: supportCaseEvent.createdAt })
      .from(supportCaseEvent).where(cursor ? and(eq(supportCaseEvent.caseId, caseId), or(
        lt(supportCaseEvent.createdAt, cursor.createdAt),
        and(eq(supportCaseEvent.createdAt, cursor.createdAt), lt(supportCaseEvent.id, cursor.id)),
      )) : eq(supportCaseEvent.caseId, caseId));
    const fetched = await eventQuery.orderBy(desc(supportCaseEvent.createdAt), desc(supportCaseEvent.id)).limit(51);
    const hasMore = fetched.length > 50;
    const events = (hasMore ? fetched.slice(0, 50) : fetched).reverse();
    const last = events[0];
    const olderCursor = hasMore && last ? encodeSupportEventCursor({ createdAt: last.createdAt, id: last.id }) : null;
    await audit(tx, row, actor.userId, "SUPPORT_CASE_VIEWED", "ALLOWED");
    return { row, events, olderCursor, actorRole: actor.role };
  });
}

export async function appendStaffSupportMessage(headers: Headers, input: { caseId: string; audience: string; body: string; idempotencyKey: string }) {
  identity(input.caseId); identity(input.idempotencyKey);
  const body = supportText(input.body);
  return staffTx(headers, async (tx, actor) => {
    const row = await lockedCase(tx, input.caseId);
    const audience = input.audience;
    if (audience !== "CUSTOMER" && audience !== "INTERNAL" && audience !== "FINANCE") throw new Error("Invalid audience");
    if (audience === "FINANCE" && (row.state !== "FINANCE_REVIEW" || (actor.role !== "FINANCE" && actor.role !== "SUPER_ADMIN"))) throw new Error("Forbidden");
    if (audience !== "FINANCE" && actor.role === "FINANCE") throw new Error("Forbidden");
    const inserted = await appendHistory(tx, { caseId: row.id, actorUserId: actor.userId, actorKind: "STAFF",
      kind: audience === "CUSTOMER" ? "REPLY" : "NOTE", audience, body, idempotencyKey: input.idempotencyKey });
    if (inserted) {
      await audit(tx, row, actor.userId, "SUPPORT_STAFF_MESSAGE", audience);
    }
  });
}

export async function changeSupportState(headers: Headers, input: { caseId: string; expectedState: string; to: string; reason: string; idempotencyKey: string }) {
  identity(input.caseId); identity(input.idempotencyKey);
  const to = supportState(input.to);
  const reason = supportText(input.reason, 1000);
  return staffTx(headers, async (tx, actor) => {
    const row = await lockedCase(tx, input.caseId);
    const from = supportState(input.expectedState);
    if (row.state !== from) throw new Error("Case changed. Refresh before updating it.");
    assertSupportTransition(from, to, actor.role);
    await appendHistory(tx, { caseId: row.id, actorUserId: actor.userId, actorKind: "STAFF", kind: "STATE_CHANGED",
      audience: "INTERNAL", body: reason, fromState: from, toState: to, idempotencyKey: input.idempotencyKey });
    await tx.update(supportCase).set({ state: to, updatedAt: sql`clock_timestamp()` }).where(eq(supportCase.id, row.id));
    await audit(tx, row, actor.userId, "SUPPORT_STATE_CHANGED", to);
  });
}

export async function recordSupportFinanceDecision(headers: Headers, input: { caseId: string; decision: string; reason: string; idempotencyKey: string }) {
  identity(input.caseId); identity(input.idempotencyKey);
  const decision = financeOutcome(input.decision);
  const reason = supportText(input.reason, 1000);
  return staffTx(headers, async (tx, actor) => {
    if (actor.role !== "FINANCE" && actor.role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const row = await lockedCase(tx, input.caseId);
    if (row.state !== "FINANCE_REVIEW") throw new Error("Case is not in Finance review");
    await appendHistory(tx, { caseId: row.id, actorUserId: actor.userId, actorKind: "STAFF", kind: "FINANCE_DECISION",
      audience: "FINANCE", body: reason, decision, idempotencyKey: input.idempotencyKey });
    await appendHistory(tx, { caseId: row.id, actorUserId: actor.userId, actorKind: "STAFF", kind: "STATE_CHANGED",
      audience: "FINANCE", body: "Finance review returned to assigned Admin", fromState: "FINANCE_REVIEW", toState: "INVESTIGATING", idempotencyKey: randomUUID() });
    await tx.update(supportCase).set({ state: "INVESTIGATING", updatedAt: sql`clock_timestamp()` }).where(eq(supportCase.id, row.id));
    await audit(tx, row, actor.userId, "SUPPORT_FINANCE_REVIEW_RECORDED", decision);
  });
}
