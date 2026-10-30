"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestOrderItemCancellation } from "@/server/orders/cancellation";

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function requestOrderItemCancellationAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  const itemId = field(form, "itemId");
  const returnTo = `/customer/orders?organizationId=${encodeURIComponent(organizationId)}`;
  try {
    await requestOrderItemCancellation(await headers(), organizationId, {
      itemId, idempotencyKey: field(form, "idempotencyKey"), reason: field(form, "reason"),
    });
  } catch {
    redirect(`${returnTo}&cancellationError=1`);
  }
  redirect(`${returnTo}&cancellationRequested=1`);
}
