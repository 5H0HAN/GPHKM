"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { addOrganizationClosureMessage, updateOrganizationClosure } from "@/server/identity/organization-closure";

const field = (form: FormData, key: string) => { const value = form.get(key); return typeof value === "string" ? value : ""; };
export async function closureUpdateAction(form: FormData) {
  const requestId = field(form, "requestId");
  const path = `/staff/support/closures/${encodeURIComponent(requestId)}`;
  try { await updateOrganizationClosure(await headers(), { requestId, expectedState: field(form, "expectedState"), to: field(form, "to"),
    message: field(form, "message"), internalNote: field(form, "internalNote"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path}?error=1`); }
  redirect(`${path}?updated=1`);
}
export async function closureMessageAction(form: FormData) {
  const requestId = field(form, "requestId");
  const path = `/staff/support/closures/${encodeURIComponent(requestId)}`;
  try { await addOrganizationClosureMessage(await headers(), { requestId, body: field(form, "body"), internal: form.get("internal") === "on", idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path}?error=1`); }
  redirect(path);
}
