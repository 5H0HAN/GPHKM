import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { requireStaffAccess } from "@/server/auth/staff";
import { getStripeRuntime } from "@/server/payments/stripe";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FinanceFinding = {
  id: string;
  organizationId: string | null;
  category: string;
  targetType: string;
  targetId: string;
  expectedMinor: string | null;
  observedMinor: string | null;
  summary: string;
  ownerUserId: string;
  outcome: "CONFIRMED_EXPECTED" | "FOLLOW_UP_REQUIRED" | null;
  evidenceReference: string | null;
  reason: string | null;
  reviewedAt: string | null;
};

export type FinanceReconciliationSnapshot = {
  runId: string;
  createdAt: string;
  findingCount: number;
  findings: FinanceFinding[];
};

type StripePage<T extends { id: string }> = { data: T[]; has_more: boolean };

async function collectStripePages<T extends { id: string }>(
  fetchPage: (params: { limit: number; starting_after?: string; expand?: string[] }) => Promise<StripePage<T>>,
) {
  const data: T[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await fetchPage({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    data.push(...page.data);
    if (!page.has_more) return { data, complete: true };
    cursor = page.data.at(-1)?.id;
    if (!cursor) return { data, complete: false };
  }
  return { data, complete: false };
}

function normalizedBalanceTransaction(value: Stripe.BalanceTransaction | null) {
  if (!value) return null;
  return {
    id: value.id,
    amountMinor: String(value.amount),
    feeMinor: String(value.fee),
    netMinor: String(value.net),
    currency: value.currency.toLowerCase(),
    type: value.type,
    status: value.status,
  };
}

export async function refreshStripeProviderFacts(headers: Headers, attemptId: string) {
  if (!UUID.test(attemptId)) throw new Error("Invalid payment attempt");
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  const runtime = getStripeRuntime();
  if (!runtime) throw new Error("Stripe provider access is not configured");

  const attempt = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_get_stripe_review_attempt(${attemptId})`);
    return rows[0] as { payment_attempt_id: string; provider_payment_id: string; amount_minor: string; currency: string; state: string } | undefined;
  });
  if (!attempt?.provider_payment_id) throw new Error("Stripe funding attempt is not available for provider review");

  const refresh = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_start_stripe_finance_refresh(${attempt.payment_attempt_id})`);
    return rows[0] as { refresh_id: string; started_at: Date } | undefined;
  });
  if (!refresh?.refresh_id) throw new Error("Stripe provider refresh could not be started");

  // Provider reads happen before the database write transaction. Only an allowlisted summary is persisted.
  const intent = await runtime.client.paymentIntents.retrieve(attempt.provider_payment_id, {
    expand: ["latest_charge.balance_transaction"],
  });
  if (intent.id !== attempt.provider_payment_id || intent.livemode !== (runtime.mode === "live") || intent.amount !== Number(attempt.amount_minor)
    || intent.currency.toLowerCase() !== attempt.currency.toLowerCase()) {
    throw new Error("Current Stripe payment facts do not match the funding attempt");
  }

  const refundPages = await collectStripePages((params) => runtime.client.refunds.list({
    payment_intent: intent.id,
    expand: ["data.balance_transaction"],
    ...params,
  }));
  const disputePages = await collectStripePages((params) => runtime.client.disputes.list({
    payment_intent: intent.id,
    expand: ["data.balance_transactions"],
    ...params,
  }));

  let detailComplete = refundPages.complete && disputePages.complete;
  let charge = intent.latest_charge;
  if (typeof charge === "string") {
    try { charge = await runtime.client.charges.retrieve(charge, { expand: ["balance_transaction"] }); }
    catch { charge = null; detailComplete = false; }
  }
  let chargeBalanceTransaction = charge?.balance_transaction ?? null;
  if (typeof chargeBalanceTransaction === "string") {
    try { chargeBalanceTransaction = await runtime.client.balanceTransactions.retrieve(chargeBalanceTransaction); }
    catch { chargeBalanceTransaction = null; detailComplete = false; }
  }
  if (charge && (charge.payment_intent !== intent.id || charge.livemode !== (runtime.mode === "live"))) {
    throw new Error("Current Stripe charge does not match the funding attempt");
  }
  const normalizedChargeBalanceTransaction = normalizedBalanceTransaction(
    typeof chargeBalanceTransaction === "object" ? chargeBalanceTransaction : null,
  );
  if (intent.amount_received > 0 && (!normalizedChargeBalanceTransaction
    || normalizedChargeBalanceTransaction.currency !== intent.currency.toLowerCase()
    || Number(normalizedChargeBalanceTransaction.amountMinor) !== intent.amount_received)) {
    detailComplete = false;
  }
  const refunds = [];
  let refundedSucceededMinor = 0n;
  let pendingRefundCount = 0;
  for (const refund of refundPages.data) {
    let transaction = refund.balance_transaction;
    if (typeof transaction === "string") {
      try { transaction = await runtime.client.balanceTransactions.retrieve(transaction); }
      catch { transaction = null; detailComplete = false; }
    }
    if (refund.status === "succeeded") {
      refundedSucceededMinor += BigInt(refund.amount);
      if (!transaction) detailComplete = false;
    }
    if (refund.status === "pending" || refund.status === "requires_action") pendingRefundCount += 1;
    refunds.push({
      id: refund.id,
      amountMinor: String(refund.amount),
      currency: refund.currency.toLowerCase(),
      status: refund.status ?? "unknown",
      createdAt: new Date(refund.created * 1000).toISOString(),
      balanceTransaction: normalizedBalanceTransaction(typeof transaction === "object" ? transaction : null),
    });
  }

  const terminalDisputeStatuses = new Set(["won", "lost", "warning_closed"]);
  let openDisputeCount = 0;
  let disputeBalanceNetMinor = 0n;
  const disputes = disputePages.data.map((dispute) => {
    if (!terminalDisputeStatuses.has(dispute.status)) openDisputeCount += 1;
    const balanceTransactions = dispute.balance_transactions.map((transaction) => {
      disputeBalanceNetMinor += BigInt(transaction.amount);
      return normalizedBalanceTransaction(transaction);
    });
    if (dispute.status === "lost" && balanceTransactions.length === 0) detailComplete = false;
    return {
      id: dispute.id,
      amountMinor: String(dispute.amount),
      currency: dispute.currency.toLowerCase(),
      status: dispute.status,
      createdAt: new Date(dispute.created * 1000).toISOString(),
      balanceTransactions,
    };
  });
  let facts = {
    providerPaymentId: intent.id,
    refreshId: refresh.refresh_id,
    providerMode: runtime.mode,
    amountMinor: String(intent.amount),
    amountReceivedMinor: String(intent.amount_received),
    currency: intent.currency.toLowerCase(),
    paymentStatus: intent.status,
    chargeId: charge?.id ?? null,
    chargeBalanceTransaction: normalizedChargeBalanceTransaction,
    refreshedAt: new Date().toISOString(),
    snapshotTruncated: false,
    paginationComplete: refundPages.complete && disputePages.complete,
    detailComplete,
    refundedSucceededMinor: refundedSucceededMinor.toString(),
    pendingRefundCount,
    openDisputeCount,
    disputeBalanceNetMinor: disputeBalanceNetMinor.toString(),
    refunds,
    disputes,
  };
  let encodedFacts = JSON.stringify(facts);
  if (Buffer.byteLength(encodedFacts, "utf8") > 150000) {
    detailComplete = false;
    facts = {
      ...facts,
      paginationComplete: false,
      detailComplete: false,
      snapshotTruncated: true,
      refunds: refunds.slice(0, 25),
      disputes: disputes.slice(0, 25),
    };
    encodedFacts = JSON.stringify(facts);
  }
  if (Buffer.byteLength(encodedFacts, "utf8") > 200000) throw new Error("Stripe provider snapshot exceeds the storage limit");
  const payloadHash = createHash("sha256").update(encodedFacts).digest("hex");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_store_stripe_finance_snapshot(
      ${attempt.payment_attempt_id}, ${payloadHash}, ${detailComplete}, ${encodedFacts}::jsonb) as snapshot_id`);
    if ((rows[0] as { snapshot_id: string } | undefined)?.snapshot_id == null) throw new Error("Provider snapshot was not saved");
    return { snapshotId: (rows[0] as { snapshot_id: string }).snapshot_id, complete: detailComplete };
  });
}

export async function listStripeProviderSnapshots(headers: Headers) {
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_list_open_stripe_reconciliation_snapshots()`);
    return rows as Array<{
      payment_attempt_id: string; organization_id: string; attempt_state: string; case_id: string;
      snapshot_id: string | null; snapshot_created_at: Date | null; snapshot_complete: boolean | null; facts: {
        providerPaymentId: string; providerMode: "test" | "live"; amountMinor: string; amountReceivedMinor: string; currency: string;
        paymentStatus: string; chargeId: string | null; chargeBalanceTransaction: { id: string; amountMinor: string; feeMinor: string; netMinor: string; currency: string; type: string; status: string } | null;
        refreshedAt: string; paginationComplete: boolean; detailComplete: boolean;
        refundedSucceededMinor: string; pendingRefundCount: number; openDisputeCount: number;
        disputeBalanceNetMinor: string; refunds: Array<{
          id: string; amountMinor: string; currency: string; status: string;
          balanceTransaction: { id: string; amountMinor: string; feeMinor: string; netMinor: string; currency: string; type: string; status: string } | null;
        }>;
        disputes: Array<{
          id: string; amountMinor: string; currency: string; status: string;
          balanceTransactions: Array<{ id: string; amountMinor: string; feeMinor: string; netMinor: string; currency: string; type: string; status: string }>;
        }>;
        latestDecision?: {
          providerLossMinor: string; walletRecoveryMinor: string; uncoveredMinor: string;
          evidenceReference: string; reason: string; createdAt: string;
        } | null;
      } | null;
    }>;
  });
}

