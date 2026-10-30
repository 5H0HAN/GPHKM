import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseOrganizationId, preferOrganization, organizationPath, normalizeOrganizationName, invitationDisplayStatus, organizationInvitationDeliveryStatus, assertOrganizationInvitationDeliveryAvailable } from "../src/modules/identity/organizations.ts";

test("active organization preferences never create authority or accept an unknown membership", () => {
  const organizations = [{ id: "org-a", role: "OWNER" }, { id: "org-b", role: "MEMBER" }];
  assert.equal(chooseOrganizationId(organizations, "org-b"), "org-b");
  assert.equal(chooseOrganizationId(organizations, "attacker-org"), "org-a");
  assert.equal(chooseOrganizationId([], "org-a"), null);
  const preferred = preferOrganization(organizations, "org-b");
  assert.equal(preferred[0].id, "org-b");
  assert.equal(organizations[0].id, "org-a");
  assert.deepEqual(preferOrganization(organizations, "attacker-org"), organizations);
});

test("switching organizations does not carry an old case ID into the next organization", () => {
  assert.equal(organizationPath("/customer/support/case-from-org-a", "org-b"), "/customer/support?organizationId=org-b");
  assert.equal(organizationPath("/customer/settings/organization", "org-b"), "/customer/settings/organization?organizationId=org-b");
  assert.equal(organizationPath("/staff", "org-b"), "/customer?organizationId=org-b");
});

test("organization names are normalized and bounded", () => {
  assert.equal(normalizeOrganizationName("  Acme   Studio  "), "Acme Studio");
  for (const name of [" ", "a", "x".repeat(121), "Org\0forged", "Org\u0007forged"]) assert.throws(() => normalizeOrganizationName(name));
});

test("email invitation creation stays disabled without a secure sender and expiry is explicit", () => {
  assert.equal(organizationInvitationDeliveryStatus().available, false);
  assert.throws(assertOrganizationInvitationDeliveryAvailable, /Secure invitation email delivery is unavailable/);
  const now = new Date("2026-10-28T12:00:00Z");
  assert.equal(invitationDisplayStatus("PENDING", now, now), "EXPIRED");
  assert.equal(invitationDisplayStatus("PENDING", new Date("2026-10-29T00:00:00Z"), now), "PENDING");
  assert.equal(invitationDisplayStatus("REVOKED", now, now), "REVOKED");
});

test("settings operations retain server Owner checks, token secrecy, and existing own-order RLS", () => {
  const lifecycle = readFileSync(new URL("../src/server/identity/organization-lifecycle.ts", import.meta.url), "utf8");
  const invitation = lifecycle.slice(lifecycle.indexOf("export async function inviteOrganizationMember"), lifecycle.indexOf("export async function acceptOrganizationInvitation"));
  assert.match(invitation, /assertOrganizationInvitationDeliveryAvailable\(\)/);
  assert.match(invitation, /withProtectedOrganizationContext\(headers, organizationId, async \(tx, role\)/);
  assert.match(invitation, /if \(role !== "OWNER"\) throw new Error\("Forbidden"\)/);
  const settings = lifecycle.slice(lifecycle.indexOf("export async function getOrganizationSettings"));
  assert.match(settings, /withOrganizationContext\(headers, organizationId/);
  assert.match(settings, /if \(role !== "OWNER"\) return .*members: \[\], invitations: \[\]/);
  assert.doesNotMatch(settings, /tokenHash|\.token\b/);
  assert.match(lifecycle, /gphkm_remove_organization_member\(\$\{organizationId\}, \$\{memberUserId\}\)/);
  const authorityCommands = readFileSync(new URL("../src/db/migrations/0077_identity_authority_lock_rechecks.sql", import.meta.url), "utf8");
  const removal = authorityCommands.slice(authorityCommands.indexOf("CREATE OR REPLACE FUNCTION public.gphkm_remove_organization_member"), authorityCommands.indexOf("CREATE OR REPLACE FUNCTION public.gphkm_activate_staff"));
  assert.match(removal, /target_org IS DISTINCT FROM nullif\(current_setting\('app\.organization_id'/);
  assert.match(removal, /FROM public\.organization WHERE id = target_org AND closed_at IS NULL FOR UPDATE/);
  assert.match(removal, /organization_id = target_org AND user_id = target_user FOR UPDATE/);
  assert.match(removal, /IF other_owners = 0 THEN RAISE EXCEPTION 'last owner cannot be removed'/);
  const actions = readFileSync(new URL("../src/app/customer/settings/organization/actions.ts", import.meta.url), "utf8");
  assert.match(actions, /await inviteOrganizationMember\(/);
  assert.match(actions, /confirmed\(form\); await promoteOrganizationMember/);
  assert.match(actions, /confirmed\(form\);\s*const requestHeaders/);
  const switching = readFileSync(new URL("../src/app/customer/organization-actions.ts", import.meta.url), "utf8");
  assert.match(switching, /await withOrganizationContext/);
  assert.match(switching, /httpOnly: true/);
  assert.match(switching, /sameSite: "lax"/);
  assert.doesNotMatch(switching, /domain:/);
  const orderRls = readFileSync(new URL("../src/db/migrations/0005_order_checkout.sql", import.meta.url), "utf8");
  assert.match(orderRls, /CREATE POLICY customer_order_read[\s\S]*?actor_user_id = nullif\(current_setting\('app.user_id'/);
  assert.match(orderRls, /OR public\.gphkm_is_active_org_owner/);
  assert.match(orderRls, /organization_id = nullif\(current_setting\('app.organization_id'/);
});
