import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
});

export const session = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [index("auth_session_user_idx").on(table.userId)]);

export const account = pgTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [index("auth_account_user_idx").on(table.userId)]);

export const verification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [index("auth_verification_identifier_idx").on(table.identifier)]);

export const twoFactor = pgTable("auth_two_factor", {
  id: text("id").primaryKey(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: timestamp("locked_until"),
}, (table) => [index("auth_two_factor_user_idx").on(table.userId)]);

// Short-lived Better Auth request counters use PostgreSQL so limits survive
// process restarts and remain consistent across app instances.
const betterAuthRateLimitTable = (name: string) => pgTable(name, {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (table) => [index(`${name}_last_request_idx`).on(table.lastRequest)]);

export const rateLimit = betterAuthRateLimitTable("auth_rate_limit");
export const staffRateLimit = betterAuthRateLimitTable("auth_staff_rate_limit");

// Staff authority is never derived from customer membership or a user-editable profile.
export const staffAccount = pgTable("staff_account", {
  userId: text("user_id").primaryKey().references(() => user.id),
  role: text("role", { enum: ["ADMIN", "FINANCE", "SUPER_ADMIN"] }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [check("staff_role_valid", sql`${table.role} in ('ADMIN', 'FINANCE', 'SUPER_ADMIN')`)]);

// Immutable one-time setup evidence survives staff deactivation. Runtime cannot modify it.
export const staffBootstrap = pgTable("staff_bootstrap", {
  id: integer("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  action: text("action").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [check("single_staff_bootstrap", sql`${table.id} = 1`)]);

// Initial fixture storage only. Runtime tenant access remains denied until the identity slice.
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull().unique().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}).enableRLS();

export const organizationMember = pgTable("organization_member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  userId: text("user_id").notNull().references(() => user.id),
  role: text("role", { enum: ["OWNER", "MEMBER"] }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("organization_member_unique").on(table.organizationId, table.userId),
  check("organization_member_role_valid", sql`${table.role} in ('OWNER', 'MEMBER')`),
]).enableRLS();

// The balance is a database-maintained projection of append-only ledger entries.
export const walletAccount = pgTable("wallet_account", {
  organizationId: text("organization_id").primaryKey().references(() => organization.id),
  currency: text("currency").notNull().default("USD"),
  balanceMinor: numeric("balance_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("wallet_account_usd_only", sql`${table.currency} = 'USD'`),
  check("wallet_account_nonnegative", sql`${table.balanceMinor} >= 0`),
]).enableRLS();

export const walletLedgerEntry = pgTable("wallet_ledger_entry", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  actorUserId: text("actor_user_id").references(() => user.id),
  kind: text("kind").notNull(),
  deltaMinor: numeric("delta_minor", { precision: 20, scale: 0 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  relatedType: text("related_type"),
  relatedId: text("related_id"),
  reasonCode: text("reason_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("wallet_ledger_idempotency_unique").on(table.organizationId, table.operation, table.idempotencyKey),
  index("wallet_ledger_org_created_idx").on(table.organizationId, table.createdAt),
  index("wallet_ledger_item_refund_lookup_idx").on(table.organizationId, table.relatedId).where(
    sql`${table.kind} = 'ITEM_REFUND' and ${table.relatedType} = 'CUSTOMER_ORDER_ITEM'`,
  ),
  check("wallet_ledger_usd_only", sql`${table.currency} = 'USD'`),
  check("wallet_ledger_kind_valid", sql`${table.kind} in ('TOP_UP', 'ORDER_DEBIT', 'ITEM_REFUND', 'REVERSAL', 'ADJUSTMENT')`),
  check("wallet_ledger_nonzero", sql`${table.deltaMinor} <> 0`),
  check("wallet_ledger_kind_sign", sql`(${table.kind} = 'ORDER_DEBIT' and ${table.deltaMinor} < 0) or (${table.kind} = 'REVERSAL' and ${table.deltaMinor} <> 0) or (${table.kind} not in ('ORDER_DEBIT','REVERSAL') and ${table.deltaMinor} > 0)`),
  check("wallet_ledger_reversal_operation", sql`${table.kind} <> 'REVERSAL' or ${table.operation} = 'STRIPE_RECONCILIATION'`),
]).enableRLS();

export const paymentAttempt = pgTable("payment_attempt", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  provider: text("provider").notNull().default("STRIPE"),
  state: text("state").notNull().default("CREATED"),
  amountMinor: numeric("amount_minor", { precision: 20, scale: 0 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  providerCheckoutSessionId: text("provider_checkout_session_id").unique(),
  checkoutSessionCreateStartedAt: timestamp("checkout_session_create_started_at", { withTimezone: true }),
  providerPaymentId: text("provider_payment_id").unique(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("payment_attempt_idempotency_unique").on(table.organizationId, table.actorUserId, table.idempotencyKey),
  index("payment_attempt_org_created_idx").on(table.organizationId, table.createdAt),
  check("payment_attempt_stripe_usd", sql`${table.provider} = 'STRIPE' and ${table.currency} = 'USD'`),
  check("payment_attempt_positive_amount", sql`${table.amountMinor} > 0`),
  check("payment_attempt_state_valid", sql`${table.state} in ('CREATED', 'PENDING', 'SETTLED', 'FAILED', 'CANCELED', 'DISPUTED', 'REVERSED')`),
]).enableRLS();

export const providerEvent = pgTable("provider_event", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  providerObjectId: text("provider_object_id"),
  relatedPaymentId: text("related_payment_id"),
  providerAmountMinor: numeric("provider_amount_minor", { precision: 20, scale: 0 }),
  providerCurrency: text("provider_currency"),
  providerStatus: text("provider_status"),
  state: text("state").notNull(),
  payloadHash: text("payload_hash").notNull(),
  paymentAttemptId: text("payment_attempt_id").references(() => paymentAttempt.id),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  unique("provider_event_identity_unique").on(table.provider, table.providerEventId),
  index("provider_event_state_received_idx").on(table.state, table.receivedAt),
  index("provider_event_related_payment_idx").on(table.relatedPaymentId),
  check("provider_event_stripe_only", sql`${table.provider} = 'STRIPE'`),
  check("provider_event_state_valid", sql`${table.state} in ('RECEIVED', 'VERIFIED', 'REJECTED', 'PROCESSED', 'RECONCILIATION_REQUIRED')`),
  check("provider_event_amount_valid", sql`${table.providerAmountMinor} is null or ${table.providerAmountMinor} >= 0`),
  check("provider_event_currency_valid", sql`${table.providerCurrency} is null or ${table.providerCurrency} ~ '^[a-z]{3}$'`),
  check("provider_event_status_valid", sql`${table.providerStatus} is null or length(${table.providerStatus}) between 1 and 64`),
]).enableRLS();

export const stripeDisputeState = pgTable("stripe_dispute_state", {
  providerDisputeId: text("provider_dispute_id").primaryKey(),
  paymentAttemptId: text("payment_attempt_id").notNull().references(() => paymentAttempt.id),
  state: text("state").notNull(),
  lastEventCreatedAt: timestamp("last_event_created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("stripe_dispute_attempt_idx").on(table.paymentAttemptId, table.state),
  check("stripe_dispute_state_valid", sql`${table.state} in ('OPEN', 'WON', 'LOST')`),
]).enableRLS();

export const accessPolicy = pgTable("access_policy", {
  id: integer("id").primaryKey(),
  minimumMinor: numeric("minimum_minor", { precision: 20, scale: 0 }).notNull(),
  duration: text("duration").notNull(),
  version: integer("version").notNull(),
  updatedBy: text("updated_by").references(() => user.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("access_policy_singleton", sql`${table.id} = 1`),
  check("access_policy_minimum_positive", sql`${table.minimumMinor} > 0`),
  check("access_policy_duration_valid", sql`${table.duration} in ('SIX_MONTHS', 'ONE_YEAR', 'UNRESTRICTED')`),
]).enableRLS();

export const accessGrant = pgTable("access_grant", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  ledgerEntryId: text("ledger_entry_id").notNull().unique().references(() => walletLedgerEntry.id),
  policyVersion: integer("policy_version").notNull(),
  duration: text("duration").notNull(),
  state: text("state").notNull().default("ACTIVE"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  suspensionReason: text("suspension_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("access_grant_org_interval_idx").on(table.organizationId, table.startsAt, table.endsAt),
  check("access_grant_duration_valid", sql`${table.duration} in ('SIX_MONTHS', 'ONE_YEAR', 'UNRESTRICTED')`),
  check("access_grant_state_valid", sql`${table.state} in ('ACTIVE', 'SUSPENDED', 'REVOKED')`),
  check("access_grant_interval_valid", sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`),
  check("access_grant_unrestricted_valid", sql`(${table.duration} = 'UNRESTRICTED' and ${table.endsAt} is null) or (${table.duration} <> 'UNRESTRICTED' and ${table.endsAt} is not null)`),
]).enableRLS();

export const walletHold = pgTable("wallet_hold", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  ledgerEntryId: text("ledger_entry_id").references(() => walletLedgerEntry.id),
  paymentAttemptId: text("payment_attempt_id").references(() => paymentAttempt.id),
  amountMinor: numeric("amount_minor", { precision: 20, scale: 0 }).notNull(),
  state: text("state").notNull().default("ACTIVE"),
  reasonCode: text("reason_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
}, (table) => [
  index("wallet_hold_org_state_idx").on(table.organizationId, table.state),
  check("wallet_hold_positive_amount", sql`${table.amountMinor} > 0`),
  check("wallet_hold_state_valid", sql`${table.state} in ('ACTIVE', 'RELEASED', 'CAPTURED')`),
]).enableRLS();

export const auditEvent = pgTable("audit_event", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organization.id),
  actorUserId: text("actor_user_id").references(() => user.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reasonCode: text("reason_code"),
  correlationId: text("correlation_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_event_org_created_idx").on(table.organizationId, table.createdAt),
  index("audit_event_target_idx").on(table.targetType, table.targetId, table.createdAt),
  index("audit_event_created_cursor_idx").on(table.createdAt, table.id),
]).enableRLS();
