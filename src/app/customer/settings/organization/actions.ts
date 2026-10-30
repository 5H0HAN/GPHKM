"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORGANIZATION_COOKIE } from "@/modules/identity/organizations";
import { requireVerifiedCustomer } from "@/server/identity/customer-context";
import { inviteOrganizationMember, promoteOrganizationMember, removeOrganizationMember, renameOrganization, revokeOrganizationInvitation } from "@/server/identity/organization-lifecycle";
import { openOrganizationClosure, replyToOrganizationClosure } from "@/server/identity/organization-closure";
import { updateOrganizationBillingProfile } from "@/server/identity/organization-billing";

const field = (form: FormData, key: string) => { const value = form.get(key); return typeof value === "string" ? value : ""; };
const path = (organizationId: string) => `/customer/settings/organization?organizationId=${encodeURIComponent(organizationId)}`;
function confirmed(form: FormData) { if (form.get("confirmed") !== "on") throw new Error("Confirmation is required"); }
function userId(form: FormData) { const value = field(form, "userId"); if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid member"); return value; }

export async function renameOrganizationAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { await renameOrganization(await headers(), organizationId, field(form, "name"), field(form, "expectedName")); }
  catch { redirect(`${path(organizationId)}&error=name`); }
  redirect(`${path(organizationId)}&updated=name`);
}
export async function updateBillingProfileAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try {
    await updateOrganizationBillingProfile(await headers(), organizationId, {
      legalName: field(form, "legalName"),
      billingEmail: field(form, "billingEmail"),
      billingAddress: field(form, "billingAddress"),
    });
  } catch { redirect(`${path(organizationId)}&error=billing`); }
  redirect(`${path(organizationId)}&updated=billing`);
}
export async function promoteMemberAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { confirmed(form); await promoteOrganizationMember(await headers(), organizationId, userId(form)); }
  catch { redirect(`${path(organizationId)}&error=member`); }
  redirect(`${path(organizationId)}&updated=member`);
}
export async function removeMemberAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  let removedSelf = false;
  try {
    confirmed(form);
    const requestHeaders = await headers();
    const actor = await requireVerifiedCustomer(requestHeaders);
    const targetUserId = userId(form);
    await removeOrganizationMember(requestHeaders, organizationId, targetUserId);
    removedSelf = actor.userId === targetUserId;
    if (removedSelf) (await cookies()).delete(ACTIVE_ORGANIZATION_COOKIE);
  } catch { redirect(`${path(organizationId)}&error=member`); }
  redirect(removedSelf ? "/customer/settings?updated=left" : `${path(organizationId)}&updated=member`);
}
export async function revokeInvitationAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { confirmed(form); await revokeOrganizationInvitation(await headers(), organizationId, field(form, "invitationId")); }
  catch { redirect(`${path(organizationId)}&error=invitation`); }
  redirect(`${path(organizationId)}&updated=invitation`);
}
export async function inviteMemberAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { await inviteOrganizationMember(await headers(), organizationId, field(form, "email")); }
  catch { redirect(`${path(organizationId)}&error=invite-unavailable`); }
  redirect(`${path(organizationId)}&updated=invitation`);
}
export async function requestOrganizationClosureAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { confirmed(form); await openOrganizationClosure(await headers(), organizationId, { summary: field(form, "summary"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path(organizationId)}&error=closure`); }
  redirect(`${path(organizationId)}&updated=closure`);
}
export async function replyOrganizationClosureAction(form: FormData) {
  const organizationId = field(form, "organizationId");
  try { await replyToOrganizationClosure(await headers(), organizationId, { requestId: field(form, "requestId"), body: field(form, "body"), idempotencyKey: field(form, "idempotencyKey") }); }
  catch { redirect(`${path(organizationId)}&error=closure`); }
  redirect(`${path(organizationId)}&updated=closure`);
}
