import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supplier } from "./catalog-schema";

// Requests, approved versions, and consent evidence are append-only. They never
// rewrite the purchased order item snapshot.
export const orderItemContentChangeRequest = pgTable("order_item_content_change_request", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  requestNumber: integer("request_number").notNull(),
  requestedByUserId: text("requested_by_user_id").notNull().references(() => user.id),
  baseVersion: integer("base_version").notNull().default(1),
  targetSupplierId: text("target_supplier_id").references(() => supplier.id),
  targetUrl: text("target_url"),
  anchorText: text("anchor_text"),
  articleText: text("article_text"),
  instructions: text("instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("order_item_content_change_request_version_uq").on(t.orderItemId, t.requestNumber),
  index("order_item_content_change_request_item_idx").on(t.orderItemId, t.createdAt),
  check("order_item_content_change_request_base_valid", sql`${t.baseVersion} >= 1`),
]).enableRLS();

export const orderItemContentVersion = pgTable("order_item_content_version", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  requestId: text("request_id").notNull().unique().references(() => orderItemContentChangeRequest.id),
  version: integer("version").notNull(),
  targetUrl: text("target_url").notNull(),
  anchorText: text("anchor_text").notNull(),
  articleText: text("article_text"),
  instructions: text("instructions").notNull().default(""),
  supplierId: text("supplier_id").references(() => supplier.id),
  recipientEmail: text("recipient_email").notNull(),
  contentHash: text("content_hash").notNull(),
  approvedByUserId: text("approved_by_user_id").notNull().references(() => user.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("order_item_content_version_number_uq").on(t.orderItemId, t.version),
  index("order_item_content_version_item_idx").on(t.orderItemId, t.version),
  check("order_item_content_version_text_bounds", sql`length(${t.targetUrl}) between 1 and 2048 and length(${t.anchorText}) between 1 and 200 and (${t.articleText} is null or length(${t.articleText}) between 1 and 20000) and length(${t.instructions}) <= 4000`),
  check("order_item_content_version_hash_valid", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

export const orderItemContentChangeEvent = pgTable("order_item_content_change_event", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().references(() => orderItemContentChangeRequest.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  eventType: text("event_type").notNull(),
  versionId: text("version_id").references(() => orderItemContentVersion.id),
  contentHash: text("content_hash"),
  noticeVersion: text("notice_version"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("order_item_content_change_event_request_idx").on(t.requestId, t.createdAt),
  check("order_item_content_change_event_type_valid", sql`${t.eventType} in ('REQUESTED', 'APPROVED', 'REJECTED', 'CONSENTED')`),
  check("order_item_content_change_event_reason_bounds", sql`${t.reason} is null or length(${t.reason}) between 1 and 1000`),
  check("order_item_content_change_event_binding_valid", sql`((${t.eventType} = 'CONSENTED' and ${t.versionId} is not null and ${t.contentHash} ~ '^[0-9a-f]{64}$' and length(${t.noticeVersion}) between 1 and 80) or (${t.eventType} = 'APPROVED' and ${t.versionId} is not null and ${t.contentHash} ~ '^[0-9a-f]{64}$' and ${t.noticeVersion} is null) or (${t.eventType} in ('REQUESTED','REJECTED') and ${t.versionId} is null and ${t.contentHash} is null and ${t.noticeVersion} is null))`),
]).enableRLS();
