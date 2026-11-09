import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supplier } from "./catalog-schema";
import { supportCase } from "./support-schema";
import { orderItemEquivalentOffer } from "./equivalent-offer-schema";

// Immutable evidence that a supplier could not complete a purchased placement.
export const supplierFulfillmentOutcome = pgTable("supplier_fulfillment_outcome", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  supportCaseId: text("support_case_id").notNull().references(() => supportCase.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  outcome: text("outcome").notNull(),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  routeGeneration: integer("route_generation").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_fulfillment_outcome_idem_uq").on(t.orderItemId, t.actorUserId, t.idempotencyKey),
  index("supplier_fulfillment_outcome_supplier_date_idx").on(t.supplierId, t.createdAt),
  index("supplier_fulfillment_outcome_item_idx").on(t.orderItemId, t.createdAt),
  check("supplier_fulfillment_outcome_type_valid", sql`${t.outcome} in ('REJECTED','CANNOT_FULFILL','NONRESPONSIVE')`),
  check("supplier_fulfillment_outcome_reason_valid", sql`length(btrim(${t.reason})) between 5 and 2000`),
  check("supplier_fulfillment_outcome_identity_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("supplier_fulfillment_outcome_route_generation_positive", sql`${t.routeGeneration} > 0`),
]).enableRLS();

// A Super Admin's evidence that the original supplier has become available
// again. This never edits the failed outcome or changes the supplier route.
export const supplierFulfillmentRecovery = pgTable("supplier_fulfillment_recovery", {
  id: text("id").primaryKey(),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  supplierId: text("supplier_id").notNull().references(() => supplier.id),
  supportCaseId: text("support_case_id").notNull().references(() => supportCase.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  routeGeneration: integer("route_generation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_fulfillment_recovery_idem_uq").on(t.orderItemId, t.actorUserId, t.idempotencyKey),
  index("supplier_fulfillment_recovery_item_idx").on(t.orderItemId, t.createdAt),
  check("supplier_fulfillment_recovery_reason_valid", sql`length(btrim(${t.reason})) between 5 and 2000`),
  check("supplier_fulfillment_recovery_identity_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("supplier_fulfillment_recovery_route_generation_positive", sql`${t.routeGeneration} > 0`),
]).enableRLS();

// A separate immutable edge records which accepted replacement or audited
// same-supplier recovery resolved each failure. It avoids inferring historical
// resolution from wall-clock ordering.
export const supplierFulfillmentOutcomeResolution = pgTable("supplier_fulfillment_outcome_resolution", {
  outcomeId: text("outcome_id").primaryKey().references(() => supplierFulfillmentOutcome.id),
  offerId: text("offer_id").references(() => orderItemEquivalentOffer.id),
  recoveryId: text("recovery_id").references(() => supplierFulfillmentRecovery.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("supplier_fulfillment_outcome_resolution_offer_idx").on(t.offerId),
  index("supplier_fulfillment_outcome_resolution_recovery_idx").on(t.recoveryId),
  check("supplier_fulfillment_outcome_resolution_method_valid", sql`(${t.offerId} is not null and ${t.recoveryId} is null) or (${t.offerId} is null and ${t.recoveryId} is not null)`),
]).enableRLS();
