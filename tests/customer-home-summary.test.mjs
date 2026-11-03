import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerHomeTimestampIso } from "../src/modules/orders/home-summary.ts";

const server = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
const start = server.indexOf("export async function getCustomerOrderHomeSummary");
const end = server.indexOf("export async function getMyOrdersPage", start);
const summary = server.slice(start, end);

test("customer home summary counts every scoped order and placement independently of the paginated order history", () => {
  assert.ok(start >= 0 && end > start, "home summary query is present before order-history pagination");
  assert.match(summary, /requireVerifiedCustomer\(headers\)/);
  assert.match(summary, /withOrganizationContext\(headers, organizationId, async \(tx, role\)/);
  assert.match(summary, /eq\(customerOrder\.organizationId, organizationId\)/);
  assert.match(summary, /if \(role === "MEMBER"\) scope\.push\(eq\(customerOrder\.actorUserId, actor\.userId\)\)/);
  assert.match(summary, /count\(distinct \$\{customerOrder\.id\}\)::integer/);
  assert.match(summary, /count\(\$\{customerOrderItem\.id\}\)::integer/);
  assert.match(summary, /activePlacementCount:[\s\S]*?filter \(where[\s\S]*?not in \('COMPLETE', 'RESOLVED', 'CANCELLED', 'REFUNDED'\)/);
  const aggregateQuery = summary.slice(summary.indexOf("const [counts]"), summary.indexOf("const recentActivity"));
  assert.doesNotMatch(aggregateQuery, /\.limit\(|\.offset\(|customerOrderPagination/);
  assert.doesNotMatch(summary, /getMyOrders(Page)?\(/);
  assert.doesNotMatch(summary, /customerOrderPagination|\.offset\(/);
});

test("home summary returns only four customer-safe activity records in stable newest-first order", () => {
  assert.match(summary, /title: sql<string>`coalesce\(\$\{customerOrderItem\.customerListingSnapshot\}->>'title'/);
  assert.match(summary, /status: sql<string>`coalesce\(\$\{orderItemFulfillment\.customerStatus\}, 'ORDER_RECEIVED'\)`/);
  assert.match(summary, /orderBy\(desc\(sql`coalesce\(\$\{orderItemFulfillment\.updatedAt\}, \$\{customerOrder\.createdAt\}\)`\), desc\(customerOrderItem\.id\)\)\s*\.limit\(4\)/);
  for (const privateField of ["articleText", "writingBrief", "supplierId", "sourceCost", "internalNotes", "publicationEvidence"]) {
    assert.equal(summary.includes(privateField), false, `home activity does not select ${privateField}`);
  }
});

test("customer home summary normalizes PostgreSQL Date and string timestamp projections", () => {
  const expected = "2026-11-03T06:07:08.000Z";
  assert.equal(customerHomeTimestampIso(new Date(expected)), expected);
  assert.equal(customerHomeTimestampIso(expected), expected);
  assert.equal(customerHomeTimestampIso(null), null);
  assert.throws(() => customerHomeTimestampIso("not-a-timestamp"), /timestamp is unavailable/);
  assert.match(summary, /customerHomeTimestampIso\(row\.updatedAt\)/);
  assert.match(summary, /customerHomeTimestampIso\(row\.nextUpdateAt\)/);
});

test("customer home renders aggregate counts and activity without loading the first 50 full orders", () => {
  const page = readFileSync(new URL("../src/app/customer/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getCustomerOrderHomeSummary\(requestHeaders, organization\.id\)/);
  assert.match(page, /orders\?\.orderCount/);
  assert.match(page, /orders\?\.placementCount/);
  assert.match(page, /orders\?\.activePlacementCount/);
  assert.match(page, /orders\?\.recentActivity/);
  assert.doesNotMatch(page, /getMyOrders\(/);
  assert.match(page, /getCustomerSupportSummary\(requestHeaders, organization\.id\)/);
  assert.match(page, /support\.openCount/);
  assert.match(page, /support\.waitingOnCustomerCount/);
  assert.match(page, /support\.recent\.map/);
  assert.match(page, /\/customer\/support\/\$\{item\.id\}\?organizationId=/);
  assert.doesNotMatch(page, /listCustomerSupportCases\(/);
});
