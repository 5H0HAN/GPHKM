"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { recordFinanceFindingAction, refreshStripeProviderFacts, resolveMissingStripeCheckoutSession, resolveStripeReconciliation, runFinanceReconciliation } from "@/server/wallet/finance-reconciliation";
import { recordStripePayoutBankReview, refreshStripePayoutFacts } from "@/server/wallet/payout-reconciliation";

function field(form: FormData, key: string) {
  const value = form.get(key);
  if (typeof value !== "string") throw new Error("Invalid Finance reconciliation input");
  return value;
}

export async function runFinanceReconciliationAction() {
  const runId = await runFinanceReconciliation(await headers());
  revalidatePath("/staff/reconciliation");
  redirect(`/staff/reconciliation?financeRun=${encodeURIComponent(runId)}`);
}

export async function recordFinanceFindingActionAction(form: FormData) {
  await recordFinanceFindingAction(await headers(), {
    findingId: field(form, "findingId"),
    outcome: field(form, "outcome"),
    evidenceReference: field(form, "evidenceReference"),
    reason: field(form, "reason"),
  });
  revalidatePath("/staff/reconciliation");
  redirect("/staff/reconciliation?findingReviewed=true");
}

export async function refreshStripeProviderFactsAction(form: FormData) {
  const result = await refreshStripeProviderFacts(await headers(), field(form, "attemptId"));
  revalidatePath("/staff/reconciliation");
  redirect(`/staff/reconciliation?providerSnapshot=${encodeURIComponent(result.snapshotId)}&snapshotComplete=${result.complete ? "true" : "false"}`);
}

export async function resolveStripeReconciliationAction(form: FormData) {
  const result = await resolveStripeReconciliation(await headers(), {
    attemptId: field(form, "attemptId"),
    snapshotId: field(form, "snapshotId"),
    evidenceReference: field(form, "evidenceReference"),
    reason: field(form, "reason"),
  });
  revalidatePath("/staff/reconciliation");
  const partial = BigInt(result.uncovered_minor) > 0n;
  redirect(`/staff/reconciliation?stripeResolved=${partial ? "false" : "true"}&stripePartial=${partial ? "true" : "false"}&providerLoss=${encodeURIComponent(result.provider_loss_minor)}&recovered=${encodeURIComponent(result.wallet_recovery_minor)}&uncovered=${encodeURIComponent(result.uncovered_minor)}`);
}

export async function resolveMissingStripeCheckoutSessionAction(form: FormData) {
  const attemptId = await resolveMissingStripeCheckoutSession(await headers(), {
    attemptId: field(form, "attemptId"),
    evidenceReference: field(form, "evidenceReference"),
    reason: field(form, "reason"),
  });
  revalidatePath("/staff/reconciliation");
  redirect(`/staff/reconciliation?checkoutSessionResolved=${encodeURIComponent(attemptId)}`);
}

export async function refreshStripePayoutFactsAction(form: FormData) {
  const result = await refreshStripePayoutFacts(await headers(), field(form, "payoutId"));
  revalidatePath("/staff/reconciliation");
  redirect(`/staff/reconciliation?payoutSnapshot=${encodeURIComponent(result.snapshotId)}&payoutComplete=${result.complete ? "true" : "false"}`);
}

export async function recordStripePayoutBankReviewAction(form: FormData) {
  await recordStripePayoutBankReview(await headers(), {
    snapshotId: field(form, "snapshotId"),
    decision: field(form, "decision"),
    bankAmount: field(form, "bankAmount"),
    bankSettledOn: field(form, "bankSettledOn"),
    evidenceReference: field(form, "evidenceReference"),
    reason: field(form, "reason"),
  });
  revalidatePath("/staff/reconciliation");
  redirect("/staff/reconciliation?payoutReview=true");
}
