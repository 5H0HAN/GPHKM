import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { staffAccount, twoFactor } from "@/db/schema";
import { staffMfaSession } from "@/db/identity-schema";
import { getAuthForSurface } from "./index";
import { resolveAuthSurface } from "./surfaces";
import { localStaffMfaDisabled } from "./policy";
import { assertStaffPermission, hasStaffPermission, type StaffPermission, type StaffRole } from "../identity/policy";
import { logSafeEvent } from "@/server/observability/safe-log";

export type StaffActor = {
  userId: string;
  sessionId: string;
  role: StaffRole;
};

const getStaffActorForRequest = cache(async (headers: Headers): Promise<StaffActor> => {
  const requestId = randomUUID();
  const skipLocalMfaProof = localStaffMfaDisabled(process.env);
  if (resolveAuthSurface(headers, process.env) !== "staff") {
    logSafeEvent("staff_authorization_denied", requestId, { surface: "wrong_surface", reasonCode: "WRONG_AUTH_SURFACE" });
    throw new Error("Unauthorized");
  }
  const authenticated = await getAuthForSurface("staff").api.getSession({ headers });
  if (!authenticated) {
    logSafeEvent("staff_authorization_denied", requestId, { surface: "staff", reasonCode: "NO_VERIFIED_SESSION" });
    throw new Error("Unauthorized");
  }

  const { staff, mfaReady } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${authenticated.user.id}, true)`);
    const [staffRow] = await tx.select({ role: staffAccount.role, active: staffAccount.active })
      .from(staffAccount).where(eq(staffAccount.userId, authenticated.user.id)).limit(1);
    if (!staffRow || !staffRow.active) return { staff: staffRow, mfaReady: false };
    if (skipLocalMfaProof) return { staff: staffRow, mfaReady: true };
    if (!("twoFactorEnabled" in authenticated.user) || authenticated.user.twoFactorEnabled !== true) {
      return { staff: staffRow, mfaReady: false };
    }
    const [verifiedFactor] = await tx.select({ id: twoFactor.id }).from(twoFactor)
      .where(and(eq(twoFactor.userId, authenticated.user.id), eq(twoFactor.verified, true))).limit(1);
    if (!verifiedFactor) return { staff: staffRow, mfaReady: false };
    const [proof] = await tx.select({ sessionId: staffMfaSession.sessionId })
      .from(staffMfaSession)
      .where(and(
        eq(staffMfaSession.sessionId, authenticated.session.id),
        eq(staffMfaSession.userId, authenticated.user.id),
      )).limit(1);
    return { staff: staffRow, mfaReady: Boolean(proof) };
  });

  if (!staff || !staff.active) {
    logSafeEvent("staff_authorization_denied", requestId, {
      actorId: authenticated.user.id, surface: "staff",
      reasonCode: "STAFF_INACTIVE_OR_UNPROVISIONED",
    });
    throw new Error("Forbidden");
  }
  if (!mfaReady) {
    logSafeEvent("staff_authorization_denied", requestId, {
      actorId: authenticated.user.id, surface: "staff", reasonCode: "STAFF_MFA_UNVERIFIED",
    });
    throw new Error("Forbidden");
  }
  return { userId: authenticated.user.id, sessionId: authenticated.session.id, role: staff.role as StaffRole };
});

export async function requireStaffAccess(headers: Headers, permission: StaffPermission): Promise<StaffActor> {
  const actor = await getStaffActorForRequest(headers);
  const role = actor.role;
  if (!hasStaffPermission(role, permission)) {
    logSafeEvent("staff_authorization_denied", randomUUID(), { actorId: actor.userId, permission, surface: "staff", reasonCode: "ROLE_PERMISSION_DENIED" });
    assertStaffPermission(role, permission);
  }
  return actor;
}
