import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateMetricRedistributionDecision } from "../src/modules/catalog/metric-approval.ts";
import { compareMetricTimestampVersions, isSameMetricUrlSnapshot } from "../src/modules/catalog/metric-refresh.ts";

test("metric refresh rejects URL changes and A → B → A reversions with DB precision", () => {
  const captured = { websiteUrl: "https://history.fixture.com/", version: "1793649186.123456" };
  assert.equal(isSameMetricUrlSnapshot(captured, { ...captured }), true);
  assert.equal(isSameMetricUrlSnapshot(captured, {
    websiteUrl: "https://blog.history.fixture.com/", version: "1793649186.123457",
  }), false);
  assert.equal(isSameMetricUrlSnapshot(captured, {
    websiteUrl: "https://history.fixture.com/", version: "1793649186.123458",
  }), false, "returning to the same URL still has a different revision token");
  assert.equal(isSameMetricUrlSnapshot(captured, {
    websiteUrl: "https://history.fixture.com/", version: "1793649186.1234567",
  }), false, "sub-millisecond URL revisions remain distinguishable");
  assert.equal(compareMetricTimestampVersions("1793649186.123456", "1793649186.123457"), -1,
    "database timestamp comparison preserves a one-microsecond ordering");
  assert.equal(compareMetricTimestampVersions("-0.000001", "0"), -1,
    "timestamp comparison handles negative epoch values safely");
});

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
  assert.match(service, /const currentHostname = url \? metricHostnameFromUrl\(url\.websiteUrl\) : null;[\s\S]*?observation\.requestedTarget !== currentHostname/);
  assert.ok(service.includes("lower(rtrim(substring(u.website_url from '^https?://([^/:?#]+)'), '.'))"));
  assert.match(service, /current_metric\.requested_target = \$\{currentWebsiteTarget\}/);
  assert.match(service, /ORDER BY m\.listing_id, m\.provider, m\.metric_scope, m\.refreshed_at DESC, m\.id DESC/);
});

