import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./schema";
import { customerOrder, customerOrderItem } from "./order-schema";
import { supplier } from "./catalog-schema";

export const supplierPacket = pgTable("supplier_packet", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  recipient: text("recipient").notNull(),
  packet: jsonb("packet").$type<Record<string, unknown>>().notNull(),
  contentHash: text("content_hash").notNull(),
  holdReason: text("hold_reason"),
  heldAt: timestamp("held_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (t) => [
  unique("supplier_packet_order_supplier_version_uq").on(t.orderId, t.supplierId, t.version),
  index("supplier_packet_order_supplier_idx").on(t.orderId, t.supplierId, t.createdAt),
  check("supplier_packet_version_positive", sql`${t.version} > 0`),
  check("supplier_packet_hash_valid", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

export const supplierPacketItem = pgTable("supplier_packet_item", {
  packetId: text("packet_id").notNull().references(() => supplierPacket.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  assignedAdminId: text("assigned_admin_id").notNull().references(() => user.id),
  consentNoticeVersion: text("consent_notice_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
  consentContentHash: text("consent_content_hash").notNull(),
}, (t) => [
  unique("supplier_packet_item_uq").on(t.packetId, t.orderItemId),
  index("supplier_packet_item_order_item_idx").on(t.orderItemId),
  check("supplier_packet_item_consent_hash_valid", sql`${t.consentContentHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

export const supplierPacketAttempt = pgTable("supplier_packet_attempt", {
  id: text("id").primaryKey(),
  packetId: text("packet_id").notNull().references(() => supplierPacket.id),
  type: text("type").notNull(),
  state: text("state").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  recipient: text("recipient").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  resendReason: text("resend_reason"),
  provider: text("provider"),
  providerReference: text("provider_reference"),
  manualMessageReference: text("manual_message_reference"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  unknownAt: timestamp("unknown_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_packet_attempt_packet_created_idx").on(t.packetId, t.createdAt),
  uniqueIndex("supplier_packet_attempt_provider_reference_uq").on(t.provider, t.providerReference).where(sql`${t.providerReference} is not null`),
  check("supplier_packet_attempt_type_valid", sql`${t.type} in ('SEND','EML_EXPORT','PDF_EXPORT','MANUAL_SENT','MANUAL_SEND')`),
  check("supplier_packet_attempt_state_valid", sql`${t.state} in ('SENDING','ACCEPTED','DELIVERED','DELIVERY_ISSUE','UNKNOWN','EXPORTED','MANUAL_SENT','RECONCILED_FAILED')`),
  check("supplier_packet_attempt_resend_reason", sql`${t.resendReason} is null or length(trim(${t.resendReason})) between 1 and 1000`),
  check("supplier_packet_attempt_shape", sql`(${t.type} = 'SEND' and ${t.provider} = 'RESEND' and ${t.state} not in ('EXPORTED','MANUAL_SENT')) or (${t.type} in ('EML_EXPORT','PDF_EXPORT') and ${t.state} = 'EXPORTED' and ${t.provider} is null) or (${t.type} = 'MANUAL_SENT' and ${t.state} = 'MANUAL_SENT' and ${t.provider} is null and ${t.manualMessageReference} is not null and ${t.sentAt} is not null) or (${t.type} = 'MANUAL_SEND' and ${t.provider} is null and ((${t.state} = 'SENDING' and ${t.manualMessageReference} is null and ${t.sentAt} is null) or (${t.state} = 'MANUAL_SENT' and ${t.manualMessageReference} is not null and ${t.sentAt} is not null) or (${t.state} = 'RECONCILED_FAILED' and ${t.manualMessageReference} is null and ${t.sentAt} is null))`),
]).enableRLS();

export const supplierPacketManualEvidence = pgTable("supplier_packet_manual_evidence", {
  id: text("id").primaryKey(),
  packetId: text("packet_id").notNull().references(() => supplierPacket.id),
  attemptId: text("attempt_id").notNull().unique().references(() => supplierPacketAttempt.id),
  storageKey: text("storage_key").notNull().unique(),
  fileKind: text("file_kind").notNull(),
  fileName: text("file_name").notNull(),
  byteSize: integer("byte_size").notNull(),
  contentSha256: text("content_sha256").notNull(),
  uploadedByUserId: text("uploaded_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_packet_manual_evidence_packet_idx").on(t.packetId, t.createdAt),
  check("supplier_packet_manual_evidence_kind_valid", sql`${t.fileKind} in ('EML','PDF')`),
  check("supplier_packet_manual_evidence_size_valid", sql`${t.byteSize} between 1 and 5242880`),
  check("supplier_packet_manual_evidence_hash_valid", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("supplier_packet_manual_evidence_key_valid", sql`${t.storageKey} ~ '^[0-9a-f-]{36}$'`),
  check("supplier_packet_manual_evidence_filename_valid", sql`length(${t.fileName}) between 1 and 180 and ${t.fileName} !~ '[[:cntrl:]]'`),
]).enableRLS();

export const supplierPacketAttemptEvent = pgTable("supplier_packet_attempt_event", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull().references(() => supplierPacketAttempt.id),
  actorUserId: text("actor_user_id").references(() => user.id),
  actorKind: text("actor_kind").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  reasonCode: text("reason_code").notNull(),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_packet_attempt_event_history_idx").on(t.attemptId, t.createdAt),
]).enableRLS();

export const supplierPacketProviderEvent = pgTable("supplier_packet_provider_event", {
  id: text("id").primaryKey(),
  providerEventId: text("provider_event_id").notNull().unique(),
  providerEmailId: text("provider_email_id"),
  attemptId: text("attempt_id").references(() => supplierPacketAttempt.id),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  state: text("state").notNull().default("PROCESSED"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [
  index("supplier_packet_provider_email_id_idx").on(t.providerEmailId).where(sql`${t.providerEmailId} is not null`),
  check("supplier_packet_provider_hash_valid", sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
  check("supplier_packet_provider_email_id_valid", sql`${t.providerEmailId} is null or (length(btrim(${t.providerEmailId})) between 1 and 320 and ${t.providerEmailId} !~ '[[:cntrl:]]')`),
  check("supplier_packet_provider_state_valid", sql`${t.state} in ('PROCESSED','RECONCILIATION_REQUIRED')`),
]).enableRLS();

export const supplierPacketAcknowledgement = pgTable("supplier_packet_acknowledgement", {
  packetId: text("packet_id").primaryKey().references(() => supplierPacket.id),
  attemptId: text("attempt_id").notNull().references(() => supplierPacketAttempt.id),
  recordedByUserId: text("recorded_by_user_id").notNull().references(() => user.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull(),
  reference: text("reference").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("supplier_packet_ack_reference_valid", sql`length(trim(${t.reference})) between 1 and 320 and ${t.reference} !~ '[[:cntrl:]]'`),
]).enableRLS();
