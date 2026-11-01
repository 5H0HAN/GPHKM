"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { setStaffCustomerAccountState, updateStaffCustomerMembership } from "@/server/identity/staff-customer-directory";

function field(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function requireConfirmation(form: FormData) {
  if (form.get("confirmed") !== "on") throw new Error("Confirmation required");
}

function customerPath(id: string) {
  return `/staff/customers/${encodeURIComponent(id)}`;
}

export async function setCustomerAccountStateAction(form: FormData) {
  const customerId = field(form, "customerId");
  const state = field(form, "state");
  const expectedState = field(form, "expectedState");
  const reason = field(form, "reason");
  let changed: boolean;
  try {
    requireConfirmation(form);
    if (!( ["ACTIVE", "SUSPENDED"] as const).includes(state as "ACTIVE" | "SUSPENDED")
      || !( ["ACTIVE", "SUSPENDED"] as const).includes(expectedState as "ACTIVE" | "SUSPENDED")) throw new Error("Invalid account state");
    changed = await setStaffCustomerAccountState(await headers(), {
      customerId, expectedState: expectedState as "ACTIVE" | "SUSPENDED", state: state as "ACTIVE" | "SUSPENDED", reason,
    });
  } catch { redirect(`${customerPath(customerId)}?error=account`); }
  revalidatePath("/staff/customers");
  revalidatePath(customerPath(customerId));
  redirect(`${customerPath(customerId)}?updated=${changed ? "account" : "unchanged"}`);
}

export async function updateCustomerMembershipAction(form: FormData) {
  const customerId = field(form, "customerId");
  const organizationId = field(form, "organizationId");
  const role = field(form, "role");
  const expectedRole = field(form, "expectedRole");
  const activeValue = field(form, "active");
  const expectedActiveValue = field(form, "expectedActive");
  const reason = field(form, "reason");
  let changed: boolean;
  try {
    requireConfirmation(form);
    if (!( ["OWNER", "MEMBER"] as const).includes(role as "OWNER" | "MEMBER")
      || !( ["OWNER", "MEMBER"] as const).includes(expectedRole as "OWNER" | "MEMBER")
      || !( ["true", "false"] as const).includes(activeValue as "true" | "false")
      || !( ["true", "false"] as const).includes(expectedActiveValue as "true" | "false")) throw new Error("Invalid membership state");
    changed = await updateStaffCustomerMembership(await headers(), {
      customerId, organizationId,
      expectedRole: expectedRole as "OWNER" | "MEMBER", expectedActive: expectedActiveValue === "true",
      role: role as "OWNER" | "MEMBER", active: activeValue === "true", reason,
    });
  } catch { redirect(`${customerPath(customerId)}?error=membership`); }
  revalidatePath("/staff/customers");
  revalidatePath(customerPath(customerId));
  redirect(`${customerPath(customerId)}?updated=${changed ? "membership" : "unchanged"}`);
}
