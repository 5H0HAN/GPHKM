import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("current orders and history use scoped, pre-pagination lifecycle filters", () => {
  const service = read("../src/server/orders/checkout.ts");
  const paged = service.slice(service.indexOf("export async function getMyOrdersPage"), service.indexOf("export async function getMyOrderItemForSupport"));
  assert.match(paged, /const scope = \[eq\(customerOrder\.organizationId, organizationId\)\]/);
  assert.match(paged, /if \(role === "MEMBER"\) scope\.push\(eq\(customerOrder\.actorUserId, actor\.userId\)\)/);
  assert.match(paged, /fulfillment\.customer_status not in \('COMPLETE', 'RESOLVED'\)/);
  assert.match(paged, /fulfillment\.customer_status in \('COMPLETE', 'RESOLVED'\)/);
  assert.match(paged, /milestone\.status = fulfillment\.customer_status/);
  assert.match(paged, /CURRENT_TIMESTAMP - INTERVAL '48 hours'/);
  assert.match(paged, /if \(view === "current"\) scope\.push\(or\(hasActivePlacement, hasRecentlyFinishedPlacement\)!\)/);
  assert.match(paged, /if \(view === "history"\) scope\.push\(sql`not \(\$\{hasActivePlacement\}\) and not \(\$\{hasRecentlyFinishedPlacement\}\)`\)/);
  assert.match(paged, /count\(\*\)::integer.*from\(customerOrder\)\.where\(and\(\.\.\.scope\)\)/);
  assert.match(paged, /const ordering = view === "current"[\s\S]*?desc\(hasActivePlacement\), desc\(customerOrder\.createdAt\), desc\(customerOrder\.id\)/);
  assert.match(paged, /orderBy\(\.\.\.ordering\)\.limit\(pagination\.limit\)\.offset\(pagination\.offset\)/);
  assert.match(service, /getMyOrdersPage\(headers, organizationId, 1, "all", limit\)/);
});

test("order view routes clearly separate current work from read-only history", () => {
  const ordersPage = read("../src/app/customer/orders/page.tsx");
  const historyPage = read("../src/app/customer/orders/history/page.tsx");
  const view = read("../src/app/customer/orders/orders-view.tsx");
  const spec = read("../docs/PRODUCT_SPEC.md");
  assert.match(ordersPage, /view="current"/);
  assert.match(historyPage, /view="history"/);
  assert.match(view, /href=\{viewHref\("current"\)\}/);
  assert.match(view, /href=\{viewHref\("history"\)\}/);
  assert.match(view, /Finished orders stay here for 48 hours after their final placement/);
  assert.match(view, /const canManagePlacement = view === "current" && !terminal/);
  assert.match(view, /canManagePlacement && <details className=\{styles\.moreActions\}/);
  assert.match(spec, /latest terminal customer milestone/);
  assert.match(spec, /Order history is read-only for placement actions/);
});
