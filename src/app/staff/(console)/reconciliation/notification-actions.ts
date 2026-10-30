"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { reconcileCustomerEmail } from "@/server/notifications/reconciliation";

function field(form: FormData, key: string) {
  const value = form.get(key);
  if (typeof value !== "string") throw new Error("Invalid notification reconciliation input");
  return value;
}

export async function reconcileCustomerEmailAction(form: FormData) {
  await reconcileCustomerEmail(await headers(), {
    outboxId: field(form, "outboxId"), decision: field(form, "decision"),
    providerReference: field(form, "providerReference").trim(),
    evidenceReference: field(form, "evidenceReference"), reason: field(form, "reason"),
  });
  revalidatePath("/staff/reconciliation");
  redirect("/staff/reconciliation?emailReconciled=true");
}
