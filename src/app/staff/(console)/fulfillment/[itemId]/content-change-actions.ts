"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { reviewContentChangeRequest } from "@/server/orders/content-changes";

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function reviewContentChangeAction(form: FormData) {
  const itemId = field(form, "itemId");
  const requestId = field(form, "requestId");
  const decision = field(form, "decision");
  try {
    if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("Invalid review action");
    await reviewContentChangeRequest(await headers(), requestId, decision, field(form, "reason"));
  } catch { redirect(`/staff/fulfillment/${encodeURIComponent(itemId)}?changeReviewError=1`); }
  redirect(`/staff/fulfillment/${encodeURIComponent(itemId)}?changeReviewed=1`);
}
