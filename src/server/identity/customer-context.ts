import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationMember } from "@/db/schema";
import { getAuthForSurface } from "@/server/auth";
import { resolveAuthSurface } from "@/server/auth/surfaces";
import { isStaffIdentity } from "@/server/auth/identity-domain";
import type { DbTransaction } from "@/server/audit/append";
import { requireCurrentLegalAcceptance } from "@/server/legal/consent";
import { logSafeEvent } from "@/server/observability/safe-log";

export async function requireVerifiedCustomer(headers: Headers) {
  const requestId = randomUUID();
  if (resolveAuthSurface(headers, process.env) !== "customer") {
    logSafeEvent("customer_authorization_denied", requestId, { surface: "wrong_surface", reasonCode: "WRONG_AUTH_SURFACE" });
    throw new Error("Unauthorized");
  }
  const result = await getAuthForSurface("customer").api.getSession({ headers });
  if (!result || !result.user.emailVerified) {
    logSafeEvent("customer_authorization_denied", requestId, {
      ...(result ? { actorId: result.user.id } : {}), surface: "customer",
      reasonCode: !result ? "NO_SESSION" : "EMAIL_UNVERIFIED",
    });
    throw new Error("Unauthorized");
  }
  if (await isStaffIdentity(result.user.id)) {
    logSafeEvent("customer_authorization_denied", requestId, {
      actorId: result.user.id, surface: "customer", reasonCode: "STAFF_IDENTITY_NOT_CUSTOMER",
    });
    throw new Error("Forbidden");
  }
  return { userId: result.user.id, email: result.user.email.toLowerCase(), name: result.user.name };
}

export async function listMyOrganizations(headers: Headers) {
  const actor = await requireVerifiedCustomer(headers);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const rows = await tx.select({
      id: organization.id,
      name: organization.name,
      role: organizationMember.role,
      createdAt: organization.createdAt,
    }).from(organizationMember)
      .innerJoin(organization, eq(organizationMember.organizationId, organization.id))
      .where(and(eq(organizationMember.userId, actor.userId), eq(organizationMember.active, true)));
    return rows;
  });
}

export async function withOrganizationContext<T>(
  headers: Headers,
  requestedOrganizationId: string,
  work: (tx: DbTransaction, role: "OWNER" | "MEMBER") => Promise<T>,
  requireLegalAcceptance = false,
): Promise<T> {
  const actor = await requireVerifiedCustomer(headers);
  if (!requestedOrganizationId || requestedOrganizationId.length > 128) throw new Error("Forbidden");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [membership] = await tx.select({ role: organizationMember.role })
      .from(organizationMember)
      .where(and(
        eq(organizationMember.organizationId, requestedOrganizationId),
        eq(organizationMember.userId, actor.userId),
        eq(organizationMember.active, true),
      )).limit(1);
    if (!membership) throw new Error("Forbidden");
    await tx.execute(sql`select set_config('app.organization_id', ${requestedOrganizationId}, true)`);
    if (requireLegalAcceptance) await requireCurrentLegalAcceptance(tx, actor.userId);
    return work(tx, membership.role);
  });
}

export function withProtectedOrganizationContext<T>(
  headers: Headers,
  requestedOrganizationId: string,
  work: (tx: DbTransaction, role: "OWNER" | "MEMBER") => Promise<T>,
): Promise<T> {
  return withOrganizationContext(headers, requestedOrganizationId, work, true);
}
