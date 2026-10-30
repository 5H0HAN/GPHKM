import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, session, user } from "./schema";

export const organizationInvitationStatus = pgEnum("organization_invitation_status", [
  "PENDING",
  "ACCEPTED",
  "REVOKED",
  "EXPIRED",
]);

export const userAppearancePreference = pgTable("user_appearance_preference", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  theme: text("theme", { enum: ["DARK", "LIGHT"] }).notNull().default("DARK"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check("user_appearance_theme_valid", sql`${table.theme} in ('DARK','LIGHT')`)]);

export const organizationBillingProfile = pgTable("organization_billing_profile", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id),
  legalName: text("legal_name"),
  billingEmail: text("billing_email"),
  billingAddress: text("billing_address"),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("organization_billing_legal_name_length", sql`${table.legalName} is null or length(btrim(${table.legalName})) between 1 and 160`),
  check("organization_billing_email_length", sql`${table.billingEmail} is null or length(${table.billingEmail}) between 3 and 254`),
  check("organization_billing_address_length", sql`${table.billingAddress} is null or length(btrim(${table.billingAddress})) between 1 and 1000`),
]).enableRLS();

// Only the token hash is used for acceptance. A separately encrypted copy is queued
// for the restricted email worker; application queries cannot read that outbox.
export const organizationInvitation = pgTable("organization_invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role", { enum: ["MEMBER"] }).notNull().default("MEMBER"),
  tokenHash: text("token_hash").notNull().unique(),
  status: organizationInvitationStatus("status").notNull().default("PENDING"),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => user.id),
  acceptedByUserId: text("accepted_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("organization_invitation_org_status_idx").on(table.organizationId, table.status),
  uniqueIndex("organization_invitation_pending_email_uq")
    .on(table.organizationId, sql`lower(${table.email})`)
    .where(sql`${table.status} = 'PENDING'`),
]);

export const staffMfaMethod = pgEnum("staff_mfa_method", ["TOTP", "BACKUP_CODE", "OTP"]);

// A user-level twoFactorEnabled flag is not session proof. This record is written
// server-side only after a successful Better Auth verification endpoint and is
// deleted automatically when that exact session is revoked.
export const staffMfaSession = pgTable("staff_mfa_session", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  method: staffMfaMethod("method").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("staff_mfa_session_user_idx").on(table.userId)]);

export const staffInvitationRole = pgEnum("staff_invitation_role", ["ADMIN", "FINANCE"]);
export const staffInvitationStatus = pgEnum("staff_invitation_status", ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);

// Super Admin only creates Admin/Finance invitations. The first Super Admin stays
// a one-time bootstrap operation; invitations cannot grant Super Admin.
export const staffInvitation = pgTable("staff_invitation", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  role: staffInvitationRole("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: staffInvitationStatus("status").notNull().default("PENDING"),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => user.id),
  acceptedByUserId: text("accepted_by_user_id").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("staff_invitation_status_idx").on(table.status),
  uniqueIndex("staff_invitation_pending_email_uq")
    .on(sql`lower(${table.email})`)
    .where(sql`${table.status} = 'PENDING'`),
]);

export const invitationEmailOutbox = pgTable("invitation_email_outbox", {
  id: text("id").primaryKey(),
  organizationInvitationId: text("organization_invitation_id").references(() => organizationInvitation.id),
  staffInvitationId: text("staff_invitation_id").references(() => staffInvitation.id),
  recipientEmail: text("recipient_email").notNull(),
  tokenCiphertext: text("token_ciphertext"),
  tokenNonce: text("token_nonce"),
  tokenTag: text("token_tag"),
  status: text("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  leaseId: text("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerReference: text("provider_reference"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("invitation_email_org_invitation_uq").on(table.organizationInvitationId),
  uniqueIndex("invitation_email_staff_invitation_uq").on(table.staffInvitationId),
  index("invitation_email_queue_idx").on(table.status, table.nextAttemptAt, table.createdAt),
  uniqueIndex("invitation_email_provider_ref_uq").on(table.providerReference),
  check("invitation_email_one_target", sql`(${table.organizationInvitationId} is not null and ${table.staffInvitationId} is null) or (${table.organizationInvitationId} is null and ${table.staffInvitationId} is not null)`),
  check("invitation_email_status_valid", sql`${table.status} in ('PENDING','SENDING','RETRY','SENT','UNKNOWN','FAILED','SKIPPED')`),
  check("invitation_email_attempts_valid", sql`${table.attempts} >= 0`),
  check("invitation_email_lease_shape", sql`(${table.status} = 'SENDING' and ${table.leaseId} is not null and ${table.leaseUntil} is not null) or (${table.status} <> 'SENDING' and ${table.leaseId} is null and ${table.leaseUntil} is null)`),
  check("invitation_email_sent_shape", sql`(${table.status} = 'SENT' and ${table.sentAt} is not null and ${table.providerReference} is not null) or (${table.status} <> 'SENT' and ${table.sentAt} is null)`),
  check("invitation_email_token_shape", sql`(${table.status} in ('PENDING','SENDING','RETRY') and ${table.tokenCiphertext} is not null and ${table.tokenNonce} is not null and ${table.tokenTag} is not null) or (${table.status} in ('SENT','UNKNOWN','FAILED','SKIPPED') and ${table.tokenCiphertext} is null and ${table.tokenNonce} is null and ${table.tokenTag} is null)`),
  check("invitation_email_recipient_valid", sql`length(${table.recipientEmail}) between 3 and 254 and ${table.recipientEmail} = lower(${table.recipientEmail})`),
]).enableRLS();
