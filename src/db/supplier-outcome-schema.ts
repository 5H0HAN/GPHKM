import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./schema";
import { customerOrderItem } from "./order-schema";
import { supplier } from "./catalog-schema";
import { supportCase } from "./support-schema";

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("supplier_fulfillment_outcome_idem_uq").on(t.orderItemId, t.actorUserId, t.idempotencyKey),
  index("supplier_fulfillment_outcome_supplier_date_idx").on(t.supplierId, t.createdAt),
  index("supplier_fulfillment_outcome_item_idx").on(t.orderItemId, t.createdAt),
  check("supplier_fulfillment_outcome_type_valid", sql`${t.outcome} in ('REJECTED','CANNOT_FULFILL','NONRESPONSIVE')`),
  check("supplier_fulfillment_outcome_reason_valid", sql`length(btrim(${t.reason})) between 5 and 2000`),
  check("supplier_fulfillment_outcome_identity_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
]).enableRLS();
