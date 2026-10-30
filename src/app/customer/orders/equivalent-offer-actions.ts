"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { decideCustomerEquivalentOffer } from "@/server/fulfillment/equivalent-offers";

function field(form: FormData, key: string) { const value = form.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function decideEquivalentOfferAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  const offerId = field(form, "offerId");
  const decision = field(form, "decision");
  try {
    if (decision !== "ACCEPT" && decision !== "DECLINE") throw new Error("Invalid decision");
    if (decision === "ACCEPT" && field(form, "shareConsent") !== "yes") throw new Error("Content-sharing approval is required");
    await decideCustomerEquivalentOffer(await headers(), organizationId, {
      offerId, decision, reason: field(form, "reason") || "Customer declined the proposed equivalent.",
    });
  } catch { redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&equivalentError=1`); }
  redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&equivalentUpdated=${decision.toLowerCase()}`);
}
