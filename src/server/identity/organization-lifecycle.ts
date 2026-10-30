import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationMember, staffAccount, user } from "@/db/schema";
import { invitationEmailOutbox, organizationInvitation } from "@/db/identity-schema";
import { organizationBillingProfile } from "@/db/identity-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { ensureWalletAccount } from "@/server/wallet/accounts";
import { getAuthForSurface } from "@/server/auth";
import { withOrganizationContext, withProtectedOrganizationContext } from "./customer-context";
import {
  normalizeEmail,
} from "./policy";
import { createInvitationSecret, hashInvitationSecret, invitationExpiry } from "./invitation-token";
import { encryptInvitationToken } from "@/modules/identity/invitation-crypto";
import { recordLegalAcceptance, requireCurrentLegalAcceptance } from "@/server/legal/consent";
import type { LegalAcceptanceInput } from "@/modules/legal/policy";
import { assertOrganizationInvitationDeliveryAvailable, invitationDisplayStatus, normalizeOrganizationName, organizationInvitationDeliveryStatus } from "@/modules/identity/organizations";

export async function createFirstOrganization(headers: Headers, requestedName: string, legalAcceptance: LegalAcceptanceInput) {
  const authSession = await getAuthForSurface("customer").api.getSession({ headers });
  if (!authSession?.user.emailVerified) throw new Error("Unauthorized");
  const name = normalizeOrganizationName(requestedName);
  const actorUserId = authSession.user.id;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actorUserId}, true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actorUserId}, 0))`);
    const [staffIdentity] = await tx.select({ userId: staffAccount.userId })
      .from(staffAccount).where(eq(staffAccount.userId, actorUserId)).limit(1);
    if (staffIdentity) throw new Error("Staff accounts cannot join a customer organization");
    await recordLegalAcceptance(tx, actorUserId, legalAcceptance);
    const [existingMembership] = await tx.select({ organizationId: organizationMember.organizationId, role: organizationMember.role })
      .from(organizationMember)
      .where(and(eq(organizationMember.userId, actorUserId), eq(organizationMember.active, true)))
      .limit(1);
    if (existingMembership) {
      const [existingOrganization] = await tx.select({ id: organization.id, name: organization.name })
        .from(organization).where(eq(organization.id, existingMembership.organizationId)).limit(1);
      if (!existingOrganization) throw new Error("Organization unavailable");
      await tx.execute(sql`select set_config('app.organization_id', ${existingOrganization.id}, true)`);
      await ensureWalletAccount(tx, existingOrganization.id);
      return { ...existingOrganization, role: existingMembership.role as "OWNER" | "MEMBER" };
    }

    const organizationId = randomUUID();
    await tx.insert(organization).values({ id: organizationId, name, createdBy: actorUserId });
    await tx.insert(organizationMember).values({
      id: randomUUID(),
      organizationId,
      userId: actorUserId,
      role: "OWNER",
      active: true,
    });
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    await ensureWalletAccount(tx, organizationId);
    await appendAuditEvent(tx, {
      organizationId,
      actorUserId,
      action: "organization.created",
      targetType: "organization",
      targetId: organizationId,
      metadata: { result: "created" },
    });
    return { id: organizationId, name, role: "OWNER" as const };
  });
}

export async function inviteOrganizationMember(headers: Headers, organizationId: string, emailInput: string) {
  assertOrganizationInvitationDeliveryAvailable();
  const actor = await getAuthForSurface("customer").api.getSession({ headers });
  if (!actor?.user.emailVerified) throw new Error("Unauthorized");
  const email = normalizeEmail(emailInput);
  const invitationId = randomUUID();
  const secret = createInvitationSecret();
  const encrypted = encryptInvitationToken(secret, `ORGANIZATION:${invitationId}`);
  const now = new Date();
  const expiresAt = invitationExpiry(now);

  const invitation = await withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const [openOrganization] = await tx.select({ id: organization.id }).from(organization)
      .where(and(eq(organization.id, organizationId), sql`${organization.closedAt} is null`)).for("update").limit(1);
    if (!openOrganization) throw new Error("Organization unavailable");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"org-invite:" + organizationId + ":" + email}, 0))`);
    const expired = await tx.update(organizationInvitation).set({ status: "EXPIRED" })
      .where(and(eq(organizationInvitation.organizationId, organizationId), eq(organizationInvitation.email, email),
        eq(organizationInvitation.status, "PENDING"), sql`${organizationInvitation.expiresAt} <= now()`))
      .returning({ id: organizationInvitation.id });
    for (const row of expired) await appendAuditEvent(tx, {
      organizationId, actorUserId: actor.user.id, action: "organization.invitation_expired",
      targetType: "organization_invitation", targetId: row.id, metadata: { result: "expired" },
    });
    const [existing] = await tx.select({ id: organizationMember.id })
      .from(organizationMember)
      .innerJoin(user, eq(organizationMember.userId, user.id))
      .where(and(
        eq(organizationMember.organizationId, organizationId),
        eq(organizationMember.active, true),
        sql`lower(${user.email}) = ${email}`,
      )).limit(1);
    if (existing) throw new Error("User already belongs to this organization");

    await tx.insert(organizationInvitation).values({
      id: invitationId,
      organizationId,
      email,
      role: "MEMBER",
      tokenHash: hashInvitationSecret(secret),
      status: "PENDING",
      invitedByUserId: actor.user.id,
      createdAt: now,
      expiresAt,
    });
    await tx.execute(sql`select public.gphkm_enqueue_invitation_email(${randomUUID()}, 'ORGANIZATION', ${invitationId},
      ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.tag})`);
    await appendAuditEvent(tx, {
      organizationId,
      actorUserId: actor.user.id,
      action: "organization.invitation_created",
      targetType: "organization_invitation",
      targetId: invitationId,
      metadata: { result: "pending" },
    });
    return { id: invitationId, expiresAt, deliveryStatus: "PENDING" as const };
  });

  return { ...invitation, email };
}

