import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildContentSecurityPolicy } from "../src/modules/security/content-security-policy.ts";

const nonce = "YWJjZGVmZ2hpamtsbW5vcA==";

test("production customer CSP allows nonce-bound Next and Stripe scripts without inline script/style exceptions", () => {
  const policy = buildContentSecurityPolicy(nonce, { development: false, customerSurface: true });
  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce.replaceAll("+", "\\+")}' 'strict-dynamic' https://js\\.stripe\\.com`));
  assert.match(policy, /connect-src 'self'.*https:\/\/api\.stripe\.com/);
  assert.match(policy, /frame-src 'self'.*https:\/\/hooks\.stripe\.com/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /upgrade-insecure-requests/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
});

test("staff CSP excludes Stripe origins and invalid nonce input is rejected", () => {
  const policy = buildContentSecurityPolicy(nonce, { development: true, customerSurface: false });
  assert.match(policy, /unsafe-eval/);
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(policy, /style-src 'self' 'nonce-/);
  assert.doesNotMatch(policy, /stripe\.com|stripe\.network/);
  assert.throws(() => buildContentSecurityPolicy("bad nonce", { development: false, customerSurface: true }), /Invalid CSP nonce/);
});

test("Proxy forwards one generated CSP nonce to Next and returns the same policy", () => {
  const source = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8");
  assert.match(source, /requestHeaders\.set\("x-nonce", nonce\)/);
  assert.match(source, /requestHeaders\.set\("Content-Security-Policy", policy\)/);
  assert.match(source, /response\.headers\.set\("Content-Security-Policy", policy\)/);
  const appFiles = [
    "../src/app/customer/layout.tsx", "../src/app/customer/legal/terms/page.tsx", "../src/app/customer/legal/privacy/page.tsx",
  ];
  for (const file of appFiles) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /style=\{\{/);
});
