import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, user, walletLedgerEntry } from "./schema";
import { customerOrder, customerOrderItem } from "./order-schema";

// Decisions are changed only through the narrowly scoped database functions in 0017.
export const orderItemCancellationRequest = pgTable("order_item_cancellation_request", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  requestedByUserId: text("requested_by_user_id").notNull().references(() => user.id),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("REQUESTED"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  decisionByUserId: text("decision_by_user_id").references(() => user.id),
  decisionReason: text("decision_reason"),
  refundMinor: numeric("refund_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  walletLedgerEntryId: text("wallet_ledger_entry_id").references(() => walletLedgerEntry.id),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  unique("order_item_cancellation_request_idempotency_uq").on(t.organizationId, t.requestedByUserId, t.idempotencyKey),
  index("order_item_cancellation_item_requested_idx").on(t.orderItemId, t.requestedAt),
  index("order_item_cancellation_org_state_idx").on(t.organizationId, t.state, t.requestedAt),
  index("order_item_cancellation_queue_idx").on(t.state, t.requestedAt, t.id),
  check("order_item_cancellation_state_valid", sql`${t.state} in ('REQUESTED', 'APPROVED', 'DENIED')`),
  check("order_item_cancellation_reason_valid", sql`length(trim(${t.reason})) between 1 and 2000`),
  check("order_item_cancellation_idempotency_valid", sql`length(${t.idempotencyKey}) between 16 and 128 and ${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("order_item_cancellation_decision_shape", sql`(
    (${t.state} = 'REQUESTED' and ${t.decisionByUserId} is null and ${t.decisionReason} is null and ${t.decidedAt} is null and ${t.refundMinor} = '0' and ${t.walletLedgerEntryId} is null)
    or (${t.state} = 'DENIED' and ${t.decisionByUserId} is not null and ${t.decisionReason} is not null and ${t.decidedAt} is not null and ${t.refundMinor} = '0' and ${t.walletLedgerEntryId} is null)
    or (${t.state} = 'APPROVED' and ${t.decisionByUserId} is not null and ${t.decisionReason} is not null and ${t.decidedAt} is not null and ${t.refundMinor} > 0 and ${t.walletLedgerEntryId} is not null)
  )`),
]).enableRLS();
