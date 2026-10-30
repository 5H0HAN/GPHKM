"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { openCustomerSupportCase, replyToCustomerSupportCase } from "@/server/support/cases";

function field(form: FormData, key: string) { const value = form.get(key); return typeof value === "string" ? value : ""; }
export async function openSupportAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  let caseId: string;
  try {
    const result = await openCustomerSupportCase(await headers(), organizationId, {
      orderItemId: field(form, "orderItemId"), summary: field(form, "summary"), idempotencyKey: field(form, "idempotencyKey"),
    });
    caseId = result.caseId;
  } catch { redirect(`/customer/support?organizationId=${encodeURIComponent(organizationId)}&error=1`); }
  redirect(`/customer/support/${caseId}?organizationId=${encodeURIComponent(organizationId)}`);
}
export async function replySupportAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  const caseId = field(form, "caseId");
  const path = `/customer/support/${encodeURIComponent(caseId)}?organizationId=${encodeURIComponent(organizationId)}`;
  try { await replyToCustomerSupportCase(await headers(), organizationId, { caseId, body: field(form, "body"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path}&error=1`); }
  redirect(path);
}
