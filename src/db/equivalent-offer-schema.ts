import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supportCase } from "./support-schema";
import { supplier } from "./catalog-schema";
import { orderItemContentChangeRequest, orderItemContentVersion } from "./change-request-schema";

// This row contains only customer-approved replacement terms; supplier routing
// lives in the separate private table below.
export const orderItemEquivalentOffer = pgTable("order_item_equivalent_offer", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  supportCaseId: text("support_case_id").notNull().references(() => supportCase.id),
  contentRequestId: text("content_request_id").notNull().unique().references(() => orderItemContentChangeRequest.id),
  contentVersionId: text("content_version_id").notNull().references(() => orderItemContentVersion.id),
  title: text("title").notNull(),
  websiteUrl: text("website_url").notNull(),
  description: text("description").notNull(),
  equivalenceNote: text("equivalence_note").notNull(),
  categories: text("categories").array().notNull(),
  countryCode: text("country_code").notNull(),
  language: text("language").notNull(),
  linkType: text("link_type").notNull(),
  linkValidity: text("link_validity").notNull(),
  turnaroundDays: integer("turnaround_days").notNull(),
  buyerRequirements: text("buyer_requirements"),
  sponsoredContentMarking: boolean("sponsored_content_marking").notNull(),
  terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
  lockedPriceMinor: numeric("locked_price_minor", { precision: 20, scale: 0 }).notNull(),
  offeredByUserId: text("offered_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("order_item_equivalent_offer_item_idx").on(t.orderItemId, t.createdAt),
  check("order_item_equivalent_offer_title_valid", sql`length(btrim(${t.title})) between 1 and 120`),
  check("order_item_equivalent_offer_url_valid", sql`${t.websiteUrl} ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?/?$' and ${t.websiteUrl} !~ '^https://([0-9]{1,3}\\.){3}[0-9]{1,3}/?$'`),
  check("order_item_equivalent_offer_country_valid", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
  check("order_item_equivalent_offer_terms_valid", sql`jsonb_typeof(${t.terms}) = 'object' and ${t.lockedPriceMinor} > 0`),
]).enableRLS();

// Supplier identity and recipient are only readable by the assigned Admin or Super Admin.
export const orderItemEquivalentOfferRoute = pgTable("order_item_equivalent_offer_route", {
  offerId: text("offer_id").primaryKey().references(() => orderItemEquivalentOffer.id),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  recipientEmail: text("recipient_email").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("order_item_equivalent_offer_route_hash_valid", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`)]).enableRLS();

export const orderItemEquivalentOfferEvent = pgTable("order_item_equivalent_offer_event", {
  id: text("id").primaryKey(),
  offerId: text("offer_id").notNull().references(() => orderItemEquivalentOffer.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  eventType: text("event_type").notNull(),
  contentHash: text("content_hash"),
  noticeVersion: text("notice_version"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("order_item_equivalent_offer_event_idx").on(t.offerId, t.createdAt),
  check("order_item_equivalent_offer_event_valid", sql`(${t.eventType} = 'OFFERED' and ${t.contentHash} ~ '^[0-9a-f]{64}$' and ${t.noticeVersion} is null and ${t.reason} is null) or (${t.eventType} = 'ACCEPTED' and ${t.contentHash} ~ '^[0-9a-f]{64}$' and length(${t.noticeVersion}) between 1 and 80 and ${t.reason} is null) or (${t.eventType} = 'DECLINED' and ${t.contentHash} is null and ${t.noticeVersion} is null and length(${t.reason}) between 1 and 1000)`),
]).enableRLS();
