import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, numeric, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { listing, supplier } from "./catalog-schema";
import { customerOrderItem } from "./order-schema";

// Append-only cost history; listing_cost remains the current source-cost projection.
export const supplierListingCostEvent = pgTable("supplier_listing_cost_event", {
  id: text("id").primaryKey(),
  listingId: text("listing_id").notNull().references(() => listing.id),
  supplierId: text("supplier_id").references(() => supplier.id),
  previousCostMinor: numeric("previous_cost_minor", { precision: 20, scale: 0 }),
  newCostMinor: numeric("new_cost_minor", { precision: 20, scale: 0 }),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_listing_cost_event_listing_created_idx").on(t.listingId, t.createdAt),
  check("supplier_listing_cost_event_values", sql`(${t.previousCostMinor} is null or ${t.previousCostMinor} >= 0) and (${t.newCostMinor} is null or ${t.newCostMinor} >= 0) and ${t.previousCostMinor} is distinct from ${t.newCostMinor}`),
  check("supplier_listing_cost_event_reason", sql`length(btrim(${t.reason})) between 1 and 1000`),
]).enableRLS();

// A manual transfer is an immutable fact. The transfer reference is unique per
// supplier; old PAID/UNPAID status records remain a separate legacy history.
export const supplierTransferEvent = pgTable("supplier_transfer_event", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  amountMinor: numeric("amount_minor", { precision: 20, scale: 0 }).notNull(),
  transferDate: timestamp("transfer_date", { withTimezone: true }).notNull(),
  transferReference: text("transfer_reference").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_transfer_supplier_created_idx").on(t.supplierId, t.createdAt),
  unique("supplier_transfer_actor_idempotency_uq").on(t.actorUserId, t.idempotencyKey),
  uniqueIndex("supplier_transfer_supplier_reference_uq").on(t.supplierId, sql`lower(btrim(${t.transferReference}))`),
  check("supplier_transfer_amount_positive", sql`${t.amountMinor} > 0`),
  check("supplier_transfer_reference_length", sql`length(btrim(${t.transferReference})) between 1 and 200`),
  check("supplier_transfer_evidence_length", sql`length(btrim(${t.evidenceReference})) between 1 and 500`),
  check("supplier_transfer_reason_length", sql`length(btrim(${t.reason})) between 1 and 1000`),
  check("supplier_transfer_idempotency_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();

export const supplierTransferAllocation = pgTable("supplier_transfer_allocation", {
  id: text("id").primaryKey(),
  transferEventId: text("transfer_event_id").notNull().references(() => supplierTransferEvent.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  amountMinor: numeric("amount_minor", { precision: 20, scale: 0 }).notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_transfer_allocation_item_uq").on(t.transferEventId, t.orderItemId),
  index("supplier_transfer_allocation_item_idx").on(t.orderItemId, t.createdAt),
  check("supplier_transfer_allocation_amount_positive", sql`${t.amountMinor} > 0`),
]).enableRLS();

export const supplierTransferEvidence = pgTable("supplier_transfer_evidence", {
  id: text("id").primaryKey(),
  transferEventId: text("transfer_event_id").notNull().references(() => supplierTransferEvent.id),
  storageKey: text("storage_key").notNull().unique(),
  fileKind: text("file_kind").notNull(),
  fileName: text("file_name").notNull(),
  byteSize: integer("byte_size").notNull(),
  contentSha256: text("content_sha256").notNull(),
  uploadedByUserId: text("uploaded_by_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_transfer_evidence_event_uq").on(t.transferEventId),
  index("supplier_transfer_evidence_created_idx").on(t.createdAt),
  check("supplier_transfer_evidence_kind_valid", sql`${t.fileKind} in ('EML','PDF')`),
  check("supplier_transfer_evidence_size_valid", sql`${t.byteSize} between 1 and 5242880`),
  check("supplier_transfer_evidence_hash_valid", sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
  check("supplier_transfer_evidence_key_valid", sql`${t.storageKey} ~ '^[0-9a-f-]{36}$'`),
  check("supplier_transfer_evidence_filename_valid", sql`length(${t.fileName}) between 1 and 180 and ${t.fileName} !~ '[[:cntrl:]]'`),
]).enableRLS();

// Each row records the actual per-item direct-cost value at that point in its history.
export const supplierOrderItemCostEvent = pgTable("supplier_order_item_cost_event", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  supplierId: text("supplier_id").references(() => supplier.id),
  component: text("component", { enum: ["PLACEMENT", "WRITING"] }).notNull(),
  previousCostMinor: numeric("previous_cost_minor", { precision: 20, scale: 0 }),
  newCostMinor: numeric("new_cost_minor", { precision: 20, scale: 0 }).notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_order_cost_event_item_component_created_idx").on(t.orderItemId, t.component, t.createdAt),
  index("supplier_order_cost_item_supplier_component_created_idx").on(t.orderItemId, t.supplierId, t.component, t.createdAt, t.id),
  check("supplier_order_cost_event_values", sql`${t.newCostMinor} >= 0 and (${t.previousCostMinor} is null or ${t.previousCostMinor} >= 0) and ${t.previousCostMinor} is distinct from ${t.newCostMinor}`),
  check("supplier_order_cost_event_reason", sql`length(btrim(${t.reason})) between 1 and 1000`),
]).enableRLS();

// Manual settlement evidence only. This is a record, not an instruction to transfer funds.
export const supplierPaymentRecord = pgTable("supplier_payment_record", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  amountMinor: numeric("amount_minor", { precision: 20, scale: 0 }).notNull(),
  paymentDate: timestamp("payment_date", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["PAID", "UNPAID"] }).notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_payment_supplier_created_idx").on(t.supplierId, t.createdAt),
  index("supplier_payment_item_created_idx").on(t.orderItemId, t.createdAt),
  check("supplier_payment_amount_positive", sql`${t.amountMinor} > 0`),
  check("supplier_payment_reference_length", sql`length(btrim(${t.evidenceReference})) between 1 and 500`),
  check("supplier_payment_reason_length", sql`length(btrim(${t.reason})) between 1 and 1000`),
  check("supplier_payment_idempotency_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  unique("supplier_payment_actor_idempotency_uq").on(t.actorUserId, t.idempotencyKey),
]).enableRLS();
