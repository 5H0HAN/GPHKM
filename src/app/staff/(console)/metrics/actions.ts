"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refreshOpenPageRank, setMetricRedistributionApproval } from "@/server/catalog/metrics";

export async function refreshOpenPageRankAction(form: FormData) {
  const listingIds = form.getAll("listingId").filter((value): value is string => typeof value === "string");
  const requestedPage = form.get("page");
  const page = typeof requestedPage === "string" && /^[1-9]\d{0,5}$/.test(requestedPage) ? requestedPage : "1";
  let refreshed: number;
  try {
    refreshed = (await refreshOpenPageRank(await headers(), listingIds)).refreshed;
  } catch {
    redirect(`/staff/metrics?page=${page}&error=refresh-failed`);
  }
  redirect(`/staff/metrics?page=${page}&refreshed=${refreshed}`);
}

export async function setMetricRedistributionApprovalAction(form: FormData) {
  const requestedPage = form.get("approvalPage");
  const page = typeof requestedPage === "string" && /^[1-9]\d{0,5}$/.test(requestedPage) ? requestedPage : "1";
  const pageQuery = `approvalPage=${page}`;
  const observationId = form.get("observationId");
  const decision = form.get("decision");
  const attributionText = form.get("attributionText");
  const evidenceReference = form.get("evidenceReference");
  const reason = form.get("reason");
  if (typeof observationId !== "string" || typeof decision !== "string" ||
      (decision !== "APPROVED" && decision !== "REVOKED") ||
      typeof evidenceReference !== "string" || typeof reason !== "string" ||
      (attributionText !== null && typeof attributionText !== "string")) {
    redirect(`/staff/metrics?${pageQuery}&approvalError=invalid`);
  }
  try {
    await setMetricRedistributionApproval(await headers(), {
      observationId, decision, attributionText: typeof attributionText === "string" ? attributionText : undefined,
      evidenceReference, reason,
    });
  } catch {
    redirect(`/staff/metrics?${pageQuery}&approvalError=review`);
  }
  redirect(`/staff/metrics?${pageQuery}&approvalSaved=1`);
}
