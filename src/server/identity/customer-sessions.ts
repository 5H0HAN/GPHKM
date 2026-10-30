import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { session } from "@/db/schema";
import { getAuthForSurface } from "@/server/auth";
import { requireVerifiedCustomer } from "./customer-context";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function listCustomerSessions(headers: Headers) {
  const actor = await requireVerifiedCustomer(headers);
  const auth = getAuthForSurface("customer");
  const current = await auth.api.getSession({ headers });
  if (!current || current.user.id !== actor.userId) throw new Error("Unauthorized");
  const now = new Date();
  const sessions = await db.select({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt })
    .from(session).where(and(eq(session.userId, actor.userId), gt(session.expiresAt, now)))
    .orderBy(desc(session.createdAt));
  return sessions.map((item) => ({
    id: item.id,
    current: item.id === current.session.id,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  }));
}

export async function revokeCustomerSession(headers: Headers, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new Error("Session unavailable");
  const actor = await requireVerifiedCustomer(headers);
  const auth = getAuthForSurface("customer");
  const current = await auth.api.getSession({ headers });
  if (!current || current.user.id !== actor.userId || current.session.id === sessionId) throw new Error("Session unavailable");
  // Better Auth's list-sessions endpoint enforces its configured freshAge.
  const target = (await auth.api.listSessions({ headers })).find((item) => item.id === sessionId);
  if (!target || target.userId !== actor.userId) throw new Error("Session unavailable");
  const result = await auth.api.revokeSession({ headers, body: { token: target.token } });
  if (!result.status) throw new Error("Session could not be revoked");
}

export async function revokeOtherCustomerSessions(headers: Headers) {
  const actor = await requireVerifiedCustomer(headers);
  const auth = getAuthForSurface("customer");
  const current = await auth.api.getSession({ headers });
  if (!current || current.user.id !== actor.userId) throw new Error("Unauthorized");
  // revoke-other-sessions only requires a valid session, so call the built-in
  // fresh-session endpoint first to enforce the recent sign-in requirement.
  await auth.api.listSessions({ headers });
  const result = await auth.api.revokeOtherSessions({ headers });
  if (!result.status) throw new Error("Sessions could not be revoked");
}
