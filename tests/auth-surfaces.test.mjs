import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertAuthSurface, authSurfaceForHost, authSurfaceOrigins, resolveAuthSurface } from "../src/server/auth/surfaces.ts";
import { authTrustedProxyCidrs, hasStrongAuthSecret } from "../src/server/auth/policy.ts";

test("customer and staff app origins are exact, distinct, and secure in production", () => {
  const origins = authSurfaceOrigins({
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://customer.example.com",
    STAFF_APP_URL: "https://staff.example.com",
  });
  assert.equal(authSurfaceForHost("customer.example.com", origins), "customer");
  assert.equal(authSurfaceForHost("staff.example.com", origins), "staff");
  assert.equal(authSurfaceForHost("attacker.example.com", origins), null);
  assert.throws(() => assertAuthSurface("customer.example.com", "staff", origins), /Forbidden/);
  assert.throws(() => authSurfaceOrigins({
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://customer.example.com",
    STAFF_APP_URL: "http://staff.example.com",
  }), /HTTPS/);
  assert.equal(resolveAuthSurface(new Headers({ host: "customer.example.com", "x-forwarded-host": "staff.example.com" }), {
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://customer.example.com",
    STAFF_APP_URL: "https://staff.example.com",
  }), "customer");
  assert.equal(resolveAuthSurface(new Headers({ "x-forwarded-host": "staff.example.com" }), {
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://customer.example.com",
    STAFF_APP_URL: "https://staff.example.com",
  }), null);
});

test("local app origins allow localhost hosts but reject wildcard and shared origins", () => {
  const origins = authSurfaceOrigins({
    NODE_ENV: "development",
    CUSTOMER_APP_URL: "http://customer.localhost:3000",
    STAFF_APP_URL: "http://staff.localhost:3000",
  });
  assert.equal(authSurfaceForHost("customer.localhost:3000", origins), "customer");
  assert.throws(() => authSurfaceOrigins({
    NODE_ENV: "development",
    CUSTOMER_APP_URL: "http://localhost:3000",
    STAFF_APP_URL: "http://localhost:3000",
  }), /distinct/);
  assert.throws(() => authSurfaceOrigins({
    NODE_ENV: "development",
    CUSTOMER_APP_URL: "http://localhost:3000",
    STAFF_APP_URL: "http://localhost:3001",
  }), /distinct/);
  assert.throws(() => authSurfaceOrigins({
    NODE_ENV: "production",
    CUSTOMER_APP_URL: "https://*.example.com",
    STAFF_APP_URL: "https://staff.example.com",
  }), /valid URL|origin/);
});

test("production auth requires bounded, valid trusted proxy ranges", () => {
  assert.deepEqual(authTrustedProxyCidrs({ NODE_ENV: "development" }), []);
  assert.deepEqual(authTrustedProxyCidrs({ NODE_ENV: "production", GPHKM_TRUSTED_PROXY_CIDRS: "10.0.0.1, 2001:db8::/64" }), ["10.0.0.1", "2001:db8::/64"]);
  assert.throws(() => authTrustedProxyCidrs({ NODE_ENV: "production" }), /required in production/);
  assert.throws(() => authTrustedProxyCidrs({ NODE_ENV: "production", GPHKM_TRUSTED_PROXY_CIDRS: "0.0.0.0/0" }), /valid IP addresses or CIDRs/);
  assert.throws(() => authTrustedProxyCidrs({ NODE_ENV: "production", GPHKM_TRUSTED_PROXY_CIDRS: "10.0.0.1/33" }), /valid IP addresses or CIDRs/);
  assert.throws(() => authTrustedProxyCidrs({ NODE_ENV: "production", GPHKM_TRUSTED_PROXY_CIDRS: "not-an-ip" }), /valid IP addresses or CIDRs/);
});

test("production auth secrets must encode at least 32 diverse random bytes", () => {
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(hasStrongAuthSecret(bytes.toString("base64")), true);
  assert.equal(hasStrongAuthSecret(bytes.toString("base64url")), true);
  assert.equal(hasStrongAuthSecret(bytes.toString("hex")), true);
  assert.equal(hasStrongAuthSecret("a".repeat(64)), false);
  assert.equal(hasStrongAuthSecret("short"), false);
  assert.equal(hasStrongAuthSecret(Buffer.alloc(32, 0xab).toString("base64")), false);
});

test("sign-in pages use a server-checked session projection instead of a pending client hook", async () => {
  const customer = await readFile(new URL("../src/app/sign-in/sign-in-form.tsx", import.meta.url), "utf8");
  const staff = await readFile(new URL("../src/app/staff/sign-in/staff-sign-in.tsx", import.meta.url), "utf8");
  const session = await readFile(new URL("../src/server/auth/sign-in-session.ts", import.meta.url), "utf8");
  const identityDomain = await readFile(new URL("../src/server/auth/identity-domain.ts", import.meta.url), "utf8");
  const customerContext = await readFile(new URL("../src/server/identity/customer-context.ts", import.meta.url), "utf8");
  const customerPage = await readFile(new URL("../src/app/sign-in/page.tsx", import.meta.url), "utf8");
  const staffPage = await readFile(new URL("../src/app/staff/sign-in/page.tsx", import.meta.url), "utf8");
  const invitation = await readFile(new URL("../src/components/identity/invitation-acceptance.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(customer, /client\.useSession\(/);
  assert.doesNotMatch(staff, /staffAuthClient\.useSession\(/);
  assert.match(session, /resolveAuthSurface\(requestHeaders, process\.env\) !== surface/);
  assert.match(session, /isStaffIdentity\(authenticated\.user\.id\)/);
  assert.match(identityDomain, /set_config\('app\.user_id'/);
  assert.match(identityDomain, /from\(staffAccount\)/);
  assert.match(customerContext, /STAFF_IDENTITY_NOT_CUSTOMER/);
  assert.match(session, /email: authenticated\.user\.email/);
  assert.match(session, /const twoFactorEnabled = authenticated && "twoFactorEnabled" in authenticated\.user && authenticated\.user\.twoFactorEnabled === true/);
  assert.match(session, /twoFactorEnabled: twoFactorEnabled === true/);
  assert.match(customerPage, /getSignInSession\("customer"\)/);
  assert.match(staffPage, /getSignInSession\("staff"\)/);
  assert.match(staff, /if \(session && !session\.twoFactorEnabled\) return <StaffMfaSetup \/>/);
  assert.doesNotMatch(invitation, /useSession\(/);
  assert.match(invitation, /disabled=\{busy \|\| accepted\}/);
});
