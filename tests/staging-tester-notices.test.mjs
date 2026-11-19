import test from "node:test";
import assert from "node:assert/strict";
import { assertExplicitLegalAcceptance, currentLegalDocuments, LegalConfigurationError, matchesCurrentLegalAcceptance } from "../src/modules/legal/policy.ts";
import { stagingTesterEmails, stagingTesterVersions } from "../src/modules/legal/staging-testers.ts";
import { testerNotices } from "../src/app/legal/testing/documents.ts";

const staging = {
  NODE_ENV: "production", GPHKM_DEPLOYMENT_ENV: "staging", GPHKM_STAGING_TESTER_NOTICES_ENABLED: "true",
  GPHKM_REAL_MONEY_ENABLED: "false", GPHKM_LAUNCH_GATES_VERIFIED: "false",
  CUSTOMER_APP_URL: "https://customers.staging.example.test", STAFF_APP_URL: "https://staff.staging.example.test",
  GPHKM_STAGING_GOOGLE_TEST_EMAILS: "Tester.Name+1@example.test, other@example.test",
};
const approved = {
  NODE_ENV: "production", GPHKM_TERMS_VERSION: "terms-commercial-v1", GPHKM_PRIVACY_VERSION: "privacy-commercial-v3",
  GPHKM_TERMS_URL: "https://legal.example.test/terms-v1", GPHKM_PRIVACY_URL: "https://legal.example.test/privacy-v3",
};

test("invited Google tester notices derive from the exact HTTPS customer origin and require explicit matching acceptance", () => {
  const emails = stagingTesterEmails(staging);
  assert.deepEqual([...emails], ["tester.name+1@example.test", "other@example.test"]);
  assert.equal(emails.has("testername@example.test"), false);
  const documents = currentLegalDocuments(staging);
  for (const kind of ["terms", "privacy"]) {
    assert.equal(documents[kind + "Version"], stagingTesterVersions[kind]);
    assert.equal(documents[kind + "Url"], staging.CUSTOMER_APP_URL + "/legal/testing/" + stagingTesterVersions[kind]);
    assert.ok(testerNotices[stagingTesterVersions[kind]].sections.length);
  }
  assert.doesNotThrow(() => assertExplicitLegalAcceptance({ ...documents, accepted: true }, documents));
  assert.throws(() => assertExplicitLegalAcceptance({ ...documents, accepted: false }, documents));
  assert.equal(matchesCurrentLegalAcceptance(currentLegalDocuments(approved), documents), false);
  assert.equal(matchesCurrentLegalAcceptance(documents, currentLegalDocuments(approved)), false);
});

test("tester mode refuses malformed lists, invalid origins, missing gates and mixed deployment settings", () => {
  for (const changes of [
    { GPHKM_DEPLOYMENT_ENV: "production" }, { GPHKM_REAL_MONEY_ENABLED: "true" }, { GPHKM_LAUNCH_GATES_VERIFIED: undefined },
    { GPHKM_LOCAL_AUTH_ENABLED: "true" }, { GPHKM_LOCAL_MFA_DISABLED: "true" }, { GPHKM_STAGING_TESTER_NOTICES_ENABLED: "TRUE" },
    { CUSTOMER_APP_URL: "http://app.example.test" }, { STAFF_APP_URL: staging.CUSTOMER_APP_URL }, { CUSTOMER_APP_URL: "https://user@example.test" },
    { GPHKM_STAGING_GOOGLE_TEST_EMAILS: "" }, { GPHKM_STAGING_GOOGLE_TEST_EMAILS: "a@example.test,*@example.test" },
    { GPHKM_STAGING_GOOGLE_TEST_EMAILS: "a@example.test," }, { GPHKM_STAGING_GOOGLE_TEST_EMAILS: "@example.test" },
  ]) {
    const env = { ...approved, ...staging, ...changes };
    assert.equal(stagingTesterEmails(env), null);
    assert.throws(() => currentLegalDocuments(env), LegalConfigurationError);
  }
});

test("review drafts, local placeholders and tester notices cannot be passed as approved production documents", () => {
  for (const change of [
    { GPHKM_TERMS_VERSION: stagingTesterVersions.terms }, { GPHKM_PRIVACY_VERSION: "local-test-v1" },
    { GPHKM_TERMS_VERSION: "terms-2026-11-19-v1" }, { GPHKM_PRIVACY_VERSION: "privacy-draft-v1" },
    { GPHKM_TERMS_URL: "https://localhost/legal/terms" },
    { GPHKM_PRIVACY_URL: staging.CUSTOMER_APP_URL + "/legal/testing/" + stagingTesterVersions.privacy },
    { GPHKM_TERMS_URL: staging.CUSTOMER_APP_URL + "/legal/drafts/terms-2026-11-19-v1" },
  ]) assert.throws(() => currentLegalDocuments({ ...approved, ...change }), LegalConfigurationError);
});
