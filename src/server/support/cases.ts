import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { supportCase, supportCaseEvent } from "@/db/support-schema";
import { customerOrder, customerOrderItem, orderItemFulfillment } from "@/db/order-schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { assertSupportTransition, customerCanReplyToSupportCase, customerSupportProjection, financeOutcome, supportQueueFilter, supportState, supportText, type SupportAudience } from "@/modules/support/cases";
import { staffCatalogPagination } from "@/modules/catalog/pagination";
import { decodeSupportEventCursor, encodeSupportEventCursor } from "@/modules/support/event-cursor";
import { logSafeFailure } from "@/server/observability/safe-log";
import { mayReadFulfillmentContent } from "@/modules/fulfillment/console";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identity(value: string) { if (!UUID.test(value)) throw new Error("Support request is unavailable"); return value; }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
type CaseRow = typeof supportCase.$inferSelect;
type HistoryInput = {
  caseId: string; actorUserId: string; actorKind: "CUSTOMER" | "STAFF"; kind: "REPLY" | "NOTE" | "STATE_CHANGED" | "FINANCE_DECISION";
  audience: SupportAudience; body: string; idempotencyKey: string; fromState?: string; toState?: string; decision?: string;
};

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

async function hasPriorHistory(tx: DbTransaction, input: HistoryInput) {
  const idempotencyKey = identity(input.idempotencyKey);
  const requestHash = digest({ ...input, idempotencyKey: undefined });
  const [prior] = await tx.select({ requestHash: supportCaseEvent.requestHash }).from(supportCaseEvent).where(and(
    eq(supportCaseEvent.caseId, input.caseId), eq(supportCaseEvent.actorUserId, input.actorUserId), eq(supportCaseEvent.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error("Support action idempotency conflict");
    return true;
  }
  return false;
}

async function appendHistory(tx: DbTransaction, input: HistoryInput, priorChecked = false) {
  const idempotencyKey = identity(input.idempotencyKey);
  const requestHash = digest({ ...input, idempotencyKey: undefined });
  if (!priorChecked && await hasPriorHistory(tx, input)) return false;
  await tx.insert(supportCaseEvent).values({ id: randomUUID(), ...input, idempotencyKey, requestHash });
  return true;
}

async function audit(tx: DbTransaction, row: Pick<CaseRow, "id" | "organizationId">, actorUserId: string, action: string, result: string) {
  await appendAuditEvent(tx, { organizationId: row.organizationId, actorUserId, action, targetType: "SUPPORT_CASE", targetId: row.id, metadata: { result } });
}

export async function openCustomerSupportCase(headers: Headers, organizationId: string, input: { orderId?: string; orderItemId?: string; summary: string; idempotencyKey: string }) {
  const normalizedOrderId = input.orderId ? identity(input.orderId) : null;
  const normalizedOrderItemId = input.orderItemId ? identity(input.orderItemId) : null;
  identity(input.idempotencyKey);
  const summary = supportText(input.summary, 2000);
  const actor = await requireVerifiedCustomer(headers);
  const requestHash = digest({ orderId: normalizedOrderId, orderItemId: normalizedOrderItemId, summary });
  const requestId = randomUUID();
  let stage = "support_scope";
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
    const [priorMessage] = await tx.select({ caseId: supportCaseEvent.caseId, kind: supportCaseEvent.kind,
      audience: supportCaseEvent.audience, body: supportCaseEvent.body, orderId: supportCase.orderId })
      .from(supportCaseEvent).innerJoin(supportCase, eq(supportCase.id, supportCaseEvent.caseId))
      .where(and(eq(supportCase.organizationId, organizationId), eq(supportCaseEvent.actorUserId, actor.userId),
        eq(supportCaseEvent.idempotencyKey, input.idempotencyKey))).limit(1);
    if (priorMessage) {
      if (priorMessage.body !== summary || priorMessage.orderId !== normalizedOrderId ||
          !((priorMessage.kind === "OPENED" && priorMessage.audience === "INTERNAL") ||
            (priorMessage.kind === "REPLY" && priorMessage.audience === "CUSTOMER"))) {
        throw new Error("Support action idempotency conflict");
      }
      return { caseId: priorMessage.caseId };
    }

    let requestedOrderId = normalizedOrderId;
    let contextItemId = normalizedOrderItemId;
    if (contextItemId) {
      const [item] = await tx.select({ orderId: customerOrderItem.orderId }).from(customerOrderItem)
        .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
        .where(and(eq(customerOrderItem.id, contextItemId), eq(customerOrder.organizationId, organizationId), eq(customerOrder.checkoutState, "PAID"))).limit(1);
      if (!item || (requestedOrderId && requestedOrderId !== item.orderId)) throw new Error("Order placement is unavailable");
      requestedOrderId = item.orderId;
    }
    if (requestedOrderId) {
      const [order] = await tx.select({ id: customerOrder.id }).from(customerOrder).where(and(
        eq(customerOrder.id, requestedOrderId), eq(customerOrder.organizationId, organizationId), eq(customerOrder.checkoutState, "PAID"),
      )).limit(1);
      if (!order) throw new Error("Order is unavailable");
      // All writers for an order case serialize on this tenant-scoped lock. The
      // partial unique index below remains the database-level race backstop.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        'gphkm:support-order:' || ${organizationId} || ':' || ${requestedOrderId}, 0))`);
      const [active] = await tx.select().from(supportCase).where(and(
        eq(supportCase.organizationId, organizationId), eq(supportCase.orderId, requestedOrderId),
        sql`${supportCase.state} not in ('RESOLVED','CLOSED')`, isNull(supportCase.mergedIntoCaseId),
      )).limit(1);
      if (active) {
        const message: HistoryInput = { caseId: active.id, actorUserId: actor.userId, actorKind: "CUSTOMER",
          kind: "REPLY", audience: "CUSTOMER", body: summary, idempotencyKey: input.idempotencyKey };
        await appendHistory(tx, message);
        await audit(tx, active, actor.userId, "SUPPORT_CUSTOMER_REPLY", "RECORDED");
        return { caseId: active.id, reused: true };
      }
    } else {
      contextItemId = null;
    }
    stage = "case_insert";
    const caseId = randomUUID();
    const inserted = await tx.insert(supportCase).values({
      id: caseId, organizationId, orderId: requestedOrderId, orderItemId: contextItemId,
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
    const scope = and(eq(supportCase.organizationId, organizationId), isNull(supportCase.mergedIntoCaseId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(supportCase).where(scope);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select().from(supportCase).where(scope)
      .orderBy(desc(supportCase.updatedAt), desc(supportCase.id)).limit(pagination.limit).offset(pagination.offset);
    return { ...pagination, items: rows.map((row) => customerSupportProjection(row)) };
  });
}

export async function getCustomerSupportSummary(headers: Headers, organizationId: string, recentLimit = 3) {
  const actor = await requireVerifiedCustomer(headers);
  const boundedLimit = Number.isFinite(recentLimit) ? Math.min(Math.max(Math.floor(recentLimit), 0), 10) : 3;
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const scope = and(eq(supportCase.organizationId, organizationId), isNull(supportCase.mergedIntoCaseId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`);
    const grouped = await tx.select({ state: supportCase.state, count: sql<number>`count(*)::int` })
      .from(supportCase).where(scope).groupBy(supportCase.state);
    const recentRows = boundedLimit === 0 ? [] : await tx.select({
      id: supportCase.id, orderId: supportCase.orderId, orderItemId: supportCase.orderItemId,
      summary: supportCase.summary, state: supportCase.state, createdAt: supportCase.createdAt, updatedAt: supportCase.updatedAt,
    }).from(supportCase).where(scope)
      .orderBy(desc(supportCase.updatedAt), desc(supportCase.id)).limit(boundedLimit);
    const counts = new Map(grouped.map((row) => [row.state, row.count]));
    return {
      totalCount: grouped.reduce((total, row) => total + row.count, 0),
      openCount: grouped.reduce((total, row) => total + (row.state === "RESOLVED" || row.state === "CLOSED" ? 0 : row.count), 0),
      waitingOnCustomerCount: counts.get("WAITING_ON_CUSTOMER") ?? 0,
      recent: recentRows.map((row) => customerSupportProjection(row)),
    };
  });
}

export async function getCustomerSupportCase(headers: Headers, organizationId: string, caseId: string, before?: string) {
  identity(caseId);
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx) => {
    const [direct] = await tx.select().from(supportCase).where(and(eq(supportCase.id, caseId), eq(supportCase.organizationId, organizationId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`)).limit(1);
    if (!direct) throw new Error("Support request is unavailable");
    const [row] = direct.mergedIntoCaseId
      ? await tx.select().from(supportCase).where(and(eq(supportCase.id, direct.mergedIntoCaseId), eq(supportCase.organizationId, organizationId),
        sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`)).limit(1)
      : [direct];
    if (!row) throw new Error("Support request is unavailable");
    const merged = await tx.select({ id: supportCase.id }).from(supportCase).where(and(
      eq(supportCase.mergedIntoCaseId, row.id), eq(supportCase.organizationId, organizationId),
      sql`public.gphkm_support_customer_access(${supportCase.id}, ${actor.userId}, ${organizationId})`,
    ));
    const caseIds = [row.id, ...merged.map((item) => item.id)];
    const cursor = decodeSupportEventCursor(before);
    const scope = and(inArray(supportCaseEvent.caseId, caseIds), eq(supportCaseEvent.audience, "CUSTOMER"));
    const eventQuery = tx.select().from(supportCaseEvent).where(cursor ? and(scope, or(
      lt(supportCaseEvent.createdAt, cursor.createdAt),
      and(eq(supportCaseEvent.createdAt, cursor.createdAt), lt(supportCaseEvent.id, cursor.id)),
    )) : scope);
    const fetched = await eventQuery.orderBy(desc(supportCaseEvent.createdAt), desc(supportCaseEvent.id)).limit(51);
    const hasMore = fetched.length > 50;
    const history = (hasMore ? fetched.slice(0, 50) : fetched).reverse();
    const last = history[0];
    const olderCursor = hasMore && last ? encodeSupportEventCursor({ createdAt: last.createdAt, id: last.id }) : null;
    return { ...customerSupportProjection(row, history), canReply: customerCanReplyToSupportCase(row.state), olderCursor };
  });
}

export async function replyToCustomerSupportCase(headers: Headers, organizationId: string, input: { caseId: string; body: string; idempotencyKey: string }) {
  identity(input.caseId); identity(input.idempotencyKey);
  const body = supportText(input.body);
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    const row = await lockedCase(tx, input.caseId);
    if (row.organizationId !== organizationId) throw new Error("Support request is unavailable");
    const event: HistoryInput = { caseId: row.id, actorUserId: actor.userId, actorKind: "CUSTOMER", kind: "REPLY", audience: "CUSTOMER", body, idempotencyKey: input.idempotencyKey };
    // Check the reply key before terminal-state validation: a retry of an
    // already committed reply remains successful even if staff later resolved it.
    if (await hasPriorHistory(tx, event)) return { state: row.state };
    if (!customerCanReplyToSupportCase(row.state)) throw new Error("This request is resolved. Open a new Support request for this order.");
    const inserted = await appendHistory(tx, event, true);
    if (inserted) {
      await audit(tx, row, actor.userId, "SUPPORT_CUSTOMER_REPLY", "RECORDED");
      if (row.state === "WAITING_ON_CUSTOMER") await audit(tx, row, actor.userId, "SUPPORT_STATE_CHANGED", "INVESTIGATING");
    }
    return { state: row.state === "WAITING_ON_CUSTOMER" ? "INVESTIGATING" : row.state };
  });
}

export async function listStaffSupportCases(headers: Headers, requestedPage?: unknown, requestedFilter?: unknown) {
  return staffTx(headers, async (tx, actor) => {
    const filter = supportQueueFilter(requestedFilter);
    const scope = filter === "ALL" ? undefined : filter === "ACTIVE"
      ? sql`${supportCase.state} not in ('RESOLVED','CLOSED')` : eq(supportCase.state, filter);
    const listScope = and(scope, isNull(supportCase.mergedIntoCaseId));
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(supportCase).where(listScope);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({ id: supportCase.id, orderId: supportCase.orderId, orderItemId: supportCase.orderItemId,
      state: supportCase.state, summary: supportCase.summary, updatedAt: supportCase.updatedAt,
      itemCount: sql<number>`public.gphkm_support_case_placement_count(${supportCase.id})` })
      .from(supportCase).where(listScope).orderBy(desc(supportCase.updatedAt), desc(supportCase.id)).limit(pagination.limit).offset(pagination.offset);
    return { rows, actorRole: actor.role, pagination, filter };
  });
}

export async function getStaffSupportCase(headers: Headers, caseId: string, before?: string) {
  identity(caseId);
  return staffTx(headers, async (tx, actor) => {
    const [direct] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1);
    if (!direct) throw new Error("Support request is unavailable");
    if (direct.mergedIntoCaseId) return { redirectCaseId: direct.mergedIntoCaseId, row: direct, itemContexts: [], events: [], olderCursor: null, actorRole: actor.role };
    const row = direct;
    const itemContexts = actor.role === "FINANCE" || !row.orderId ? [] : await tx.select({
      orderItemId: orderItemFulfillment.orderItemId,
      listingTitle: orderItemFulfillment.listingTitle,
      customerStatus: orderItemFulfillment.customerStatus,
      nextUpdateAt: orderItemFulfillment.nextUpdateAt,
      updatedAt: orderItemFulfillment.updatedAt,
      handedOffAt: orderItemFulfillment.handedOffAt,
      workStartedAt: orderItemFulfillment.workStartedAt,
      state: orderItemFulfillment.state,
      assignedAdminId: orderItemFulfillment.assignedAdminId,
    }).from(orderItemFulfillment).innerJoin(customerOrderItem, eq(customerOrderItem.id, orderItemFulfillment.orderItemId))
      .where(eq(customerOrderItem.orderId, row.orderId)).orderBy(orderItemFulfillment.orderItemId).limit(25);
    const scopedItemContexts = itemContexts.filter((item) => mayReadFulfillmentContent({
      role: actor.role, userId: actor.userId, assignedAdminId: item.assignedAdminId,
    })).map((item) => ({
      orderItemId: item.orderItemId,
      listingTitle: item.listingTitle,
      customerStatus: item.customerStatus,
      nextUpdateAt: item.nextUpdateAt,
      updatedAt: item.updatedAt,
      handedOffAt: item.handedOffAt,
      workStartedAt: item.workStartedAt,
      state: item.state,
    }));
    const merged = await tx.select({ id: supportCase.id }).from(supportCase).where(eq(supportCase.mergedIntoCaseId, row.id));
    const caseIds = [row.id, ...merged.map((item) => item.id)];
    const cursor = decodeSupportEventCursor(before);
    const eventQuery = tx.select({ id: supportCaseEvent.id, kind: supportCaseEvent.kind, audience: supportCaseEvent.audience,
      actorKind: supportCaseEvent.actorKind, body: supportCaseEvent.body, fromState: supportCaseEvent.fromState,
      toState: supportCaseEvent.toState, decision: supportCaseEvent.decision, createdAt: supportCaseEvent.createdAt })
      .from(supportCaseEvent).where(cursor ? and(inArray(supportCaseEvent.caseId, caseIds), or(
        lt(supportCaseEvent.createdAt, cursor.createdAt),
        and(eq(supportCaseEvent.createdAt, cursor.createdAt), lt(supportCaseEvent.id, cursor.id)),
      )) : inArray(supportCaseEvent.caseId, caseIds));
    const fetched = await eventQuery.orderBy(desc(supportCaseEvent.createdAt), desc(supportCaseEvent.id)).limit(51);
    const hasMore = fetched.length > 50;
    const events = (hasMore ? fetched.slice(0, 50) : fetched).reverse();
    const last = events[0];
    const olderCursor = hasMore && last ? encodeSupportEventCursor({ createdAt: last.createdAt, id: last.id }) : null;
    await audit(tx, row, actor.userId, "SUPPORT_CASE_VIEWED", "ALLOWED");
    return { redirectCaseId: null, row, itemContexts: scopedItemContexts, events, olderCursor, actorRole: actor.role };
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
    const event: HistoryInput = { caseId: row.id, actorUserId: actor.userId, actorKind: "STAFF", kind: "STATE_CHANGED",
      audience: "INTERNAL", body: reason, fromState: from, toState: to, idempotencyKey: input.idempotencyKey };
    // State changes are serialized by the case lock. Check the command key
    // first so an exact replay succeeds even though the expected state is stale.
    if (await hasPriorHistory(tx, event)) return { state: row.state };
    if (row.state !== from) throw new Error("Case changed. Refresh before updating it.");
    assertSupportTransition(from, to, actor.role);
    if (to === "RESOLVED" || to === "CLOSED") {
      const result = await tx.execute(sql`select public.gphkm_supplier_failure_case_can_close(${row.id}) as allowed`);
      const allowed = (result as unknown as { rows?: Array<{ allowed: boolean }> }).rows?.[0]?.allowed === true;
      if (!allowed) throw new Error("Accept the customer-approved supplier alternative or cancel/refund the placement before closing this case.");
    }
    await appendHistory(tx, event, true);
    await tx.update(supportCase).set({ state: to, updatedAt: sql`clock_timestamp()` }).where(eq(supportCase.id, row.id));
    await audit(tx, row, actor.userId, "SUPPORT_STATE_CHANGED", to);
    return { state: to };
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
