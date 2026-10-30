import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FULFILLMENT_QUEUE_PAGE_SIZE, fulfillmentQueuePagination, fulfillmentQueueView } from "../src/modules/fulfillment/queue-pagination.ts";

test("all active queue items beyond 100 are reachable without overlapping page boundaries", () => {
  const items = Array.from({ length: 225 }, (_, i) => `item-${i}`);
  const visited = [];
  for (let page = 1; page <= 3; page++) {
    const pagination = fulfillmentQueuePagination(String(page), items.length);
    assert.equal(pagination.page, page);
    assert.equal(pagination.pageCount, 3);
    visited.push(...items.slice(pagination.offset, pagination.offset + FULFILLMENT_QUEUE_PAGE_SIZE));
  }
  assert.deepEqual(visited, items);
  assert.equal(new Set(visited).size, 225);
});

test("invalid queue pages fall back to the first page and stale pages clamp to available work", () => {
  for (const input of [undefined, null, [], ["2"], "", "-1", "0", "1.5", "2junk", "Infinity", "9007199254740992", -1, NaN]) {
    assert.equal(fulfillmentQueuePagination(input, 225).page, 1);
  }
  assert.deepEqual(fulfillmentQueuePagination("99", 125), { page: 2, pageCount: 2, total: 125, offset: 100 });
  assert.deepEqual(fulfillmentQueuePagination("2", 0), { page: 1, pageCount: 1, total: 0, offset: 0 });
  assert.equal(fulfillmentQueuePagination(2, 200).pageCount, 2);
});

test("only an explicit all view includes terminal history; unknown or repeated filters stay active", () => {
  assert.equal(fulfillmentQueueView("all"), "all");
  for (const input of [undefined, null, "active", "ALL", "archive", ["all"], ["all", "active"]]) {
    assert.equal(fulfillmentQueueView(input), "active");
  }
});

test("queue query paginates the selected view inside existing staff authorization and keeps overdue active-only", () => {
  const source = readFileSync(new URL("../src/server/fulfillment/admin.ts", import.meta.url), "utf8");
  const queue = source.slice(source.indexOf("export async function listFulfillmentQueue("), source.indexOf("export async function getFulfillmentItem("));
  assert.match(source, /requireStaffAccess\(headers, "fulfillment.manage"\)/);
  assert.match(source, /set_config\('app.user_id', \$\{actor.userId\}, true\)/);
  assert.match(queue, /return staffTx\(headers/);
  assert.match(queue, /const active = notInArray\(orderItemFulfillment.state, \["COMPLETED", "CANCELED_REFUNDED"\]\)/);
  assert.match(queue, /const view = fulfillmentQueueView\(requestedView\)/);
  assert.match(queue, /const filter = view === "all" \? undefined : active/);
  assert.match(queue, /count\(\*\)::int[\s\S]*?from\(orderItemFulfillment\).where\(filter\)/);
  assert.match(queue, /leftJoin\(user,[\s\S]*?\.where\(filter\)\s*\.orderBy\(asc\(orderItemFulfillment.nextUpdateAt\), desc\(orderItemFulfillment.updatedAt\), asc\(orderItemFulfillment.orderItemId\)\)/);
  assert.match(queue, /\.limit\(FULFILLMENT_QUEUE_PAGE_SIZE\).offset\(pagination.offset\)/);
  assert.match(queue, /lte\(orderItemFulfillment.nextUpdateAt, now\),\s*active/);
});

test("queue navigation preserves the selected view and clearly labels total versus active counts", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/page.tsx", import.meta.url), "utf8");
  assert.match(page, /listFulfillmentQueue\(await headers\(\), params.page, params.view\)/);
  assert.match(page, /pagination.total\} \{view === "all" \? "total" : "active"\} items/);
  assert.match(page, /overdueCount\} active overdue update/);
  assert.match(page, /href="\/staff\/fulfillment\?view=all"/);
  assert.match(page, /const pageHref = \(page: number\) => `\/staff\/fulfillment\?page=\$\{page\}\$\{view === "all" \? "&view=all" : ""\}`/);
  assert.match(page, /aria-label="Fulfillment queue pages"/);
  assert.match(page, /pagination.page > 1[\s\S]*?href=\{pageHref\(pagination.page - 1\)\}/);
  assert.match(page, /pagination.page < pagination.pageCount[\s\S]*?href=\{pageHref\(pagination.page \+ 1\)\}/);
});
