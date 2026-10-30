"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { decidePreHandoffCancellation } from "@/server/orders/cancellation";

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function decidePreHandoffCancellationAction(form: FormData) {
  const decision = field(form, "decision");
  const cancellationPage = field(form, "cancellationPage");
  const supportPage = field(form, "supportPage");
  const pageQuery = `?cancellationPage=${/^[1-9]\d{0,5}$/.test(cancellationPage) ? cancellationPage : "1"}&page=${/^[1-9]\d{0,5}$/.test(supportPage) ? supportPage : "1"}`;
  try {
    if (decision !== "APPROVED" && decision !== "DENIED") throw new Error("Invalid cancellation decision");
    await decidePreHandoffCancellation(await headers(), {
      requestId: field(form, "requestId"), decision, reason: field(form, "decisionReason"),
    });
  } catch {
    redirect(`/staff/support${pageQuery}&cancellationError=1`);
  }
  redirect(`/staff/support${pageQuery}&cancellationUpdated=1`);
}
