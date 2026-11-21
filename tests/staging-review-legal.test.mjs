import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const base = {
  NODE_ENV: "production",
  GPHKM_DEPLOYMENT_ENV: "staging",
  GPHKM_STAGING_REVIEW_NOTICES_ENABLED: "true",
  GPHKM_STAGING_TESTER_NOTICES_ENABLED: "false",
  GPHKM_REAL_MONEY_ENABLED: "false",
  GPHKM_LAUNCH_GATES_VERIFIED: "false",
  GPHKM_LOCAL_AUTH_ENABLED: "false",
  GPHKM_LOCAL_MFA_DISABLED: "false",
  CUSTOMER_APP_URL: "https://app.example.test",
  STAFF_APP_URL: "https://staff.example.test",
};

test("staging review notices have fixed, versioned acceptance records and clean public URLs", async () => {
  const { currentLegalDocuments, usesStagingReviewNotices } = await tsImport("../src/modules/legal/policy.ts", import.meta.url);
  const documents = currentLegalDocuments(base);
  assert.equal(usesStagingReviewNotices(documents), true);
  assert.equal(documents.termsVersion, "terms-staging-review");
  assert.equal(documents.privacyVersion, "privacy-staging-review");
  assert.equal(documents.termsUrl, "https://app.example.test/legal/staging/terms");
  assert.equal(documents.privacyUrl, "https://app.example.test/legal/staging/privacy");
  assert.doesNotMatch(JSON.stringify(documents), /draft|2026|v1/i);
});

test("staging review notices cannot be enabled outside staging or with a live-money gate", async () => {
  const { currentLegalDocuments, LegalConfigurationError } = await tsImport("../src/modules/legal/policy.ts", import.meta.url);
  for (const env of [
    { ...base, GPHKM_DEPLOYMENT_ENV: "production" },
    { ...base, GPHKM_REAL_MONEY_ENABLED: "true" },
    { ...base, GPHKM_LAUNCH_GATES_VERIFIED: "true" },
    { ...base, GPHKM_LOCAL_AUTH_ENABLED: "true" },
    { ...base, STAFF_APP_URL: "http://staff.example.test" },
  ]) {
    assert.throws(() => currentLegalDocuments(env), LegalConfigurationError);
  }
});
