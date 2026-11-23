import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

test("an existing customer email sign-up gets account guidance from the system sender", async (t) => {
  t.mock.property(process, "env", {
    NODE_ENV: "production",
    GPHKM_DEPLOYMENT_ENV: "staging",
    CUSTOMER_APP_URL: "https://app.example.test",
    STAFF_APP_URL: "https://staff.example.test",
    GPHKM_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    GPHKM_REAL_MONEY_ENABLED: "false",
    GPHKM_LAUNCH_GATES_VERIFIED: "false",
    GPHKM_STAGING_TESTER_NOTICES_ENABLED: "false",
    GPHKM_STAGING_REVIEW_NOTICES_ENABLED: "true",
    GPHKM_TERMS_VERSION: "terms-staging-review",
    GPHKM_TERMS_URL: "https://app.example.test/legal/staging/terms",
    GPHKM_PRIVACY_VERSION: "privacy-staging-review",
    GPHKM_PRIVACY_URL: "https://app.example.test/legal/staging/privacy",
    GPHKM_RESEND_DATA_HANDLING_APPROVED: "true",
    RESEND_API_KEY: "synthetic-resend-key",
    RESEND_SYSTEM_FROM_EMAIL: "no-reply@example.test",
    RESEND_SUPPORT_FROM_EMAIL: "support@example.test",
    BETTER_AUTH_SECRET: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64"),
    DATABASE_URL: "postgresql://gphkm_runtime@127.0.0.1:1/synthetic",
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let message;
  globalThis.fetch = async (_url, init) => {
    message = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  };

  const { getAuthForSurface } = await tsImport("../src/server/auth/index.ts", import.meta.url);
  const callback = getAuthForSurface("customer").options.emailAndPassword.onExistingUserSignUp;
  assert.equal(typeof callback, "function");
  await callback({ user: { email: "customer@example.test", emailVerified: false } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(message.from, "no-reply@example.test");
  assert.deepEqual(message.to, ["customer@example.test"]);
  assert.equal(message.subject, "An account already exists for this email");
  assert.match(message.text, /sign in with your existing method/i);
  assert.match(message.text, /https:\/\/app\.example\.test\/sign-in/);
});
