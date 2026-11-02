"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { MetricRefreshError, refreshOpenPageRank, setMetricRedistributionApproval } from "@/server/catalog/metrics";
import { logSafeFailure } from "@/server/observability/safe-log";

export type MetricActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function refreshOpenPageRankAction(
  _previous: MetricActionState,
  form: FormData,
): Promise<MetricActionState> {
  void _previous;
  const listingIds = form.getAll("listingId").filter((value): value is string => typeof value === "string");
  try {
    const result = await refreshOpenPageRank(await headers(), listingIds);
    revalidatePath("/staff/metrics");
    return { status: "success", message: `Saved ${result.refreshed} metric observations. The latest results are shown above.` };
  } catch (error) {
    if (error instanceof MetricRefreshError) {
      const messages: Record<MetricRefreshError["code"], string> = {
        DAILY_LIMIT: "You have reached five refresh batches in the last 24 hours. Try again after the limit window resets.",
        NON_PUBLIC_DOMAIN: "One or more selected listings do not have a supported public hostname. No provider request was sent.",
        INVALID_SELECTION: "Select between 1 and 100 different listings before refreshing. No provider request was sent.",
      };
      return { status: "error", message: messages[error.code] };
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return { status: "error", message: "Your staff session could not be verified. Sign in again, then retry." };
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return { status: "error", message: "Your staff role is not authorized to refresh metrics." };
    }
    logSafeFailure("metric_refresh_action_failed", error, randomUUID());
    return { status: "error", message: "The metric refresh could not complete. Check the selected listings and provider configuration, then try again." };
  }
}

export async function setMetricRedistributionApprovalAction(
  _previous: MetricActionState,
  form: FormData,
): Promise<MetricActionState> {
  void _previous;
  const observationId = form.get("observationId");
  const decision = form.get("decision");
  const attributionText = form.get("attributionText");
  const evidenceReference = form.get("evidenceReference");
  const reason = form.get("reason");
  if (typeof observationId !== "string" || typeof decision !== "string" ||
      (decision !== "APPROVED" && decision !== "REVOKED") ||
      typeof evidenceReference !== "string" || typeof reason !== "string" ||
      (attributionText !== null && typeof attributionText !== "string")) {
    return { status: "error", message: "Complete the evidence reference, review reason, and a valid decision." };
  }
  try {
    await setMetricRedistributionApproval(await headers(), {
      observationId, decision,
      attributionText: decision === "APPROVED" && typeof attributionText === "string" ? attributionText : undefined,
      evidenceReference, reason,
    });
    revalidatePath("/staff/metrics");
    return { status: "success", message: decision === "APPROVED" ? "Internal attestation recorded." : "Internal attestation revoked." };
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return { status: "error", message: "Your staff session could not be verified. Sign in again, then retry." };
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return { status: "error", message: "Your staff role is not authorized to record this review." };
    }
    return { status: "error", message: "This observation may have changed. Reload the review list and confirm it is still current before trying again." };
  }
}
