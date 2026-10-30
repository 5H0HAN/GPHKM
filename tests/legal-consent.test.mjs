import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertExplicitLegalAcceptance, currentLegalDocuments, LegalConfigurationError, matchesCurrentLegalAcceptance } from "../src/modules/legal/policy.ts";

const configured = {
  NODE_ENV: "production", GPHKM_TERMS_VERSION: "terms-2026-10", GPHKM_PRIVACY_VERSION: "privacy-2026-10",
  GPHKM_TERMS_URL: "https://policies.example.test/terms/2026-10", GPHKM_PRIVACY_URL: "https://policies.example.test/privacy/2026-10",
};

test("legal configuration fails closed for missing versions/URLs and unsafe document locations", () => {
  const documents = currentLegalDocuments(configured);
  assert.equal(documents.termsVersion, configured.GPHKM_TERMS_VERSION);
  for (const key of ["GPHKM_TERMS_VERSION", "GPHKM_PRIVACY_VERSION", "GPHKM_TERMS_URL", "GPHKM_PRIVACY_URL"]) {
    assert.throws(() => currentLegalDocuments({ ...configured, [key]: "" }), LegalConfigurationError);
  }
  for (const url of ["javascript:alert(1)", "data:text/plain,terms", "http://policies.example.test/terms", "https://user:password@example.test/terms", "https://*.example.test/terms", `https://example.test/${"x".repeat(2048)}`]) {
    assert.throws(() => currentLegalDocuments({ ...configured, GPHKM_TERMS_URL: url }), LegalConfigurationError);
  }
  assert.throws(() => currentLegalDocuments({ ...configured, GPHKM_TERMS_VERSION: "terms\nforged" }), LegalConfigurationError);
});

test("HTTP document URLs are restricted to loopback development", () => {
  assert.equal(currentLegalDocuments({ ...configured, NODE_ENV: "development", GPHKM_TERMS_URL: "http://customer.localhost:3000/terms/v1" }).termsUrl, "http://customer.localhost:3000/terms/v1");
  for (const env of [
    { ...configured, GPHKM_TERMS_URL: "http://localhost:3000/terms/v1" },
    { ...configured, NODE_ENV: "test", GPHKM_TERMS_URL: "http://localhost:3000/terms/v1" },
    { ...configured, NODE_ENV: "development", GPHKM_TERMS_URL: "http://localhost.evil.test/terms" },
  ]) assert.throws(() => currentLegalDocuments(env), LegalConfigurationError);
});

test("acceptance requires an explicit checked boolean and both exact current versions", () => {
  const documents = currentLegalDocuments(configured);
  const accepted = { accepted: true, termsVersion: documents.termsVersion, privacyVersion: documents.privacyVersion };
  assert.doesNotThrow(() => assertExplicitLegalAcceptance(accepted, documents));
  for (const acceptedValue of [false, undefined, "true", "on", 1]) assert.throws(() => assertExplicitLegalAcceptance({ ...accepted, accepted: acceptedValue }, documents));
  assert.throws(() => assertExplicitLegalAcceptance({ ...accepted, termsVersion: "old-terms" }, documents));
  assert.throws(() => assertExplicitLegalAcceptance({ ...accepted, privacyVersion: "old-privacy" }, documents));
});

test("prior acceptance does not carry across changed versions or document locations", () => {
  const documents = currentLegalDocuments(configured);
  assert.equal(matchesCurrentLegalAcceptance(documents, documents), true);
  assert.equal(matchesCurrentLegalAcceptance(null, documents), false);
  assert.equal(matchesCurrentLegalAcceptance({ ...documents, termsVersion: "old" }, documents), false);
  assert.equal(matchesCurrentLegalAcceptance({ ...documents, privacyUrl: "https://other.example.test/privacy" }, documents), false);
});

test("legal evidence is append-only and common customer commands cannot skip the guard", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0013_customer_legal_consent.sql", import.meta.url), "utf8");
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /user_id = actor_user_id/);
  assert.match(migration, /accepted_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON customer_legal_acceptance/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /legal acceptance evidence is append-only/);
  assert.match(migration, /action = 'CUSTOMER_LEGAL_ACCEPTANCE_RECORDED'/);
  const context = readFileSync(new URL("../src/server/identity/customer-context.ts", import.meta.url), "utf8");
  assert.match(context, /if \(requireLegalAcceptance\) await requireCurrentLegalAcceptance\(tx, actor\.userId\)/);
  assert.match(context, /export function withProtectedOrganizationContext/);
  const lifecycle = readFileSync(new URL("../src/server/identity/organization-lifecycle.ts", import.meta.url), "utf8");
  assert.ok(lifecycle.indexOf("recordLegalAcceptance(tx, actorUserId, legalAcceptance)") < lifecycle.indexOf("tx.insert(organization)"));
  assert.match(lifecycle, /requireCurrentLegalAcceptance\(tx, actor\.user\.id\)/);
  const auth = readFileSync(new URL("../src/server/auth/index.ts", import.meta.url), "utf8");
  assert.match(auth, /surface === "customer" && context\.path === "\/sign-in\/social"/);
});

test("customer settings expose only the signed-in user's version and acceptance-time history", () => {
  const reader = readFileSync(new URL("../src/server/legal/consent.ts", import.meta.url), "utf8");
  assert.match(reader, /export async function listCustomerLegalAcceptanceHistory/);
  assert.match(reader, /set_config\('app\.user_id', \$\{userId\}, true\)/);
  assert.match(reader, /termsVersion: customerLegalAcceptance\.termsVersion/);
  assert.match(reader, /privacyVersion: customerLegalAcceptance\.privacyVersion/);
  assert.match(reader, /acceptedAt: customerLegalAcceptance\.acceptedAt/);
  assert.match(reader, /where\(eq\(customerLegalAcceptance\.userId, userId\)\)/);
  const settings = readFileSync(new URL("../src/app/customer/settings/page.tsx", import.meta.url), "utf8");
  assert.match(settings, /Terms and privacy history/);
  assert.match(settings, /listCustomerLegalAcceptanceHistory\(requestHeaders\)/);
});

test("a new legal version prompts without replacing the signed-in customer workspace", () => {
  const layout = readFileSync(new URL("../src/app/customer/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /legal && !legal\.accepted && <CustomerLegalAcceptance/);
  assert.doesNotMatch(layout, /if \(!legal\.accepted\)\s*\{/);
  assert.match(layout, /You can still use account settings and view your acceptance history/);
  const context = readFileSync(new URL("../src/server/identity/customer-context.ts", import.meta.url), "utf8");
  assert.match(context, /if \(requireLegalAcceptance\) await requireCurrentLegalAcceptance\(tx, actor\.userId\)/);
  assert.match(context, /export function withProtectedOrganizationContext/);
  const order = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const topup = readFileSync(new URL("../src/server/wallet/topups.ts", import.meta.url), "utf8");
  assert.match(order, /withProtectedOrganizationContext\(headers, organizationId/);
  assert.match(topup, /withProtectedOrganizationContext\(headers, organizationId/);
  const customerCatalog = readFileSync(new URL("../src/server/catalog/customer.ts", import.meta.url), "utf8");
  const walletRead = readFileSync(new URL("../src/server/wallet/read.ts", import.meta.url), "utf8");
  assert.match(customerCatalog, /withOrganizationContext\(headers, organizationId/);
  assert.match(walletRead, /withOrganizationContext\(headers, organizationId/);
});
