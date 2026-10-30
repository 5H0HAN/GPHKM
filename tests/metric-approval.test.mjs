import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateMetricRedistributionDecision } from "../src/modules/catalog/metric-approval.ts";

test("approval needs bounded attribution, evidence reference, and review reason", () => {
  assert.deepEqual(validateMetricRedistributionDecision({
    decision: "APPROVED", attributionText: "Open PageRank", evidenceReference: "LEGAL-REVIEW-123",
    reason: "Reviewed provider redistribution terms for this metric.",
  }), {
    decision: "APPROVED", attributionText: "Open PageRank", evidenceReference: "LEGAL-REVIEW-123",
    reason: "Reviewed provider redistribution terms for this metric.",
  });
  for (const input of [
    { decision: "APPROVED", attributionText: " ", evidenceReference: "LEGAL-123", reason: "Reviewed rights." },
    { decision: "APPROVED", attributionText: "x".repeat(301), evidenceReference: "LEGAL-123", reason: "Reviewed rights." },
    { decision: "APPROVED", attributionText: "Provider", evidenceReference: "no", reason: "Reviewed rights." },
    { decision: "APPROVED", attributionText: "Provider", evidenceReference: "LEGAL-123", reason: "no" },
    { decision: "APPROVE", attributionText: "Provider", evidenceReference: "LEGAL-123", reason: "Reviewed rights." },
  ]) assert.throws(() => validateMetricRedistributionDecision(input), /Invalid/);
  assert.equal(validateMetricRedistributionDecision({
    decision: "REVOKED", evidenceReference: "LEGAL-123", reason: "Rights review withdrawn.",
  }).attributionText, null);
});

test("redistribution approval is Super Admin-only, append-only, current-only, and L-05-gated", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0106_metric_redistribution_approval_events.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(migration, /listing_metric_approval_event/);
  assert.match(migration, /gphkm_is_active_staff\(NEW\.actor_user_id, 'SUPER_ADMIN'\)/);
  assert.match(migration, /newer\.refreshed_at, newer\.id/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON public\.listing_metric_approval_event FROM gphkm_runtime/);
  assert.match(migration, /app\.metric_customer_display_l05_verified/);
  assert.match(migration, /approval\.decision = 'APPROVED'/);
  assert.match(service, /requireStaffAccess\(headers, "metrics\.approve"\)/);
  assert.match(service, /METRIC_REDISTRIBUTION_APPROVED/);
  assert.match(envExample, /GPHKM_METRIC_CUSTOMER_DISPLAY_L05_VERIFIED=false/);
});

test("host-specific Open PageRank scope survives persistence, customer projection, and review", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0131_sharp_annihilus.sql", import.meta.url), "utf8");
  const targetMigration = await readFile(new URL("../src/db/migrations/0132_parched_silver_sable.sql", import.meta.url), "utf8");
  const schema = await readFile(new URL("../src/db/catalog-schema.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const customer = await readFile(new URL("../src/server/catalog/customer.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  assert.match(schema, /'REGISTERED_DOMAIN', 'DOMAIN', 'HOST'/);
  assert.match(migration, /metric_scope text, value numeric/);
  assert.match(migration, /latest\.metric_scope/);
  assert.match(service, /metricScope: providerRow\.scope/);
  assert.match(customer, /metric_scope: string/);
  assert.match(page, /scope === "HOST" \? "Host" : scope === "REGISTERED_DOMAIN" \? "Registered domain" : "Domain"/);
  assert.match(targetMigration, /metric_target/);
  assert.match(targetMigration, /requested_target = lower\(rtrim\(regexp_replace\(u\.website_url/);
  assert.match(service, /observation\.requestedTarget !== normalizeMetricDomain\(new URL\(url\.websiteUrl\)\.hostname\)/);
});

test("metric review clamps out-of-range pages and preserves the review page after actions", async () => {
  const service = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/metrics/page.tsx", import.meta.url), "utf8");
  const actions = await readFile(new URL("../src/app/staff/(console)/metrics/actions.ts", import.meta.url), "utf8");
  assert.match(service, /if \(rows\.length === 0 && currentPage > 1\)[\s\S]*Math\.ceil\(total \/ pageSize\)[\s\S]*loadPage\(currentPage\)/);
  assert.match(page, /name="approvalPage" value=\{approvals\?\.page \?\? 1\}/);
  assert.match(actions, /approvalError=review/);
  assert.match(actions, /redirect\(`\/staff\/metrics\?\$\{pageQuery\}&approvalSaved=1`\)/);
});