test("reserved or local legacy observations stay out of review and customer display", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0154_metric_public_domain_gate.sql", import.meta.url), "utf8");
  const urlMigration = await readFile(new URL("../src/db/migrations/0155_metric_url_change_invalidation.sql", import.meta.url), "utf8");
  const approvalLockMigration = await readFile(new URL("../src/db/migrations/0156_metric_approval_url_lock.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const admin = await readFile(new URL("../src/server/catalog/admin.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/metrics/page.tsx", import.meta.url), "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.gphkm_metric_domain_refreshable/);
  assert.match(migration, /'alt', 'arpa', 'corp', 'example', 'home', 'internal', 'intranet', 'invalid', 'lan'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.gphkm_metric_domain_refreshable\(text\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_metric_domain_refreshable\(text\) TO gphkm_runtime/);
  assert.match(migration, /observation\.requested_target\)\s*\n\s*OR NOT EXISTS/);
  assert.match(migration, /public\.gphkm_metric_domain_refreshable\(current_metric\.requested_target\)/);
  assert.match(migration, /FROM public\.listing_metric_observation m[\s\S]*?WHERE m\.listing_id = ANY\(target_listing_ids\)[\s\S]*?ORDER BY m\.listing_id[\s\S]*?WHERE public\.gphkm_metric_domain_refreshable\(latest\.requested_target\)/);
  assert.match(urlMigration, /CREATE TRIGGER marketplace_listing_url_changed_at/);
  assert.match(urlMigration, /NEW\.updated_at := greatest\(clock_timestamp\(\), OLD\.updated_at \+ interval '1 microsecond'\)/);
  assert.equal((urlMigration.match(/refreshed_at >= u\.updated_at/g) ?? []).length, 3,
    "the base approval gate and both customer projection layers require a current URL version");
  assert.match(approvalLockMigration, /observation\.refreshed_at < current_url\.updated_at/,
    "approval must reject an observation from an older URL version");
  assert.match(approvalLockMigration, /WHERE listing_id = observation\.listing_id FOR SHARE/,
    "approval must serialize with concurrent listing URL updates");
  assert.match(service, /public\.gphkm_metric_domain_refreshable\(current_metric\.requested_target\)/);
  assert.match(service, /current_metric\.refreshed_at >= u\.updated_at/g);
  assert.match(service, /compareMetricTimestampVersions\(refreshVersion, urlVersion\) >= 0/);
  assert.match(service, /compareMetricTimestampVersions\(observation\.refreshVersion, url\.version\) < 0/);
  assert.match(service, /\.for\("share"\)/,
    "service approval must serialize with concurrent listing URL updates");
  assert.match(service, /urlVersion: sql<string>`extract\(epoch from \$\{listingUrl\.updatedAt\}\)::text`/,
    "refresh captures a database-precision URL revision before provider I/O");
  assert.match(service, /refreshVersion: sql<string>`extract\(epoch from \$\{listingMetricObservation\.refreshedAt\}\)::text`/,
    "candidate selection compares refresh timestamps at database precision");
  assert.match(service, /\.orderBy\(asc\(listingUrl\.listingId\)\)\.for\("share"\)/,
    "refresh locks URL rows in deterministic order before persistence");
  assert.match(service, /isSameMetricUrlSnapshot\(captured,[\s\S]*?current\.version/,
    "refresh discards provider results when a URL changes during the request");
  assert.match(service, /refreshedAt: sql<Date>`clock_timestamp\(\)`/,
    "refresh timestamps are issued by the database clock");
  assert.match(service, /sql`\$\{auditEvent\.createdAt\} >= now\(\) - interval '24 hours'`/,
    "quota window uses the database clock rather than application clock");
  assert.match(service, /decision\.decision === "APPROVED" && !isMetricDomainRefreshable\(currentHostname\)/);
  assert.match(service, /metric\.requestedTarget === currentTarget &&[\s\S]*?compareMetricTimestampVersions\(refreshVersion, urlVersion\) >= 0 && refreshable[\s\S]*?value: null, status: "STALE"/);
  assert.match(admin, /if \(currentUrl\.websiteUrl !== websiteUrl\)[\s\S]*?tx\.update\(listingUrl\)/);
  assert.match(page, /Stored value hidden · non-public hostname/);
});

test("metric review clamps pages and handles refresh/review results in place", async () => {
  const service = await readFile(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/metrics/page.tsx", import.meta.url), "utf8");
  const actions = await readFile(new URL("../src/app/staff/(console)/metrics/actions.ts", import.meta.url), "utf8");
  const controls = await readFile(new URL("../src/app/staff/(console)/metrics/metric-controls.tsx", import.meta.url), "utf8");
  assert.match(service, /if \(rows\.length === 0 && currentPage > 1\)[\s\S]*Math\.ceil\(total \/ pageSize\)[\s\S]*loadPage\(currentPage\)/);
  assert.match(page, /metricsHref\(refreshData\.page, approvals\.page \+ 1\)/);
  assert.match(actions, /revalidatePath\("\/staff\/metrics"\)/);
  assert.doesNotMatch(actions, /redirect\(/);
  assert.match(controls, /useActionState\(refreshOpenPageRankAction/);
  assert.match(controls, /disabled=\{!canRefresh \|\| pending \|\| selectedCount === 0\}/);
  assert.match(controls, /useActionState\(setMetricRedistributionApprovalAction/);
  assert.match(service, /latest\.event_sequence::text AS "reviewVersion"/);
  assert.match(page, /reviewVersion=\{item\.reviewVersion \?\? "unreviewed"\}/);
  assert.match(controls, /<fieldset className=\{styles\.reviewFields\} key=\{reviewVersion\} disabled=\{pending\}/);
});

test("metrics query indexes cover current observations and daily quota scans", async () => {
  const catalogSchema = await readFile(new URL("../src/db/catalog-schema.ts", import.meta.url), "utf8");
  const coreSchema = await readFile(new URL("../src/db/schema.ts", import.meta.url), "utf8");
  assert.match(catalogSchema, /listing_metric_listing_provider_date_idx"\)\.on\(t\.listingId, t\.provider, t\.metricScope, t\.refreshedAt\.desc\(\), t\.id\.desc\(\)/);
  assert.match(coreSchema, /audit_event_metrics_refresh_quota_idx"\)\.on\(table\.actorUserId, table\.createdAt\)[\s\S]*where\(sql`\$\{table\.action\} = 'METRICS_REFRESH_STARTED'`\)/);
});
