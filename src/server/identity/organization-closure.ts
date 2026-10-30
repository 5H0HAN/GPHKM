import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizationClosureEvent, organizationClosureRequest } from "@/db/closure-schema";
import { organization } from "@/db/schema";
import { appendAuditEvent, type DbTransaction } from "@/server/audit/append";
import { requireStaffAccess, type StaffActor } from "@/server/auth/staff";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: string, max = 4000) => {
  const normalized = value.trim().replace(/\r\n?/g, "\n");
  if (normalized.length < 1 || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error("Invalid closure request text");
  return normalized;
};
const id = (value: string) => { if (!UUID.test(value)) throw new Error("Closure request unavailable"); return value; };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function staffTx<T>(headers: Headers, work: (tx: DbTransaction, actor: StaffActor) => Promise<T>) {
  const actor = await requireStaffAccess(headers, "organization.closure.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  });
}

async function appendEvent(tx: DbTransaction, input: {
  requestId: string; actorUserId: string; actorKind: "CUSTOMER" | "STAFF";
  kind: "OPENED" | "STATE_CHANGED" | "REPLY" | "NOTE"; audience: "CUSTOMER" | "INTERNAL";
  body: string; idempotencyKey: string; fromState?: string; toState?: string;
}) {
  const requestHash = digest({ ...input, idempotencyKey: undefined });
  const [prior] = await tx.select({ requestHash: organizationClosureEvent.requestHash }).from(organizationClosureEvent).where(and(
    eq(organizationClosureEvent.requestId, input.requestId), eq(organizationClosureEvent.actorUserId, input.actorUserId),
    eq(organizationClosureEvent.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error("Closure action idempotency conflict");
    return false;
  }
  await tx.insert(organizationClosureEvent).values({ id: randomUUID(), ...input, requestHash });
  return true;
}

export async function openOrganizationClosure(headers: Headers, organizationId: string, input: { summary: string; idempotencyKey: string }) {
  id(input.idempotencyKey);
  const summary = text(input.summary, 2000);
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    await tx.execute(sql`select id from public.organization where id=${organizationId} for update`);
    const requestHash = digest({ organizationId, summary });
    const [prior] = await tx.select().from(organizationClosureRequest).where(and(
      eq(organizationClosureRequest.organizationId, organizationId), eq(organizationClosureRequest.openedByUserId, actor.userId),
      eq(organizationClosureRequest.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Closure request idempotency conflict");
      return { requestId: prior.id };
    }
    const [created] = await tx.insert(organizationClosureRequest).values({ id: randomUUID(), organizationId,
      openedByUserId: actor.userId, summary, idempotencyKey: input.idempotencyKey, requestHash }).returning();
    await appendEvent(tx, { requestId: created.id, actorUserId: actor.userId, actorKind: "CUSTOMER", kind: "OPENED",
      audience: "CUSTOMER", body: summary, idempotencyKey: input.idempotencyKey, toState: "OPEN" });
    await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId, action: "organization.closure.requested",
      targetType: "organization_closure_request", targetId: created.id, metadata: { result: "OPEN" } });
    return { requestId: created.id };
  });
}

export async function listOrganizationClosureRequests(headers: Headers, organizationId: string) {
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const rows = await tx.select().from(organizationClosureRequest)
      .where(eq(organizationClosureRequest.organizationId, organizationId)).orderBy(desc(organizationClosureRequest.createdAt)).limit(20);
    const result = [];
    for (const row of rows) {
      const history = await tx.select({ id: organizationClosureEvent.id, actorKind: organizationClosureEvent.actorKind,
        kind: organizationClosureEvent.kind, body: organizationClosureEvent.body, audience: organizationClosureEvent.audience,
        createdAt: organizationClosureEvent.createdAt }).from(organizationClosureEvent)
        .where(and(eq(organizationClosureEvent.requestId, row.id), eq(organizationClosureEvent.audience, "CUSTOMER")))
        .orderBy(desc(organizationClosureEvent.createdAt)).limit(100);
      result.push({ id: row.id, summary: row.summary, state: row.state, createdAt: row.createdAt,
        updatedAt: row.updatedAt, history: history.reverse(), canReply: row.state !== "CLOSED" });
    }
    return result;
  });
}

export async function replyToOrganizationClosure(headers: Headers, organizationId: string, input: { requestId: string; body: string; idempotencyKey: string }) {
  id(input.requestId); id(input.idempotencyKey);
  const body = text(input.body, 2000);
  const actor = await requireVerifiedCustomer(headers);
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const [row] = await tx.select().from(organizationClosureRequest).where(and(
      eq(organizationClosureRequest.id, input.requestId), eq(organizationClosureRequest.organizationId, organizationId),
    )).limit(1);
    if (!row || row.state === "CLOSED") throw new Error("Closure request unavailable");
    const inserted = await appendEvent(tx, { requestId: row.id, actorUserId: actor.userId, actorKind: "CUSTOMER",
      kind: "REPLY", audience: "CUSTOMER", body, idempotencyKey: input.idempotencyKey });
    if (inserted) await appendAuditEvent(tx, { organizationId, actorUserId: actor.userId,
      action: "organization.closure.owner_reply", targetType: "organization_closure_request", targetId: row.id,
      metadata: { result: "RECORDED" } });
  });
}

