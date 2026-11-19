import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { tsImport } from "tsx/esm/api";

const origins = {
  NODE_ENV: "production",
  CUSTOMER_APP_URL: "https://app.example.test",
  STAFF_APP_URL: "https://staff.example.test",
  GPHKM_PUBLIC_BASE_URL: "https://example.test",
};

test("the distinct public hostname serves the landing page, readiness and two signed webhook handlers", async (t) => {
  t.mock.property(process, "env", { ...origins });
  const { proxy } = await tsImport("../src/proxy.ts", import.meta.url);
  function request(host, path, method = "GET") {
    return proxy(new NextRequest(`https://${host}${path}`, { method, headers: { host } }));
  }
  for (const method of ["GET", "HEAD"]) {
    const page = request("example.test", "/", method);
    assert.equal(page.headers.get("x-middleware-next"), "1");
    assert.match(page.headers.get("content-security-policy"), /script-src 'self' 'nonce-/);
    assert.doesNotMatch(page.headers.get("content-security-policy"), /stripe\.com/);
  }
  for (const path of ["/api/payments/stripe/webhook", "/api/webhooks/resend"]) {
    assert.equal(request("example.test", path, "POST").headers.get("x-middleware-next"), "1");
    assert.equal(request("example.test", path).status, 404);
  }
  for (const path of ["/sign-in", "/staff", "/customer", "/api/auth/get-session", "/api/customer/wallet/top-ups", "/api/webhooks/resend/extra"]) {
    assert.equal(request("example.test", path).status, 404);
    assert.equal(request("example.test", path, "POST").status, 404);
  }
  assert.equal(request("example.test", "/", "POST").status, 404);
  assert.equal(request("other.example.test", "/").status, 404);
  assert.equal(request("example.test", "/fonts/other.woff2").status, 404);
  for (const host of ["example.test", "app.example.test", "staff.example.test"]) {
    assert.equal(request(host, "/fonts/geist-latin.woff2").headers.get("x-middleware-next"), "1");
  }
  assert.equal(request("example.test", "/api/health").headers.get("x-middleware-next"), "1");
  assert.equal(request("127.0.0.1", "/api/health").headers.get("x-middleware-next"), "1");
  assert.equal(request("app.example.test", "/").headers.get("x-middleware-rewrite"), `${origins.CUSTOMER_APP_URL}/customer`);
  assert.equal(request("staff.example.test", "/").headers.get("x-middleware-rewrite"), `${origins.STAFF_APP_URL}/staff`);
});

test("production credential auth initializes without Google and incomplete Google settings fail only on the customer surface", async (t) => {
  t.mock.property(process, "env", {
    ...origins,
    DATABASE_URL: "postgresql://gphkm_runtime@127.0.0.1:1/synthetic",
    MFA_PROOF_DATABASE_URL: "postgresql://gphkm_mfa_proof@127.0.0.1:1/synthetic",
    BETTER_AUTH_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
    GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    GOOGLE_CLIENT_ID: "synthetic-client",
  });
  const { getAuthForSurface } = await tsImport("../src/server/auth/index.ts", import.meta.url);
  const staff = getAuthForSurface("staff");
  assert.equal(staff.options.emailAndPassword.enabled, true);
  assert.deepEqual(staff.options.socialProviders, {});
  assert.throws(() => getAuthForSurface("customer"), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  delete process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "synthetic-secret";
  assert.throws(() => getAuthForSurface("customer"), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  delete process.env.GOOGLE_CLIENT_SECRET;
  const customer = getAuthForSurface("customer");
  assert.equal(customer.options.emailAndPassword.enabled, true);
  assert.deepEqual(customer.options.socialProviders, {});
});
