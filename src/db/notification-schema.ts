import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supportCase } from "./support-schema";

export const customerNotification = pgTable("customer_notification", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  recipientUserId: text("recipient_user_id").notNull().references(() => user.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  orderItemId: text("order_item_id").references(() => customerOrderItem.id),
  supportCaseId: text("support_case_id").references(() => supportCase.id),
  sourceKey: text("source_key").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("customer_notification_source_uq").on(t.sourceKey),
  index("customer_notification_inbox_idx").on(t.organizationId, t.recipientUserId, t.createdAt, t.id),
  index("customer_notification_unread_idx").on(t.organizationId, t.recipientUserId, t.readAt),
  check("customer_notification_kind_valid", sql`${t.kind} in ('ORDER_MILESTONE', 'ORDER_ACTION', 'SUPPORT_UPDATE')`),
  check("customer_notification_text_bounds", sql`length(${t.title}) between 1 and 120 and length(${t.body}) between 1 and 500`),
  check("customer_notification_target_shape", sql`(${t.kind} in ('ORDER_MILESTONE','ORDER_ACTION') and ${t.orderItemId} is not null and ${t.supportCaseId} is null) or (${t.kind} = 'SUPPORT_UPDATE' and ${t.orderItemId} is null and ${t.supportCaseId} is not null)`),
  check("customer_notification_source_valid", sql`length(${t.sourceKey}) between 1 and 200`),
]).enableRLS();

export const customerNotificationEmailOutbox = pgTable("customer_notification_email_outbox", {
  id: text("id").primaryKey(),
  notificationId: text("notification_id").notNull().unique().references(() => customerNotification.id),
  status: text("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  recipientEmail: text("recipient_email"),
  leaseId: text("lease_id"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerReference: text("provider_reference"),
  deliveryStatus: text("delivery_status").notNull().default("PENDING"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("customer_notification_email_queue_idx").on(t.status, t.nextAttemptAt, t.createdAt),
  unique("customer_notification_email_provider_ref_uq").on(t.providerReference),
  check("customer_notification_email_status_valid", sql`${t.status} in ('PENDING','SENDING','RETRY','SENT','UNKNOWN','FAILED','SKIPPED')`),
  check("customer_notification_email_attempts_valid", sql`${t.attempts} >= 0`),
  check("customer_notification_email_lease_shape", sql`(${t.status} = 'SENDING' and ${t.leaseId} is not null and ${t.leaseUntil} is not null) or (${t.status} <> 'SENDING' and ${t.leaseId} is null and ${t.leaseUntil} is null)`),
  check("customer_notification_email_sent_shape", sql`(${t.status} = 'SENT' and ${t.sentAt} is not null and ${t.providerReference} is not null) or (${t.status} <> 'SENT' and ${t.sentAt} is null)`),
  check("customer_notification_email_recipient_valid", sql`${t.recipientEmail} is null or (length(${t.recipientEmail}) between 3 and 254 and ${t.recipientEmail} = lower(${t.recipientEmail}))`),
  check("customer_notification_email_delivery_status_valid", sql`${t.deliveryStatus} in ('PENDING','DELIVERED','BOUNCED','FAILED','DELAYED','SUPPRESSED')`),
]).enableRLS();

export const customerNotificationEmailProviderEvent = pgTable("customer_notification_email_provider_event", {
  id: text("id").primaryKey(),
  providerEventId: text("provider_event_id").notNull().unique(),
  outboxId: text("outbox_id").references(() => customerNotificationEmailOutbox.id),
  providerReference: text("provider_reference").notNull(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  eventCreatedAt: timestamp("event_created_at", { withTimezone: true }).notNull(),
  state: text("state").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [
  index("customer_notification_email_provider_event_outbox_idx").on(t.outboxId, t.receivedAt),
  check("customer_notification_email_provider_event_state_valid", sql`${t.state} in ('PROCESSED','RECONCILIATION_REQUIRED')`),
  check("customer_notification_email_provider_event_hash_valid", sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
  check("customer_notification_email_provider_event_shape", sql`(${t.state} = 'PROCESSED' and ${t.processedAt} is not null and ${t.outboxId} is not null) or (${t.state} = 'RECONCILIATION_REQUIRED' and ${t.processedAt} is null)`),
]).enableRLS();

export const customerNotificationPreference = pgTable("customer_notification_preference", {
  userId: text("user_id").primaryKey().references(() => user.id),
  transactionalEmailEnabled: boolean("transactional_email_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

// Append-only, separately revocable newsletter consent. This does not control
// transactional notifications and does not itself trigger email delivery.
export const customerNewsletterConsentEvent = pgTable("customer_newsletter_consent_event", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id),
  state: text("state").notNull(),
  noticeVersion: text("notice_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("customer_newsletter_consent_user_created_idx").on(t.userId, t.createdAt, t.id),
  check("customer_newsletter_consent_state_valid", sql`${t.state} in ('SUBSCRIBED','UNSUBSCRIBED')`),
  check("customer_newsletter_notice_version_valid", sql`length(${t.noticeVersion}) between 1 and 80`),
]).enableRLS();

export const customerNotificationEmailReconciliation = pgTable("customer_notification_email_reconciliation", {
  id: text("id").primaryKey(),
  outboxId: text("outbox_id").notNull().references(() => customerNotificationEmailOutbox.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  decision: text("decision").notNull(),
  providerReference: text("provider_reference"),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("customer_notification_email_reconciliation_outbox_idx").on(t.outboxId, t.createdAt),
  check("customer_notification_email_reconciliation_decision_valid", sql`${t.decision} in ('CONFIRMED_SENT','CONFIRMED_NOT_SENT')`),
  check("customer_notification_email_reconciliation_refs_valid", sql`length(${t.evidenceReference}) between 3 and 200 and length(btrim(${t.reason})) between 10 and 1000 and (${t.providerReference} is null or length(${t.providerReference}) between 1 and 128)`),
]).enableRLS();
