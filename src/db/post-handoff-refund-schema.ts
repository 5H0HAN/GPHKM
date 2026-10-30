import { sql } from "drizzle-orm";
import { check, index, integer, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, user, walletLedgerEntry } from "./schema";
import { customerOrder, customerOrderItem } from "./order-schema";
import { supportCase } from "./support-schema";

// A post-cutoff refund is always tied to one Finance Review support case.
// Changes are made only through the narrow database functions in migration 0020.
export const postHandoffRefundRequest = pgTable("post_handoff_refund_request", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  caseId: text("case_id").notNull().references(() => supportCase.id),
  orderId: text("order_id").notNull().references(() => customerOrder.id),
  orderItemId: text("order_item_id").notNull().references(() => customerOrderItem.id),
  requestNumber: integer("request_number").notNull(),
  requestedByUserId: text("requested_by_user_id").notNull().references(() => user.id),
  requestedAmountMinor: numeric("requested_amount_minor", { precision: 20, scale: 0 }).notNull(),
  requestReason: text("request_reason").notNull(),
  requestIdempotencyKey: text("request_idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  state: text("state").notNull().default("REQUESTED"),
  decisionByUserId: text("decision_by_user_id").references(() => user.id),
  decisionReason: text("decision_reason"),
  refundMinor: numeric("refund_minor", { precision: 20, scale: 0 }).notNull().default("0"),
  walletLedgerEntryId: text("wallet_ledger_entry_id").references(() => walletLedgerEntry.id),
  decisionIdempotencyKey: text("decision_idempotency_key"),
  decisionHash: text("decision_hash"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  unique("post_handoff_refund_request_number_uq").on(t.caseId, t.requestNumber),
  unique("post_handoff_refund_request_idempotency_uq").on(t.organizationId, t.requestedByUserId, t.requestIdempotencyKey),
  index("post_handoff_refund_case_state_idx").on(t.caseId, t.state, t.requestedAt),
  index("post_handoff_refund_org_state_idx").on(t.organizationId, t.state, t.requestedAt),
  check("post_handoff_refund_request_number_positive", sql`${t.requestNumber} > 0`),
  check("post_handoff_refund_requested_amount_positive", sql`${t.requestedAmountMinor} > 0`),
  check("post_handoff_refund_request_text_valid", sql`length(btrim(${t.requestReason})) between 5 and 2000`),
  check("post_handoff_refund_request_hash_valid", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("post_handoff_refund_request_idempotency_valid", sql`length(${t.requestIdempotencyKey}) between 16 and 128`),
  check("post_handoff_refund_decision_idempotency_valid", sql`${t.decisionIdempotencyKey} is null or length(${t.decisionIdempotencyKey}) between 16 and 128`),
  check("post_handoff_refund_decision_hash_valid", sql`${t.decisionHash} is null or ${t.decisionHash} ~ '^[0-9a-f]{64}$'`),
  check("post_handoff_refund_decision_shape", sql`(
    (${t.state} = 'REQUESTED' and ${t.decisionByUserId} is null and ${t.decisionReason} is null and ${t.decidedAt} is null and ${t.refundMinor} = 0 and ${t.walletLedgerEntryId} is null and ${t.decisionIdempotencyKey} is null and ${t.decisionHash} is null)
    or (${t.state} = 'DENIED' and ${t.decisionByUserId} is not null and ${t.decisionReason} is not null and ${t.decidedAt} is not null and ${t.refundMinor} = 0 and ${t.walletLedgerEntryId} is null and ${t.decisionIdempotencyKey} is not null and ${t.decisionHash} is not null)
    or (${t.state} = 'APPROVED' and ${t.decisionByUserId} is not null and ${t.decisionReason} is not null and ${t.decidedAt} is not null and ${t.refundMinor} > 0 and ${t.walletLedgerEntryId} is not null and ${t.decisionIdempotencyKey} is not null and ${t.decisionHash} is not null)
  )`),
]).enableRLS();
