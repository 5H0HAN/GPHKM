import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertCanAcceptInvitation,
  assertOwnerMayLeaveOrBeRemoved,
  assertStaffPermission,
  assertStaffMayBeActivated,
  canAcceptInvitation,
  hasStaffPermission,
  normalizeDisplayName,
  normalizeVerifiedEmail,
} from "../src/server/identity/policy.ts";

test("staff bundles deny financial and operational crossover", () => {
  assert.equal(hasStaffPermission("ADMIN", "catalog.manage"), true);
  assert.equal(hasStaffPermission("ADMIN", "metrics.approve"), false);
  assert.equal(hasStaffPermission("ADMIN", "costs.read"), false);
  assert.equal(hasStaffPermission("FINANCE", "wallet.reconcile"), true);
  assert.equal(hasStaffPermission("FINANCE", "fulfillment.manage"), false);
  assert.equal(hasStaffPermission("SUPER_ADMIN", "staff.manage"), true);
  assert.equal(hasStaffPermission("SUPER_ADMIN", "metrics.approve"), true);
  assert.throws(() => assertStaffPermission("ADMIN", "metrics.approve"), /Forbidden/);
  assert.throws(() => assertStaffPermission("ADMIN", "refund.exception.approve"), /Forbidden/);
});

test("customer invitations require pending, unexpired, matching verified email", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const invite = { email: "Member@Example.com", status: "PENDING", expiresAt: new Date("2026-10-29T12:00:00.000Z") };
  assert.equal(canAcceptInvitation(invite, "member@example.com", true, now), true);
  assert.equal(canAcceptInvitation(invite, "other@example.com", true, now), false);
  assert.equal(canAcceptInvitation(invite, "member@example.com", false, now), false);
  assert.equal(canAcceptInvitation({ ...invite, expiresAt: now }, "member@example.com", true, now), false);
  assert.throws(() => assertCanAcceptInvitation({ ...invite, status: "REVOKED" }, invite.email, true, now), /Invitation unavailable/);
});

test("organization cannot lose its last owner and only verified email is normalized", () => {
  assert.throws(() => assertOwnerMayLeaveOrBeRemoved(1, true, false), /Last organization owner/);
  assert.doesNotThrow(() => assertOwnerMayLeaveOrBeRemoved(2, true, false));
  assert.doesNotThrow(() => assertOwnerMayLeaveOrBeRemoved(1, true, true));
  assert.equal(normalizeVerifiedEmail("  OWNER@Example.COM ", true), "owner@example.com");
  assert.throws(() => normalizeVerifiedEmail("owner@example.com", false), /Verified email/);
});

test("profile display names are trimmed, bounded, and normalized", () => {
  assert.equal(normalizeDisplayName("  Amira\n Rahman  "), "Amira Rahman");
  assert.throws(() => normalizeDisplayName("  "), /Display name/);
  assert.throws(() => normalizeDisplayName("x".repeat(101)), /Display name/);
  assert.throws(() => normalizeDisplayName("Name\u0000Injected"), /Display name/);
});

test("staff activation is refused until MFA enrollment is complete", () => {
  assert.throws(() => assertStaffMayBeActivated("ADMIN", true, false), /MFA enrollment required/);
  assert.doesNotThrow(() => assertStaffMayBeActivated("FINANCE", true, true));
  assert.doesNotThrow(() => assertStaffMayBeActivated("SUPER_ADMIN", false, false));
});

test("database identity-domain guard serializes provisioning and local RLS smoke covers both directions", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0081_exclusive_identity_domains.sql", import.meta.url), "utf8");
  const smoke = await readFile(new URL("../scripts/check-local-rls.ts", import.meta.url), "utf8");
  assert.match(migration, /PERFORM 1 FROM public\.auth_user WHERE id = NEW\.user_id FOR UPDATE/);
  assert.match(migration, /TG_TABLE_NAME = 'organization_member'[\s\S]*staff identities cannot hold customer organization membership/);
  assert.match(migration, /TG_TABLE_NAME = 'staff_account'[\s\S]*customer identities cannot be provisioned as staff/);
  assert.match(smoke, /staff principal added to customer organization/);
  assert.match(smoke, /customer principal provisioned as staff/);
});
