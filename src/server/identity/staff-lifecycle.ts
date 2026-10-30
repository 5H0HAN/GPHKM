import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizationMember, staffAccount, user } from "@/db/schema";
import { invitationEmailOutbox, staffInvitation } from "@/db/identity-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { getAuthForSurface } from "@/server/auth";
import { requireStaffAccess } from "@/server/auth/staff";
import { assertCanAcceptInvitation, normalizeEmail, normalizeVerifiedEmail } from "./policy";
import { createInvitationSecret, hashInvitationSecret, invitationExpiry } from "./invitation-token";
import { encryptInvitationToken } from "@/modules/identity/invitation-crypto";
import { assertOrganizationInvitationDeliveryAvailable } from "@/modules/identity/organizations";

export async function listStaffAccounts(headers: Headers) {
  const actor = await requireStaffAccess(headers, "staff.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const staff = await tx.select({
      userId: staffAccount.userId,
      name: user.name,
      email: user.email,
      role: staffAccount.role,
      active: staffAccount.active,
      twoFactorEnabled: user.twoFactorEnabled,
      verifiedTotp: sql<boolean>`exists (select 1 from public.auth_two_factor f where f.user_id = ${user.id} and f.verified)`,
      createdAt: staffAccount.createdAt,
    }).from(staffAccount)
      .innerJoin(user, eq(user.id, staffAccount.userId))
      .orderBy(asc(staffAccount.createdAt), asc(user.email))
      .limit(100);
    return staff.map((member) => ({ ...member, isCurrentUser: member.userId === actor.userId }));
  });
}

