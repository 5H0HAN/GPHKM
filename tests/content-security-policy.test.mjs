import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("only customer staging adds the exact Ask ChatGPT picker styles to the production policy", () => {
  const overlayHash = "'sha256-62lPaUtpvg47KrxPOXYc0Ki8fkE6PNsbY5I9DpyEwZ4='";
  const cursorSelector = "html, body, body *, #codex-browser-sidebar-comments-root, #codex-browser-sidebar-comments-root *";
  const cursorHashes = [" -webkit-user-select: none !important; user-select: none !important;", ""].map(selection => {
    const css = `${cursorSelector} { cursor: none !important;${selection} }`;
    return `'sha256-${createHash("sha256").update(css).digest("base64")}'`;
  });
  const options = { development: false, customerSurface: true };
  const standard = buildContentSecurityPolicy(nonce, options);
  const staging = buildContentSecurityPolicy(nonce, { ...options, staging: true });
  const style = `style-src 'self' 'nonce-${nonce}'`;
  assert.equal(staging, standard.replace(style, [style, overlayHash, ...cursorHashes].join(" ")));
  assert.doesNotMatch(standard, /sha256-|unsafe-inline/);
  const otherSurface = { ...options, customerSurface: false };
  assert.equal(buildContentSecurityPolicy(nonce, { ...otherSurface, staging: true }), buildContentSecurityPolicy(nonce, otherSurface));
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