export async function resolveStripeReconciliation(headers: Headers, input: {
  attemptId: string; snapshotId: string; evidenceReference: string; reason: string;
}) {
  if (!UUID.test(input.attemptId) || !UUID.test(input.snapshotId)
    || input.evidenceReference.trim().length < 3 || input.evidenceReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.evidenceReference)
    || input.reason.trim().length < 10 || input.reason.length > 1000
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Invalid Stripe reconciliation decision");
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_resolve_stripe_reconciliation_case(
      ${input.attemptId}, ${input.snapshotId}, ${input.evidenceReference.trim()}, ${input.reason.trim()})`);
    const result = rows[0] as { provider_loss_minor: string; wallet_recovery_minor: string; uncovered_minor: string } | undefined;
    if (!result) throw new Error("Stripe reconciliation decision was not recorded");
    return result;
  });
}

export async function resolveMissingStripeCheckoutSession(headers: Headers, input: {
  attemptId: string; evidenceReference: string; reason: string;
}) {
  if (!UUID.test(input.attemptId)
    || input.evidenceReference.trim().length < 3 || input.evidenceReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.evidenceReference)
    || input.reason.trim().length < 10 || input.reason.length > 1000
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Invalid Stripe session reconciliation decision");
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_resolve_missing_stripe_checkout_session(
      ${input.attemptId}, ${input.evidenceReference.trim()}, ${input.reason.trim()}) as payment_attempt_id`);
    const result = rows[0] as { payment_attempt_id: string } | undefined;
    if (!result?.payment_attempt_id) throw new Error("Stripe session reconciliation was not recorded");
    return result.payment_attempt_id;
  });
}

