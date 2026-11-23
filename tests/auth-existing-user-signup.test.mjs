import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

test("duplicate signup has no email hook and unverified email sign-in resends verification", async (t) => {
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
    BETTER_AUTH_SECRET: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64"),
    DATABASE_URL: "postgresql://gphkm_runtime@127.0.0.1:1/synthetic",
  });

  const { getAuthForSurface } = await tsImport("../src/server/auth/index.ts", import.meta.url);
  const auth = getAuthForSurface("customer");
  assert.equal(auth.options.emailAndPassword.onExistingUserSignUp, undefined);
  assert.equal(auth.options.emailVerification.sendOnSignIn, true);
});
