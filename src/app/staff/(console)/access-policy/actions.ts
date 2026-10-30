"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateAccessPolicy } from "@/server/wallet/access-policy";

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function updateAccessPolicyAction(form: FormData) {
  try {
    if (form.get("confirmed") !== "on") throw new Error("Confirmation required");
    await updateAccessPolicy(await headers(), {
      minimumUsd: field(form, "minimumUsd"),
      duration: field(form, "duration"),
      expectedVersion: Number(field(form, "version")),
      reason: field(form, "reason"),
    });
  } catch {
    redirect("/staff/access-policy?error=update-failed");
  }
  revalidatePath("/staff/access-policy");
  redirect("/staff/access-policy?updated=1");
}