export async function acceptOrganizationInvitation(headers: Headers, token: string) {
  const actor = await getAuthForSurface("customer").api.getSession({ headers });
  if (!actor?.user.emailVerified) throw new Error("Unauthorized");
  if (typeof token !== "string" || token.length > 128 || token.length < 32) throw new Error("Invitation unavailable");
  const tokenHash = hashInvitationSecret(token);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.user.id}, true)`);
    await requireCurrentLegalAcceptance(tx, actor.user.id);
    await tx.execute(sql`select set_config('app.invitation_token_hash', ${tokenHash}, true)`);
    const [invite] = await tx.select({ id: organizationInvitation.id }).from(organizationInvitation)
      .where(eq(organizationInvitation.tokenHash, tokenHash)).limit(1);
    if (!invite) throw new Error("Invitation unavailable");
    const { rows } = await tx.execute(sql`select public.gphkm_accept_organization_invitation(${invite.id}, ${randomUUID()}) as organization_id`);
    const organizationId = (rows as Array<{ organization_id: string }>)[0]?.organization_id;
    if (!organizationId) throw new Error("Invitation unavailable");
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return { organizationId, role: "MEMBER" as const };
  });
}

export async function revokeOrganizationInvitation(headers: Headers, organizationId: string, invitationId: string) {
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const [revoked] = await tx.update(organizationInvitation)
      .set({ status: "REVOKED", revokedAt: new Date() })
      .where(and(
        eq(organizationInvitation.id, invitationId),
        eq(organizationInvitation.organizationId, organizationId),
        eq(organizationInvitation.status, "PENDING"),
      ))
      .returning({ id: organizationInvitation.id });
    if (!revoked) throw new Error("Invitation unavailable");
    const actor = await getAuthForSurface("customer").api.getSession({ headers });
    await appendAuditEvent(tx, {
      organizationId,
      actorUserId: actor?.user.id,
      action: "organization.invitation_revoked",
      targetType: "organization_invitation",
      targetId: invitationId,
      metadata: { result: "revoked" },
    });
  });
}

export async function promoteOrganizationMember(headers: Headers, organizationId: string, memberUserId: string) {
  const actor = await getAuthForSurface("customer").api.getSession({ headers });
  if (!actor?.user.emailVerified) throw new Error("Unauthorized");
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    await tx.execute(sql`select public.gphkm_promote_organization_member(${organizationId}, ${memberUserId})`);
  });
}

export async function removeOrganizationMember(headers: Headers, organizationId: string, memberUserId: string) {
  const actor = await getAuthForSurface("customer").api.getSession({ headers });
  if (!actor?.user.emailVerified) throw new Error("Unauthorized");
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    await tx.execute(sql`select public.gphkm_remove_organization_member(${organizationId}, ${memberUserId})`);
  });
}

export async function getOrganizationSettings(headers: Headers, organizationId: string) {
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    const [current] = await tx.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.id, organizationId)).limit(1);
    if (!current) throw new Error("Organization unavailable");
    if (role !== "OWNER") return { organization: current, role, members: [], invitations: [], billingProfile: null, delivery: organizationInvitationDeliveryStatus() };
    const members = await tx.select({ userId: organizationMember.userId, role: organizationMember.role, name: user.name, email: user.email })
      .from(organizationMember).innerJoin(user, eq(user.id, organizationMember.userId))
      .where(and(eq(organizationMember.organizationId, organizationId), eq(organizationMember.active, true))).orderBy(asc(user.name));
    const invitations = await tx.select({ id: organizationInvitation.id, email: organizationInvitation.email, status: organizationInvitation.status,
      createdAt: organizationInvitation.createdAt, expiresAt: organizationInvitation.expiresAt,
      deliveryStatus: invitationEmailOutbox.status })
      .from(organizationInvitation).leftJoin(invitationEmailOutbox, eq(invitationEmailOutbox.organizationInvitationId, organizationInvitation.id))
      .where(eq(organizationInvitation.organizationId, organizationId)).orderBy(desc(organizationInvitation.createdAt)).limit(100);
    const [billingProfile] = await tx.select({ legalName: organizationBillingProfile.legalName,
      billingEmail: organizationBillingProfile.billingEmail, billingAddress: organizationBillingProfile.billingAddress,
      updatedAt: organizationBillingProfile.updatedAt })
      .from(organizationBillingProfile).where(eq(organizationBillingProfile.organizationId, organizationId)).limit(1);
    return { organization: current, role, members, billingProfile: billingProfile ?? { legalName: null, billingEmail: null, billingAddress: null, updatedAt: null }, invitations: invitations.map((invite) => ({ ...invite,
      displayStatus: invitationDisplayStatus(invite.status, invite.expiresAt), canRevoke: invitationDisplayStatus(invite.status, invite.expiresAt) === "PENDING" })), delivery: organizationInvitationDeliveryStatus() };
  });
}

export async function renameOrganization(headers: Headers, organizationId: string, requestedName: string, expectedName: string) {
  const name = normalizeOrganizationName(requestedName);
  const actor = await getAuthForSurface("customer").api.getSession({ headers });
  if (!actor?.user.emailVerified) throw new Error("Unauthorized");
  return withProtectedOrganizationContext(headers, organizationId, async (tx, role) => {
    if (role !== "OWNER") throw new Error("Forbidden");
    const [current] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, organizationId)).for("update").limit(1);
    if (!current || current.name !== expectedName) throw new Error("Organization changed. Refresh before saving.");
    if (current.name === name) return;
    await tx.update(organization).set({ name }).where(eq(organization.id, organizationId));
    await appendAuditEvent(tx, { organizationId, actorUserId: actor.user.id, action: "organization.name_changed", targetType: "organization", targetId: organizationId, metadata: { result: "UPDATED" } });
  });
}
