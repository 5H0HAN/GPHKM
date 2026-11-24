import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./schema";
import { listing } from "./catalog-schema";
import type { CustomerCartDraft } from "@/modules/orders/cart";

export const customerCartItem = pgTable("customer_cart_item", {
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  listingId: text("listing_id").notNull().references(() => listing.id, { onDelete: "restrict" }),
  listingRevision: integer("listing_revision").notNull(),
  generationId: uuid("generation_id").notNull().defaultRandom(),
  version: integer("version").notNull().default(1),
  draft: jsonb("draft").$type<CustomerCartDraft>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.listingId] }),
  check("customer_cart_item_listing_revision_positive", sql`${table.listingRevision} > 0`),
  check("customer_cart_item_version_positive", sql`${table.version} > 0`),
  check("customer_cart_item_draft_valid", sql`
    jsonb_typeof(${table.draft}) = 'object'
    and (${table.draft} - array['targetUrl', 'anchorText', 'instructions', 'articleText', 'writingBrief', 'useWriting']::text[]) = '{}'::jsonb
    and jsonb_typeof(${table.draft}->'targetUrl') = 'string'
    and jsonb_typeof(${table.draft}->'anchorText') = 'string'
    and jsonb_typeof(${table.draft}->'instructions') = 'string'
    and jsonb_typeof(${table.draft}->'articleText') = 'string'
    and jsonb_typeof(${table.draft}->'writingBrief') = 'string'
    and jsonb_typeof(${table.draft}->'useWriting') = 'boolean'
    and length(coalesce(${table.draft}->>'targetUrl', '')) <= 2048
    and length(coalesce(${table.draft}->>'anchorText', '')) <= 200
    and length(coalesce(${table.draft}->>'instructions', '')) <= 4000
    and length(coalesce(${table.draft}->>'articleText', '')) <= 20000
    and length(coalesce(${table.draft}->>'writingBrief', '')) <= 4000
    and coalesce(${table.draft}->>'targetUrl', '') !~ '[[:cntrl:][:space:]]'
    and coalesce(${table.draft}->>'anchorText', '') !~ '[[:cntrl:]]'
    and translate(coalesce(${table.draft}->>'instructions', ''), E'\n\r\t', '') !~ '[[:cntrl:]]'
    and translate(coalesce(${table.draft}->>'articleText', ''), E'\n\r\t', '') !~ '[[:cntrl:]]'
    and translate(coalesce(${table.draft}->>'writingBrief', ''), E'\n\r\t', '') !~ '[[:cntrl:]]'
  `),
]).enableRLS();
