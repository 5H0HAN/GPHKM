import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization, paymentAttempt, user } from "./schema";

export const financeReconciliationRun = pgTable("finance_reconciliation_run", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const financeReconciliationFinding = pgTable("finance_reconciliation_finding", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => financeReconciliationRun.id),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id),
  organizationId: text("organization_id").references(() => organization.id),
  fingerprint: text("fingerprint").notNull(),
  category: text("category").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  expectedMinor: numeric("expected_minor", { precision: 20, scale: 0 }),
  observedMinor: numeric("observed_minor", { precision: 20, scale: 0 }),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("finance_reconciliation_finding_run_fingerprint_uq").on(t.runId, t.fingerprint),
  index("finance_reconciliation_finding_run_idx").on(t.runId, t.createdAt),
]).enableRLS();

export const financeReconciliationAction = pgTable("finance_reconciliation_action", {
  id: text("id").primaryKey(),
  findingId: text("finding_id").notNull().references(() => financeReconciliationFinding.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  outcome: text("outcome").notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("finance_reconciliation_action_finding_idx").on(t.findingId, t.createdAt),
  check("finance_reconciliation_action_outcome_valid", sql`${t.outcome} in ('CONFIRMED_EXPECTED','FOLLOW_UP_REQUIRED')`),
  check("finance_reconciliation_action_evidence_valid", sql`length(btrim(${t.evidenceReference})) between 3 and 200`),
  check("finance_reconciliation_action_reason_valid", sql`length(btrim(${t.reason})) between 10 and 1000`),
]).enableRLS();

export const stripeFinanceSnapshot = pgTable("stripe_finance_snapshot", {
  id: text("id").primaryKey(),
  paymentAttemptId: text("payment_attempt_id").notNull().references(() => paymentAttempt.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  facts: jsonb("facts").notNull(),
  payloadHash: text("payload_hash").notNull(),
  complete: boolean("complete").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("stripe_finance_snapshot_attempt_created_idx").on(t.paymentAttemptId, t.createdAt)]).enableRLS();

export const stripeFinanceRefresh = pgTable("stripe_finance_refresh", {
  id: text("id").primaryKey(),
  paymentAttemptId: text("payment_attempt_id").notNull().references(() => paymentAttempt.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("stripe_finance_refresh_attempt_started_idx").on(t.paymentAttemptId, t.startedAt)]).enableRLS();

// Reconciliation state is private operational data. Staff mutate it only through
// narrowly-scoped SECURITY DEFINER commands; individual decisions are immutable.
export const stripeReconciliationCase = pgTable("stripe_reconciliation_case", {
  id: text("id").primaryKey(),
  paymentAttemptId: text("payment_attempt_id").notNull().references(() => paymentAttempt.id),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  state: text("state").notNull().default("OPEN"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("stripe_reconciliation_case_attempt_uq").on(t.paymentAttemptId),
  check("stripe_reconciliation_case_state_valid", sql`${t.state} in ('OPEN','RESOLVED')`),
  index("stripe_reconciliation_case_org_state_idx").on(t.organizationId, t.state),
]).enableRLS();

export const stripeReconciliationDecision = pgTable("stripe_reconciliation_decision", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => stripeReconciliationCase.id),
  snapshotId: text("snapshot_id").notNull().references(() => stripeFinanceSnapshot.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  providerLossMinor: numeric("provider_loss_minor", { precision: 20, scale: 0 }).notNull(),
  walletRecoveryMinor: numeric("wallet_recovery_minor", { precision: 20, scale: 0 }).notNull(),
  uncoveredMinor: numeric("uncovered_minor", { precision: 20, scale: 0 }).notNull(),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("stripe_reconciliation_decision_snapshot_uq").on(t.snapshotId),
  check("stripe_reconciliation_decision_amounts_valid", sql`${t.providerLossMinor} >= 0 and ${t.walletRecoveryMinor} >= 0 and ${t.uncoveredMinor} >= 0`),
  check("stripe_reconciliation_decision_evidence_valid", sql`length(btrim(${t.evidenceReference})) between 3 and 200`),
  check("stripe_reconciliation_decision_reason_valid", sql`length(btrim(${t.reason})) between 10 and 1000`),
  index("stripe_reconciliation_decision_case_created_idx").on(t.caseId, t.createdAt),
]).enableRLS();

export const stripePayoutSnapshot = pgTable("stripe_payout_snapshot", {
  id: text("id").primaryKey(),
  payoutId: text("payout_id").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  facts: jsonb("facts").notNull(),
  payloadHash: text("payload_hash").notNull(),
  complete: boolean("complete").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("stripe_payout_snapshot_latest_idx").on(t.payoutId, t.createdAt),
]).enableRLS();

export const stripePayoutBankReview = pgTable("stripe_payout_bank_review", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => stripePayoutSnapshot.id),
  actorUserId: text("actor_user_id").notNull().references(() => user.id),
  decision: text("decision").notNull(),
  bankAmountMinor: numeric("bank_amount_minor", { precision: 20, scale: 0 }).notNull(),
  bankCurrency: text("bank_currency").notNull(),
  bankSettledOn: timestamp("bank_settled_on", { withTimezone: true }),
  evidenceReference: text("evidence_reference").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("stripe_payout_bank_review_decision_valid", sql`${t.decision} in ('MATCHED','FOLLOW_UP_REQUIRED')`),
  check("stripe_payout_bank_review_amount_valid", sql`${t.bankAmountMinor} >= 0`),
  check("stripe_payout_bank_review_currency_valid", sql`${t.bankCurrency} = 'usd'`),
  check("stripe_payout_bank_review_evidence_valid", sql`length(btrim(${t.evidenceReference})) between 3 and 200`),
  check("stripe_payout_bank_review_reason_valid", sql`length(btrim(${t.reason})) between 10 and 1000`),
  index("stripe_payout_bank_review_snapshot_idx").on(t.snapshotId, t.createdAt),
]).enableRLS();
