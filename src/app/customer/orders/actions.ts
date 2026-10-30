"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { updateCustomerWriting } from "@/server/orders/writing";

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function updateCustomerWritingAction(form: FormData) {
  const itemId = field(form, "itemId");
  const organizationId = field(form, "organizationId");
  const command = field(form, "command");
  const returnTo = `/customer/orders?organizationId=${encodeURIComponent(organizationId)}`;
  try {
    if (command !== "APPROVE" && command !== "REQUEST_REVISION" && command !== "DECLINE_FINAL") throw new Error("Invalid writing action");
    await updateCustomerWriting(await headers(), organizationId, itemId, command, field(form, "revisionText"));
  } catch { redirect(`${returnTo}&writingError=1`); }
  redirect(`${returnTo}&writingUpdated=1`);
}
