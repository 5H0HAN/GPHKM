import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { db } from "@/db";
import { parseUsdMinorUnits } from "@/modules/wallet/usd-amount";
import { requireStaffAccess } from "@/server/auth/staff";
import { getStripeRuntime } from "@/server/payments/stripe";

const PAYOUT_ID = /^po_[A-Za-z0-9]{6,128}$/;

type Page<T extends { id: string }> = { data: T[]; has_more: boolean };

async function collectPages<T extends { id: string }>(fetchPage: (params: { limit: number; starting_after?: string }) => Promise<Page<T>>) {
  const data: T[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 10; index += 1) {
    const page = await fetchPage({ limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    data.push(...page.data);
    if (!page.has_more) return { data, complete: true };
    cursor = page.data.at(-1)?.id;
    if (!cursor) return { data, complete: false };
  }
  return { data, complete: false };
}

function normalizeBalanceTransaction(value: Stripe.BalanceTransaction | null) {
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

export async function refreshStripePayoutFacts(headers: Headers, payoutId: string) {
  if (!PAYOUT_ID.test(payoutId)) throw new Error("Enter a valid Stripe payout ID");
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  const runtime = getStripeRuntime();
  if (!runtime) throw new Error("Stripe provider access is not configured");

  const payout = await runtime.client.payouts.retrieve(payoutId, { expand: ["balance_transaction"] });
  if (payout.id !== payoutId || payout.livemode !== (runtime.mode === "live") || payout.currency.toLowerCase() !== "usd") {
    throw new Error("Stripe payout does not match the configured provider mode and currency");
  }

  let payoutBalance = payout.balance_transaction;
  if (typeof payoutBalance === "string") {
    try { payoutBalance = await runtime.client.balanceTransactions.retrieve(payoutBalance); }
    catch { payoutBalance = null; }
  }

  let transactions = { data: [] as Stripe.BalanceTransaction[], complete: payout.reconciliation_status === "not_applicable" };
  if (payout.reconciliation_status === "completed") {
    transactions = await collectPages((params) => runtime.client.balanceTransactions.list({ payout: payout.id, ...params }));
  }
  const balanceTransactions = transactions.data.map(normalizeBalanceTransaction);
  const transactionsNetMinor = balanceTransactions.reduce((sum, transaction) => {
    if (!transaction || transaction.currency !== "usd") return sum;
    return sum + BigInt(transaction.netMinor);
  }, 0n);
  const transactionsGrossMinor = balanceTransactions.reduce((sum, transaction) => {
    if (!transaction || transaction.currency !== "usd") return sum;
    return sum + BigInt(transaction.amountMinor);
  }, 0n);
  const transactionsFeeMinor = balanceTransactions.reduce((sum, transaction) => {
    if (!transaction || transaction.currency !== "usd") return sum;
    return sum + BigInt(transaction.feeMinor);
  }, 0n);
  const payoutBalanceFacts = normalizeBalanceTransaction(typeof payoutBalance === "object" ? payoutBalance : null);
  const amountMinor = BigInt(payout.amount);
  const payoutBalanceMatches = !!payoutBalanceFacts
    && payoutBalanceFacts.currency === "usd"
    && payoutBalanceFacts.type === "payout"
    && BigInt(payoutBalanceFacts.amountMinor) === -amountMinor
    && BigInt(payoutBalanceFacts.netMinor) === -amountMinor;
  const transactionsMatch = payout.reconciliation_status !== "completed"
    || (transactions.complete && balanceTransactions.every((transaction) => transaction?.currency === "usd")
      && transactionsNetMinor === amountMinor);
  const complete = payout.status !== "paid" || (payoutBalanceMatches && transactionsMatch
    && payout.reconciliation_status !== "in_progress");
  const facts = {
    payoutId: payout.id,
    providerMode: runtime.mode,
    amountMinor: String(payout.amount),
    currency: payout.currency.toLowerCase(),
    status: payout.status,
    arrivalAt: new Date(payout.arrival_date * 1000).toISOString(),
    createdAt: new Date(payout.created * 1000).toISOString(),
    automatic: payout.automatic,
    reconciliationStatus: payout.reconciliation_status,
    payoutBalanceTransaction: payoutBalanceFacts,
    transactionsComplete: transactions.complete,
    transactionsGrossMinor: transactionsGrossMinor.toString(),
    transactionsFeeMinor: transactionsFeeMinor.toString(),
    transactionsNetMinor: transactionsNetMinor.toString(),
    balanceTransactions,
    refreshedAt: new Date().toISOString(),
  };
  const encodedFacts = JSON.stringify(facts);
  if (Buffer.byteLength(encodedFacts, "utf8") > 140000) throw new Error("Stripe payout snapshot exceeds the storage limit");
  const payloadHash = createHash("sha256").update(encodedFacts).digest("hex");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_store_stripe_payout_snapshot(
      ${payout.id}, ${payloadHash}, ${complete}, ${encodedFacts}::jsonb) as snapshot_id`);
    const snapshotId = (rows[0] as { snapshot_id: string } | undefined)?.snapshot_id;
    if (!snapshotId) throw new Error("Stripe payout snapshot was not saved");
    return { snapshotId, complete };
  });
}

export async function listStripePayoutReconciliation(headers: Headers) {
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select * from public.gphkm_list_stripe_payout_reconciliation()`);
    return rows as Array<{
      snapshot_id: string; payout_id: string; snapshot_created_at: Date; snapshot_complete: boolean;
      facts: {
        providerMode: "test" | "live"; amountMinor: string; currency: string; status: string; arrivalAt: string;
        createdAt: string; automatic: boolean; reconciliationStatus: string;
        payoutBalanceTransaction: ReturnType<typeof normalizeBalanceTransaction>;
        transactionsComplete: boolean; transactionsGrossMinor: string; transactionsFeeMinor: string; transactionsNetMinor: string;
        balanceTransactions: NonNullable<ReturnType<typeof normalizeBalanceTransaction>>[];
      };
      latest_review: null | {
        decision: "MATCHED" | "FOLLOW_UP_REQUIRED"; bankAmountMinor: string; bankCurrency: string;
        bankSettledAt: string | null; evidenceReference: string; reason: string; actorUserId: string; createdAt: string;
      };
    }>;
  });
}

export async function recordStripePayoutBankReview(headers: Headers, input: {
  snapshotId: string; decision: string; bankAmount: string; bankSettledOn: string;
  evidenceReference: string; reason: string;
}) {
  if (!/^[0-9a-f-]{36}$/i.test(input.snapshotId)
    || !["MATCHED", "FOLLOW_UP_REQUIRED"].includes(input.decision)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.bankSettledOn)
    || input.evidenceReference.trim().length < 3 || input.evidenceReference.length > 200
    || /[\u0000-\u001f\u007f]/.test(input.evidenceReference)
    || input.reason.trim().length < 10 || input.reason.length > 1000
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new Error("Invalid Stripe payout bank review");
  const parsedDate = new Date(`${input.bankSettledOn}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== input.bankSettledOn) {
    throw new Error("Enter a valid bank settlement date");
  }
  const bankAmountMinor = parseUsdMinorUnits(input.bankAmount);
  const actor = await requireStaffAccess(headers, "wallet.reconcile");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const { rows } = await tx.execute(sql`select public.gphkm_record_stripe_payout_bank_review(
      ${input.snapshotId}, ${input.decision}, ${bankAmountMinor.toString()}, 'usd', ${parsedDate},
      ${input.evidenceReference.trim()}, ${input.reason.trim()}) as review_id`);
    return (rows[0] as { review_id: string } | undefined)?.review_id ?? null;
  });
}
