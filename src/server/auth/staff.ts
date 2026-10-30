import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffAccount } from "@/db/schema";
import { staffMfaSession } from "@/db/identity-schema";
import { getAuthForSurface } from "./index";
import { resolveAuthSurface } from "./surfaces";
import { assertStaffPermission, hasStaffPermission, type StaffPermission, type StaffRole } from "../identity/policy";
import { logSafeEvent } from "@/server/observability/safe-log";

export type StaffActor = {
  userId: string;
  sessionId: string;
  role: StaffRole;
};

export async function requireStaffAccess(headers: Headers, permission: StaffPermission): Promise<StaffActor> {
  const requestId = randomUUID();
  if (resolveAuthSurface(headers, process.env) !== "staff") {
    logSafeEvent("staff_authorization_denied", requestId, { permission, surface: "wrong_surface", reasonCode: "WRONG_AUTH_SURFACE" });
    throw new Error("Unauthorized");
  }
  const authenticated = await getAuthForSurface("staff").api.getSession({ headers });
  if (!authenticated) {
    logSafeEvent("staff_authorization_denied", requestId, { permission, surface: "staff", reasonCode: "NO_VERIFIED_SESSION" });
    throw new Error("Unauthorized");
  }

  const { staff, verifiedSession } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${authenticated.user.id}, true)`);
    const [staffRow] = await tx.select({ role: staffAccount.role, active: staffAccount.active })
      .from(staffAccount).where(eq(staffAccount.userId, authenticated.user.id)).limit(1);
    if (!staffRow || !staffRow.active || !authenticated.user.twoFactorEnabled) return { staff: null, verifiedSession: null };
    const [proof] = await tx.select({ sessionId: staffMfaSession.sessionId })
      .from(staffMfaSession)
      .where(and(
        eq(staffMfaSession.sessionId, authenticated.session.id),
        eq(staffMfaSession.userId, authenticated.user.id),
      )).limit(1);
    return { staff: staffRow, verifiedSession: proof };
  });

  if (!staff || !verifiedSession) {
    logSafeEvent("staff_authorization_denied", requestId, {
      actorId: authenticated.user.id, permission, surface: "staff",
      reasonCode: !staff ? "STAFF_INACTIVE_OR_UNPROVISIONED" : "STAFF_MFA_UNVERIFIED",
    });
    throw new Error("Forbidden");
  }
  const role = staff.role as StaffRole;
  if (!hasStaffPermission(role, permission)) {
    logSafeEvent("staff_authorization_denied", requestId, { actorId: authenticated.user.id, permission, surface: "staff", reasonCode: "ROLE_PERMISSION_DENIED" });
    assertStaffPermission(role, permission);
  }

  return { userId: authenticated.user.id, sessionId: authenticated.session.id, role };
}