export async function listStaffOrganizationClosures(headers: Headers, requestedPage?: unknown) {
  return staffTx(headers, async (tx) => {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(organizationClosureRequest);
    const pagination = staffCatalogPagination(requestedPage, count?.total ?? 0);
    const rows = await tx.select({ id: organizationClosureRequest.id,
      organizationId: organizationClosureRequest.organizationId, organizationName: organization.name,
      summary: organizationClosureRequest.summary, state: organizationClosureRequest.state,
      createdAt: organizationClosureRequest.createdAt, updatedAt: organizationClosureRequest.updatedAt })
      .from(organizationClosureRequest).innerJoin(organization, eq(organization.id, organizationClosureRequest.organizationId))
      .orderBy(desc(organizationClosureRequest.updatedAt), desc(organizationClosureRequest.id)).limit(pagination.limit).offset(pagination.offset);
    return { ...pagination, rows };
  });
}

export async function getStaffOrganizationClosure(headers: Headers, requestId: string) {
  id(requestId);
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select({ request: organizationClosureRequest, organizationName: organization.name })
      .from(organizationClosureRequest).innerJoin(organization, eq(organization.id, organizationClosureRequest.organizationId))
      .where(eq(organizationClosureRequest.id, requestId)).limit(1);
    if (!row) throw new Error("Closure request unavailable");
    const blockerResult = await tx.execute(sql`select public.gphkm_closure_blockers(${row.request.organizationId}) as blockers`);
    const blockerRow = (blockerResult as unknown as { rows?: Array<{ blockers: string[] }> }).rows?.[0];
    const history = await tx.select().from(organizationClosureEvent).where(eq(organizationClosureEvent.requestId, requestId))
      .orderBy(desc(organizationClosureEvent.createdAt)).limit(200);
    await appendAuditEvent(tx, { organizationId: row.request.organizationId, actorUserId: actor.userId,
      action: "organization.closure.viewed", targetType: "organization_closure_request", targetId: requestId,
      metadata: { result: "ALLOWED" } });
    return { ...row, blockers: blockerRow?.blockers ?? [], history: history.reverse() };
  });
}

export async function updateOrganizationClosure(headers: Headers, input: {
  requestId: string; expectedState: string; to: string; message: string; internalNote?: string; idempotencyKey: string;
}) {
  id(input.requestId); id(input.idempotencyKey);
  if (!(["INVESTIGATING", "WAITING_ON_CUSTOMER", "CLOSED"] as const).includes(input.to as never)) throw new Error("Invalid closure state");
  const message = text(input.message, 2000);
  return staffTx(headers, async (tx, actor) => {
    await tx.execute(sql`select id from public.organization_closure_request where id=${input.requestId} for update`);
    const [row] = await tx.select().from(organizationClosureRequest).where(eq(organizationClosureRequest.id, input.requestId)).limit(1);
    if (!row || row.state !== input.expectedState || row.state === "CLOSED") throw new Error("Closure request changed; refresh first");
    if (input.to === "CLOSED") {
      const result = await tx.execute(sql`select public.gphkm_closure_blockers(${row.organizationId}) as blockers`);
      const blockers = (result as unknown as { rows?: Array<{ blockers: string[] }> }).rows?.[0]?.blockers ?? [];
      if (blockers.length) throw new Error("Closure blockers remain");
    }
    await appendEvent(tx, { requestId: row.id, actorUserId: actor.userId, actorKind: "STAFF", kind: "STATE_CHANGED",
      audience: "CUSTOMER", body: message, idempotencyKey: input.idempotencyKey, fromState: row.state, toState: input.to });
    if (input.internalNote?.trim()) await appendEvent(tx, { requestId: row.id, actorUserId: actor.userId, actorKind: "STAFF",
      kind: "NOTE", audience: "INTERNAL", body: text(input.internalNote, 2000), idempotencyKey: randomUUID() });
    await appendAuditEvent(tx, { organizationId: row.organizationId, actorUserId: actor.userId,
      action: "organization.closure.state_changed", targetType: "organization_closure_request", targetId: row.id,
      metadata: { fromState: row.state, toState: input.to } });
    if (input.to === "CLOSED") {
      await tx.execute(sql`select public.gphkm_finalize_organization_closure(${row.id}, ${actor.userId})`);
      await tx.update(organizationClosureRequest).set({ state: "CLOSED", closedAt: new Date(), closedByUserId: actor.userId,
        updatedAt: sql`clock_timestamp()` }).where(eq(organizationClosureRequest.id, row.id));
    } else {
      await tx.update(organizationClosureRequest).set({ state: input.to, updatedAt: sql`clock_timestamp()` })
        .where(eq(organizationClosureRequest.id, row.id));
    }
  });
}

export async function addOrganizationClosureMessage(headers: Headers, input: { requestId: string; body: string; internal: boolean; idempotencyKey: string }) {
  id(input.requestId); id(input.idempotencyKey);
  const body = text(input.body, 2000);
  return staffTx(headers, async (tx, actor) => {
    const [row] = await tx.select().from(organizationClosureRequest).where(eq(organizationClosureRequest.id, input.requestId)).limit(1);
    if (!row || row.state === "CLOSED") throw new Error("Closure request unavailable");
    const inserted = await appendEvent(tx, { requestId: row.id, actorUserId: actor.userId, actorKind: "STAFF",
      kind: input.internal ? "NOTE" : "REPLY", audience: input.internal ? "INTERNAL" : "CUSTOMER", body,
      idempotencyKey: input.idempotencyKey });
    if (inserted) await appendAuditEvent(tx, { organizationId: row.organizationId, actorUserId: actor.userId,
      action: "organization.closure.message", targetType: "organization_closure_request", targetId: row.id,
      metadata: { result: input.internal ? "INTERNAL" : "CUSTOMER" } });
  });
}
