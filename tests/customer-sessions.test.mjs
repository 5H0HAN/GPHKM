import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("customer session review exposes only safe metadata and revokes only owned non-current sessions", async () => {
  const source = await read("../src/server/identity/customer-sessions.ts");
  assert.match(source, /requireVerifiedCustomer\(headers\)/);
  assert.match(source, /item\.id === current\.session\.id/);
  assert.match(source, /createdAt: item\.createdAt/);
  assert.match(source, /expiresAt: item\.expiresAt/);
  assert.doesNotMatch(source, /token: item\.token/);
  assert.match(source, /current\.session\.id === sessionId/);
  assert.match(source, /target\.userId !== actor\.userId/);
  assert.match(source, /revokeOtherSessions\(\{ headers \}\)/);
  assert.match(source, /await auth\.api\.listSessions\(\{ headers \}\);[\s\S]*revokeOtherSessions/);
  assert.match(source, /db\.select\(\{ id: session\.id, createdAt: session\.createdAt, expiresAt: session\.expiresAt \}\)/);
  assert.match(source, /eq\(session\.userId, actor\.userId\)/);
  assert.doesNotMatch(source, /token: session\.token/);
  const auth = await read("../src/server/auth/index.ts");
  assert.match(auth, /freshAge: 10 \* 60/);
  assert.match(auth, /CUSTOMER_SESSION_REVOCATION_PATHS = new Set\(\[[\s\S]*"\/revoke-session"[\s\S]*"\/revoke-other-sessions"[\s\S]*"\/revoke-sessions"/);
  assert.match(auth, /CUSTOMER_SESSION_REVOCATION_PATHS\.has\(context\.path\)/);
  assert.match(auth, /context\.headers \?\? context\.request\?\.headers/);
  assert.match(auth, /getAuthForSurface\("customer"\)\.api\.getSession\(\{ headers \}\)/);
  assert.match(auth, /Date\.now\(\) - createdAt >= CUSTOMER_SESSION_FRESH_AGE_MS/);
  assert.match(auth, /Number\.isFinite\(createdAt\)/);
  const probe = await read("../scripts/check-customer-session-revocation-local.ts");
  assert.match(probe, /NODE_ENV !== "development" \|\| !localAuthEnabled/);
  assert.match(probe, /assertLoopbackUrl\(requiredEnv\(process\.env, "CUSTOMER_APP_URL"\)/);
  assert.match(probe, /assertLoopbackUrl\(requiredEnv\(process\.env, "STAFF_APP_URL"\)/);
  assert.match(probe, /staffSignInHtml\.includes\("STAFF WORKSPACE"\)/);
  assert.match(probe, /UPDATE auth_session SET created_at = now\(\) - interval '11 minutes'/);
  assert.match(probe, /stage = `\$\{path\} returned HTTP \$\{response\.status\}`/);
  assert.match(probe, /"\/customer\/catalog"[\s\S]*"\/customer\/orders"[\s\S]*"\/customer\/wallet"[\s\S]*"\/customer\/settings"/);
  assert.match(probe, /customer session was not denied staff workspace/);
  assert.match(probe, /customer session was not denied staff API command/);
  assert.match(probe, /"\/revoke-session"[\s\S]*"\/revoke-other-sessions"[\s\S]*"\/revoke-sessions"/);
  assert.match(probe, /DELETE FROM auth_session WHERE id = \$1 AND user_id = \$2/);
  const rls = await read("../scripts/check-local-rls.ts");
  assert.match(rls, /select id from auth_session where user_id = \$1 and expires_at > now\(\)/);
});

test("customer workspace can revoke the current session and receives an accessible failure", async () => {
  const layout = await read("../src/app/customer/layout.tsx");
  const control = await read("../src/app/customer/customer-signout.tsx");
  assert.match(layout, /<CustomerSignOut\s*\/>/);
  assert.match(layout, /OrganizationOnboarding documents=\{legal\.documents\}\s*\/>\s*<CustomerSignOut\s*\/>/);
  assert.match(layout, /The current Terms and Privacy documents are not configured[\s\S]*<Link href="\/sign-in">Manage your sign-in<\/Link><CustomerSignOut\s*\/>/);
  assert.match(control, /authClient\.signOut\(\)/);
  assert.match(control, /router\.replace\("\/sign-in"\)/);
  assert.match(control, /role="alert"/);
});
