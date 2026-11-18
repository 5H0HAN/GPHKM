import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { account, staffAccount, user } from "@/db/schema";
import type { AuthSurface } from "./surfaces";

export async function isStaffIdentity(userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    const [staff] = await tx.select({ userId: staffAccount.userId }).from(staffAccount).where(eq(staffAccount.userId, userId)).limit(1);
    return Boolean(staff);
  });
}

export async function hasPendingStaffInvitation(email: string): Promise<boolean> {
  const result = await db.execute(sql`select public.gphkm_staff_email_has_pending_invitation(${email.trim().toLowerCase()}) as allowed`);
  return Boolean((result as unknown as { rows: Array<{ allowed: boolean }> }).rows[0]?.allowed);
}

export async function hasPasswordCredential(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, "credential"), isNotNull(account.password))).limit(1);
  return Boolean(row);
}

export async function resetTokenAllowedForSurface(userId: string, surface: AuthSurface): Promise<boolean> {
  const staff = await isStaffIdentity(userId);
  if (surface === "customer") {
    if (staff || !await hasPasswordCredential(userId)) return false;
    const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
    return Boolean(row && !await hasPendingStaffInvitation(row.email));
  }
  if (staff) return true;
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  if (!row || !await hasPendingStaffInvitation(row.email)) return false;
  const result = await db.execute(sql`select public.gphkm_staff_invitation_email_available(${row.email.trim().toLowerCase()}) as allowed`);
  return Boolean((result as unknown as { rows: Array<{ allowed: boolean }> }).rows[0]?.allowed);
}