export async function inviteStaff(headers: Headers, emailInput: string, role: "ADMIN" | "FINANCE") {
  assertOrganizationInvitationDeliveryAvailable();
  const actor = await requireStaffAccess(headers, "staff.manage");
  const email = normalizeEmail(emailInput);
  const id = randomUUID();
  const secret = createInvitationSecret();
  const encrypted = encryptInvitationToken(secret, `STAFF:${id}`);
  const now = new Date();
  const expiresAt = invitationExpiry(now);

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"staff-invite:" + email}, 0))`);
    const expired = await tx.update(staffInvitation).set({ status: "EXPIRED" })
      .where(and(eq(staffInvitation.email, email), eq(staffInvitation.status, "PENDING"), sql`${staffInvitation.expiresAt} <= now()`))
      .returning({ id: staffInvitation.id });
    for (const row of expired) await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "staff.invitation_expired", targetType: "staff_invitation", targetId: row.id,
      metadata: { result: "expired" },
    });
    const [existingStaff] = await tx.select({ userId: staffAccount.userId })
      .from(user)
      .innerJoin(staffAccount, eq(staffAccount.userId, user.id))
      .where(sql`lower(${user.email}) = ${email}`)
      .limit(1);
    if (existingStaff) throw new Error("User is already a staff account");
    await tx.insert(staffInvitation).values({
      id,
      email,
      role,
      tokenHash: hashInvitationSecret(secret),
      status: "PENDING",
      invitedByUserId: actor.userId,
      createdAt: now,
      expiresAt,
    });
    await tx.execute(sql`select public.gphkm_enqueue_invitation_email(${randomUUID()}, 'STAFF', ${id},
      ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.tag})`);
    await appendAuditEvent(tx, {
      actorUserId: actor.userId,
      action: "staff.invitation_created",
      targetType: "staff_invitation",
      targetId: id,
      metadata: { result: role },
    });
  });
  return { id, email, role, expiresAt, deliveryStatus: "PENDING" as const };
}

export async function listStaffInvitations(headers: Headers) {
  const actor = await requireStaffAccess(headers, "staff.manage");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const invitations = await tx.select({ id: staffInvitation.id, email: staffInvitation.email, role: staffInvitation.role,
      status: staffInvitation.status, createdAt: staffInvitation.createdAt, expiresAt: staffInvitation.expiresAt,
      deliveryStatus: invitationEmailOutbox.status })
      .from(staffInvitation).leftJoin(invitationEmailOutbox, eq(invitationEmailOutbox.staffInvitationId, staffInvitation.id))
      .orderBy(desc(staffInvitation.createdAt)).limit(100);
    return invitations.map((invite) => ({ ...invite,
      displayStatus: invite.status === "PENDING" && invite.expiresAt <= new Date() ? "EXPIRED" : invite.status,
      canRevoke: invite.status === "PENDING" && invite.expiresAt > new Date(),
    }));
  });
}

export async function revokeStaffInvitation(headers: Headers, invitationId: string) {
  const actor = await requireStaffAccess(headers, "staff.manage");
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) throw new Error("Invitation unavailable");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const [revoked] = await tx.update(staffInvitation).set({ status: "REVOKED", revokedAt: new Date() })
      .where(and(eq(staffInvitation.id, invitationId), eq(staffInvitation.status, "PENDING"), sql`${staffInvitation.expiresAt} > now()`))
      .returning({ id: staffInvitation.id });
    if (!revoked) throw new Error("Invitation unavailable");
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "staff.invitation_revoked",
      targetType: "staff_invitation", targetId: invitationId, metadata: { result: "revoked" } });
  });
}

export async function acceptStaffInvitation(headers: Headers, token: string) {
  const authSession = await getAuthForSurface("staff").api.getSession({ headers });
  if (!authSession?.user.emailVerified) throw new Error("Unauthorized");
  if (typeof token !== "string" || token.length > 128 || token.length < 32) throw new Error("Invitation unavailable");
  const email = normalizeVerifiedEmail(authSession.user.email, authSession.user.emailVerified);
  const tokenHash = hashInvitationSecret(token);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${authSession.user.id}, true)`);
    await tx.execute(sql`select set_config('app.staff_invitation_token_hash', ${tokenHash}, true)`);
    const [invite] = await tx.select().from(staffInvitation)
      .where(eq(staffInvitation.tokenHash, tokenHash))
      .for("update")
      .limit(1);
    if (!invite) throw new Error("Invitation unavailable");
    assertCanAcceptInvitation(invite, email, authSession.user.emailVerified);
    const [existing] = await tx.select({ userId: staffAccount.userId })
      .from(staffAccount)
      .where(eq(staffAccount.userId, authSession.user.id))
      .limit(1);
    if (existing) throw new Error("Staff invitation unavailable");
    const [customerMembership] = await tx.select({ organizationId: organizationMember.organizationId })
      .from(organizationMember)
      .where(eq(organizationMember.userId, authSession.user.id))
      .limit(1);
    if (customerMembership) throw new Error("Customer accounts cannot be provisioned as staff");

    await tx.insert(staffAccount).values({
      userId: authSession.user.id,
      role: invite.role,
      active: false,
    });
    const [accepted] = await tx.update(staffInvitation)
      .set({ status: "ACCEPTED", acceptedByUserId: authSession.user.id, acceptedAt: new Date() })
      .where(and(eq(staffInvitation.id, invite.id), eq(staffInvitation.status, "PENDING")))
      .returning({ id: staffInvitation.id });
    if (!accepted) throw new Error("Invitation unavailable");
    await appendAuditEvent(tx, {
      actorUserId: authSession.user.id,
      action: "staff.invitation_accepted",
      targetType: "staff_invitation",
      targetId: invite.id,
      metadata: { result: invite.role },
    });
    return { role: invite.role, active: false };
  });
}

export async function activateStaff(headers: Headers, targetUserId: string) {
  const actor = await requireStaffAccess(headers, "staff.manage");
  if (actor.userId === targetUserId) throw new Error("A second Super Admin must activate this account");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select public.gphkm_activate_staff(${targetUserId})`);
  });
}

export async function changeStaffRole(headers: Headers, targetUserId: string, role: "ADMIN" | "FINANCE") {
  const actor = await requireStaffAccess(headers, "staff.manage");
  if (actor.userId === targetUserId) throw new Error("A second Super Admin must change this account");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select public.gphkm_change_staff_role(${targetUserId}, ${role}) as changed`);
    return Boolean((result as unknown as { rows: Array<{ changed: boolean }> }).rows[0]?.changed);
  });
}

export async function deactivateStaff(headers: Headers, targetUserId: string, reasonCode: string) {
  const actor = await requireStaffAccess(headers, "staff.manage");
  if (actor.userId === targetUserId) throw new Error("A second Super Admin must deactivate this account");
  if (!/^[A-Z0-9_]{2,64}$/.test(reasonCode)) throw new Error("Valid reason code required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    await tx.execute(sql`select public.gphkm_deactivate_staff(${targetUserId}, ${reasonCode})`);
  });
}
