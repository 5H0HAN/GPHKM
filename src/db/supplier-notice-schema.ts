import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supportCase } from "./support-schema";
import { supplierPacket } from "./packet-schema";

export const supplierItemNotice = pgTable("supplier_item_notice", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => supportCase.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  packetId: text("packet_id").notNull().references(() => supplierPacket.id),
  noticeType: text("notice_type").notNull(),
  recipient: text("recipient").notNull(),
  snapshot: jsonb("snapshot").$type<{ subject: string; body: string; itemReference: string }>().notNull(),
  contentHash: text("content_hash").notNull(),
  createdByUserId: text("created_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_item_notice_case_created_idx").on(t.caseId, t.createdAt),
  unique("supplier_item_notice_repeat_uq").on(t.caseId, t.noticeType, t.contentHash),
  check("supplier_item_notice_type_valid", sql`${t.noticeType} in ('WITHDRAWAL','CORRECTION')`),
  check("supplier_item_notice_hash_valid", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  check("supplier_item_notice_recipient_valid", sql`length(${t.recipient}) between 3 and 254 and ${t.recipient} !~ '[[:cntrl:]]'`),
]).enableRLS();

export const supplierItemNoticeAttempt = pgTable("supplier_item_notice_attempt", {
  id: text("id").primaryKey(),
  noticeId: text("notice_id").notNull().references(() => supplierItemNotice.id),
  state: text("state").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  providerReference: text("provider_reference"),
  manualReference: text("manual_reference"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_item_notice_attempt_notice_idx").on(t.noticeId, t.createdAt),
  check("supplier_item_notice_attempt_state_valid", sql`${t.state} in ('SENDING','ACCEPTED','UNKNOWN','RECONCILED_FAILED','EXPORTED','MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM')`),
  check("supplier_item_notice_manual_sent_shape", sql`(${t.state} in ('MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM') and ((${t.manualReference} is null and ${t.sentAt} is null) or (${t.manualReference} is not null and ${t.sentAt} is not null))) or (${t.state} not in ('MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM') and ${t.manualReference} is null and ${t.sentAt} is null)`),
]).enableRLS();

export const supplierItemNoticeEvent = pgTable("supplier_item_notice_event", {
  id: text("id").primaryKey(),
  attemptId: text("attempt_id").notNull().references(() => supplierItemNoticeAttempt.id),
  actorUserId: text("actor_user_id").references(() => user.id),
  actorKind: text("actor_kind").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  reason: text("reason").notNull(),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_item_notice_event_history_idx").on(t.attemptId, t.createdAt),
  check("supplier_item_notice_event_actor_valid", sql`(${t.actorKind} = 'STAFF' and ${t.actorUserId} is not null) or (${t.actorKind} = 'PROVIDER' and ${t.actorUserId} is null)`),
  check("supplier_item_notice_event_reason_valid", sql`length(btrim(${t.reason})) between 1 and 1000`),
]).enableRLS();