export async function getLatestFinanceReconciliation(headers: Headers): Promise<FinanceReconciliationSnapshot | null> {
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_get_latest_finance_reconciliation() as snapshot`);
    return (rows[0] as { snapshot: FinanceReconciliationSnapshot | null } | undefined)?.snapshot ?? null;
  });
}

export async function runFinanceReconciliation(headers: Headers): Promise<string> {
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_run_finance_reconciliation() as run_id`);
    const runId = (rows[0] as { run_id: string } | undefined)?.run_id;
    if (!runId) throw new Error("Finance reconciliation did not complete");
    await tx.execute(sql`select public.gphkm_add_stripe_provider_review_findings(${runId})`);
    return runId;
  });
}

export async function recordFinanceFindingAction(headers: Headers, input: {
  findingId: string; outcome: string; evidenceReference: string; reason: string;
}) {
  if (!UUID.test(input.findingId)
    || !["CONFIRMED_EXPECTED", "FOLLOW_UP_REQUIRED"].includes(input.outcome)
    || input.evidenceReference.trim().length < 3 || input.evidenceReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.evidenceReference)
    || input.reason.trim().length < 10 || input.reason.length > 1000
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Invalid Finance finding review");

  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_record_finance_reconciliation_action(
      ${input.findingId}, ${input.outcome}, ${input.evidenceReference.trim()}, ${input.reason.trim()}) as applied`);
    if (!(rows[0] as { applied: boolean } | undefined)?.applied) throw new Error("Finance finding is unavailable");
    return { recorded: true as const };
  });
}
