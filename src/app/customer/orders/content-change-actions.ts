"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { consentToContentChange, submitContentChangeRequest } from "@/server/orders/content-changes";

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function submitContentChangeAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  const itemId = field(form, "itemId");
  try {
    const patch: Record<string, unknown> = {};
    for (const key of ["targetUrl", "anchorText", "articleText", "instructions"]) {
      const value = field(form, key);
      if (form.has(key) && value.trim()) patch[key] = value;
    }
    await submitContentChangeRequest(await headers(), organizationId, itemId, patch);
  } catch { redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&changeError=1`); }
  redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&changeSubmitted=1`);
}

export async function consentToContentChangeAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try {
    await consentToContentChange(await headers(), organizationId, field(form, "requestId"));
  } catch { redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&changeError=1`); }
  redirect(`/customer/orders?organizationId=${encodeURIComponent(organizationId)}&changeConsented=1`);
}
