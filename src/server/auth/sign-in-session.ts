import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";
import { staffAccount, twoFactor, user as authUser } from "@/db/schema";
import { getAuthForSurface } from "@/server/auth";
import { resolveAuthSurface, type AuthSurface } from "@/server/auth/surfaces";
import { hasPendingStaffInvitation, isStaffIdentity } from "./identity-domain";

export type SignInSession = {
  email: string;
  twoFactorEnabled: boolean;
} | null;

function projectSession(user: { email: string; twoFactorEnabled?: boolean | null }): NonNullable<SignInSession> {
  return { email: user.email, twoFactorEnabled: user.twoFactorEnabled === true };
}

export async function getSignInSession(surface: AuthSurface): Promise<SignInSession> {
  const requestHeaders = await headers();
  if (resolveAuthSurface(requestHeaders, process.env) !== surface) return null;
  const authenticated = await getAuthForSurface(surface).api.getSession({ headers: requestHeaders });
  if (authenticated && (await isStaffIdentity(authenticated.user.id)) !== (surface === "staff")) return null;
  return authenticated ? projectSession(authenticated.user) : null;
}

export async function getStaffSignInState(requestHeaders: Headers): Promise<{
  session: SignInSession;
  staff: { active: boolean; twoFactorEnabled: boolean } | null;
}> {
  if (resolveAuthSurface(requestHeaders, process.env) !== "staff") return { session: null, staff: null };
  const authenticated = await getAuthForSurface("staff").api.getSession({ headers: requestHeaders });
  if (!authenticated?.user.emailVerified) return { session: null, staff: null };
  const user = authenticated.user;
  const { staff, factorReady } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
    const [staffRow] = await tx.select({ active: staffAccount.active }).from(staffAccount).where(eq(staffAccount.userId, user.id)).limit(1);
    const [account] = await tx.select({ twoFactorEnabled: authUser.twoFactorEnabled }).from(authUser).where(eq(authUser.id, user.id)).limit(1);
    const [factor] = await tx.select({ id: twoFactor.id }).from(twoFactor)
      .where(and(eq(twoFactor.userId, user.id), eq(twoFactor.verified, true))).limit(1);
    return { staff: staffRow, factorReady: Boolean(account?.twoFactorEnabled && factor) };
  });
  if (!staff && !(await hasPendingStaffInvitation(user.email))) return { session: null, staff: null };
  return { session: projectSession(user), staff: staff ? { ...staff, twoFactorEnabled: factorReady } : null };
}
