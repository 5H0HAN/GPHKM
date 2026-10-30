import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("customer catalog URL joins apply the customer-only authorization helper even for staff identities", () => {
  const read = source("src/server/catalog/customer.ts");
  assert.match(read, /const actor = await requireVerifiedCustomer\(headers\)/);
  assert.match(read, /leftJoin\(listingUrl, and\(eq\(listingUrl\.listingId, listing\.id\),\s*sql`public\.gphkm_customer_can_read_listing_url\(\$\{listing\.id\}, \$\{organizationId\}, \$\{actor\.userId\}\)`\)\)/);
  assert.match(read, /public\.gphkm_latest_customer_listing_metrics\(/);
  assert.match(read, /metric_scope: string/);
  const metricSql = source("src/db/migrations/0106_metric_redistribution_approval_events.sql");
  assert.match(metricSql, /app\.metric_customer_display_l05_verified/);
  assert.match(metricSql, /listing_metric_approval_event/);
  assert.match(metricSql, /latest\.status = 'AVAILABLE'/);
  assert.match(metricSql, /approval\.decision = 'APPROVED'/);
  assert.match(metricSql, /gphkm_is_active_org_member\(target_org_id, target_user_id\)/);
  const catalogSql = source("src/db/migrations/0004_catalog_inventory.sql");
  const start = catalogSql.indexOf("CREATE FUNCTION public.gphkm_customer_can_read_listing_url");
  const helper = catalogSql.slice(start, catalogSql.indexOf("$$;", start));
  assert.doesNotMatch(helper, /gphkm_is_active_staff/);
  assert.match(helper, /gphkm_is_active_org_member\(target_org, target_user\)/);
  assert.match(helper, /s\.url_visible_without_recharge OR EXISTS/);
});

test("customer Support lists and details cannot inherit assigned staff RLS access", () => {
  const support = source("src/server/support/cases.ts");
  for (const name of ["listCustomerSupportCases", "getCustomerSupportCase"]) {
    const start = support.indexOf(`export async function ${name}`);
    const next = support.indexOf("export async function", start + 1);
    const read = support.slice(start, next);
    assert.match(read, /const actor = await requireVerifiedCustomer\(headers\)/);
    assert.match(read, /eq\(supportCase\.organizationId, organizationId\)/);
    assert.match(read, /public\.gphkm_support_customer_access\(\$\{supportCase\.id\}, \$\{actor\.userId\}, \$\{organizationId\}\)/);
  }
  const sql = source("src/db/migrations/0011_support_cases.sql");
  const start = sql.indexOf("CREATE FUNCTION public.gphkm_support_customer_access");
  const helper = sql.slice(start, sql.indexOf("$$;", start));
  assert.doesNotMatch(helper, /gphkm_is_active_staff/);
  assert.match(helper, /gphkm_is_active_org_member\(c\.organization_id, target_user\)/);
  assert.match(helper, /c\.opened_by_user_id = target_user OR o\.actor_user_id = target_user/);
});

test("other customer read paths use explicit self/org fields and Owner-only recharge history", () => {
  const wallet = source("src/server/wallet/read.ts");
  const history = wallet.slice(wallet.indexOf("export async function getRechargeHistory"), wallet.indexOf("export async function getMarketplaceAccess"));
  assert.match(history, /if \(role !== "OWNER"\) throw/);
  assert.match(history, /eq\(paymentAttempt\.organizationId, organizationId\)/);
  assert.match(history, /const pageSize = 50/);
  assert.match(history, /count\(\)/);
  assert.match(history, /orderBy\(desc\(paymentAttempt\.createdAt\), desc\(paymentAttempt\.id\)\)/);
  assert.match(history, /limit\(pageSize\)\.offset\(\(page - 1\) \* pageSize\)/);
  const walletPage = source("src/app/customer/wallet/page.tsx");
  assert.match(walletPage, /isOwner\) \{\s*history = await getRechargeHistory/);
  assert.match(walletPage, /Recharge history pages/);
  assert.match(walletPage, /historyPage=\$\{history\.pagination\.page \+ 1\}/);
  assert.match(walletPage, /organizationId=\$\{encodeURIComponent\(organizationId\)\}&historyPage=/);
  assert.match(walletPage, /Wallet top-up attempts will appear here/);
  assert.doesNotMatch(walletPage, /Completed wallet top-ups will appear here/);
  const identity = source("src/server/identity/customer-context.ts");
  assert.match(identity, /eq\(organizationMember\.userId, actor\.userId\)/);
  assert.match(identity, /eq\(organizationMember\.active, true\)/);
  const legal = source("src/server/legal/consent.ts");
  assert.match(legal, /eq\(customerLegalAcceptance\.userId, userId\)/);
  const org = source("src/server/identity/organization-lifecycle.ts");
  assert.match(org, /if \(role !== "OWNER"\) return .*members: \[\], invitations: \[\]/);
});
