"use server";

import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { recordFinanceFindingAction, refreshStripeProviderFacts, resolveMissingStripeCheckoutSession, resolveStripeReconciliation, runFinanceReconciliation } from "@/server/wallet/finance-reconciliation";
import { recordStripePayoutBankReview, refreshStripePayoutFacts } from "@/server/wallet/payout-reconciliation";
import { logSafeFailure } from "@/server/observability/safe-log";

function field(form: FormData, key: string) {
  const value = form.get(key);
  if (typeof value !== "string") throw new Error("Invalid Finance reconciliation input");
  return value;
}

export type ReconciliationRunState = { status: "idle" } | { status: "success"; runId: string } | { status: "error"; reason: "session" | "permission" | "failure"; message: string };

export async function runFinanceReconciliationAction(_previous: ReconciliationRunState, _form: FormData): Promise<ReconciliationRunState> {
  void _previous;
  void _form;
  let runId: string;
  try {
    runId = await runFinanceReconciliation(await headers());
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return { status: "error", reason: "session", message: "Your staff session could not be verified. Sign in again, then retry the reconciliation." };
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return { status: "error", reason: "permission", message: "Your staff role is not authorized to run this reconciliation." };
    }
    logSafeFailure("finance_reconciliation_run_failed", error, randomUUID());
    return { status: "error", reason: "failure", message: "Reconciliation could not run. Refresh this page and try again." };
  }
  revalidatePath("/staff/reconciliation");
  return { status: "success", runId };
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
