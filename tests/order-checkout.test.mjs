import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHECKOUT_DISCLOSURES, CUSTOMER_ORDERS_PAGE_SIZE, MAX_CUSTOMER_ORDERS_PAGE_ITEMS, MAX_ORDER_ITEMS, checkoutDisclosuresAreCurrent, customerOrderPagination, customerOrderProjection, validateCheckoutInput } from "../src/modules/orders/checkout.ts";

const item = (listingId = "listing-1") => ({
  listingId,
  expectedRevision: 1,
  targetUrl: "https://customer.example/path",
  anchorText: "Helpful guide",
  articleText: "A publication ready article.",
  shareWithPublicationPartner: true,
});
const validateItems = (items) => validateCheckoutInput({
  idempotencyKey: "order-key-00000001", acceptContentPolicy: true, disclosureVersions: CHECKOUT_DISCLOSURES, items,
});

test("checkout accepts up to 25 unique listings and rejects duplicates and oversize carts", () => {
  assert.deepEqual(validateItems([item()]), []);
  assert.deepEqual(validateItems(Array.from({ length: 25 }, (_, i) => item(`listing-${i}`))), []);
  assert.ok(validateItems([item(), item()]).some((e) => e.code === "DUPLICATE_LISTING"));
  assert.ok(validateItems(Array.from({ length: 26 }, (_, i) => item(`listing-${i}`))).some((e) => e.code === "INVALID_ITEM_COUNT"));
});

test("checkout accepts either bounded article text or eligible writing brief, with required consent", () => {
  assert.deepEqual(validateItems([{ ...item(), articleText: undefined, useWriting: true, writingBrief: "Write about our product." }]), []);
  assert.ok(validateItems([{ ...item(), shareWithPublicationPartner: false }]).some((e) => e.code === "CONSENT_REQUIRED"));
  assert.ok(validateItems([{ ...item(), targetUrl: "javascript:alert(1)" }]).some((e) => e.code === "INVALID_TARGET_URL"));
  assert.ok(validateItems([{ ...item(), expectedRevision: 0 }]).some((e) => e.code === "INVALID_LISTING_REVISION"));
  assert.ok(validateItems([{ ...item(), articleText: "x".repeat(20001) }]).some((e) => e.code === "INVALID_ARTICLE"));
  assert.deepEqual(validateItems([{ ...item(), instructions: "Place the link in the second section.\nUse the supplied heading." }]), []);
  assert.ok(validateItems([{ ...item(), instructions: "x".repeat(4001) }]).some((e) => e.code === "INVALID_INSTRUCTIONS"));
  assert.ok(validateItems([{ ...item(), unexpected: "supplierId" }]).some((e) => e.code === "UNKNOWN_FIELDS"));
  assert.ok(validateCheckoutInput({ idempotencyKey: "order-key-00000001", items: [item()] }).some((e) => e.code === "CONTENT_POLICY_ACCEPTANCE_REQUIRED"));
});

test("customer order projection exposes only customer-facing fields", () => {
  const result = customerOrderProjection({
    id: "order-1", customerStatus: "ORDER_RECEIVED", currency: "USD", placementTotalMinor: "12000",
    writingTotalMinor: "0", totalMinor: "12000", createdAt: new Date("2026-10-28T00:00:00Z"),
    items: [{
      id: "item-1", listingId: "listing-1", customerListingSnapshot: { title: "Example", supplierId: "private", commercialSource: "SUPPLIER_SOURCED", websiteUrl: "https://hidden.test" },
      placementPriceMinor: "12000", writingSelected: false, writingPriceMinor: "0", targetUrl: "https://buyer.test",
      anchorText: "link", instructions: "Please use the second section.", articleText: "article", writingBrief: null, customerStatus: "ORDER_RECEIVED",
    }],
  });
  assert.equal(result.items[0].status, "ORDER_RECEIVED");
  assert.equal(result.items[0].instructions, "Please use the second section.");
  assert.equal("supplierId" in result.items[0], false);
  assert.equal("commercialSource" in result.items[0], false);
  assert.equal("sourceCostMinor" in result.items[0], false);
  assert.equal("supplierId" in result.items[0].listing, false);
  assert.equal("websiteUrl" in result.items[0].listing, false);
});

test("checkout checks displayed disclosure versions and saves them alongside immutable listing snapshots", () => {
  assert.ok(checkoutDisclosuresAreCurrent(CHECKOUT_DISCLOSURES));
  for (const version of Object.keys(CHECKOUT_DISCLOSURES)) {
    assert.equal(checkoutDisclosuresAreCurrent({ ...CHECKOUT_DISCLOSURES, [version]: "stale" }), false);
  }
  assert.ok(validateCheckoutInput({ items: [item()], acceptContentPolicy: true, idempotencyKey: "order-key-00000001" })
    .some((error) => error.code === "INVALID_DISCLOSURE_VERSIONS"));
  const service = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const snapshot = service.split("function listingSnapshot")[1].split("export async function createWalletFundedOrder")[0];
  assert.doesNotMatch(snapshot, /placementDisclosureVersion|writingRefundDisclosureVersion/);
  assert.match(service, /requestDigest[\s\S]*placementDisclosureVersion: input.disclosureVersions.placementDisclosureVersion/);
  assert.match(service, /checkoutDisclosuresAreCurrent\(input.disclosureVersions\)/);
  assert.match(service, /customerListingSnapshot: listingSnapshot\(row\),\s*placementDisclosureVersion: input.disclosureVersions.placementDisclosureVersion,\s*writingRefundDisclosureVersion: useWriting \? input.disclosureVersions.writingRefundDisclosureVersion : null/);
});

test("database checkout gates exact current disclosure versions without rewriting legacy snapshots", () => {
  const schema = readFileSync(new URL("../src/db/order-schema.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0190_checkout_disclosure_versions.sql", import.meta.url), "utf8");
  const finalizationGuard = readFileSync(new URL("../src/db/migrations/0191_require_content_policy_at_checkout.sql", import.meta.url), "utf8");
  assert.match(schema, /customer_order_content_sharing_notice_current[\s\S]*gphkm-content-sharing-v1/);
  assert.match(schema, /customer_order_item_consent_notice_current[\s\S]*gphkm-content-sharing-v1/);
  assert.match(schema, /customer_order_item_disclosure_versions_current[\s\S]*gphkm-placement-disclosure-v1[\s\S]*gphkm-writing-stages-v1/);
  assert.equal((migration.match(/NOT VALID;/g) ?? []).length, 3);
  assert.match(migration, /DROP POLICY customer_order_create[\s\S]*content_sharing_notice_version = 'gphkm-content-sharing-v1'/);
  assert.match(migration, /DROP POLICY customer_order_item_create[\s\S]*placement_disclosure_version = 'gphkm-placement-disclosure-v1'/);
  assert.match(migration, /gphkm_validate_checkout_disclosures[\s\S]*BEFORE UPDATE OF checkout_state/);
  assert.match(migration, /writing_refund_disclosure_version IS DISTINCT FROM 'gphkm-writing-stages-v1'/);
  assert.match(finalizationGuard, /content_policy_version IS DISTINCT FROM 'gphkm-content-policy-v1'/);
  assert.match(finalizationGuard, /content_policy_accepted_at IS NULL/);
  assert.match(finalizationGuard, /current checkout disclosures are required/);
});

test("customer Orders supports actions for all placements on a full page", () => {
  assert.equal(MAX_CUSTOMER_ORDERS_PAGE_ITEMS, CUSTOMER_ORDERS_PAGE_SIZE * MAX_ORDER_ITEMS);
  assert.equal(MAX_CUSTOMER_ORDERS_PAGE_ITEMS, 1250);
  const content = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  assert.match(content, /ids.length > MAX_CUSTOMER_ORDERS_PAGE_ITEMS/);
});

const orderWithStatuses = (...statuses) => ({
  id: "order-progress", customerStatus: "COMPLETE", currency: "USD", placementTotalMinor: "100",
  writingTotalMinor: "0", totalMinor: "100", createdAt: new Date("2026-10-28T00:00:00Z"),
  items: statuses.map((customerStatus, index) => ({
    id: `item-${index}`, listingId: `listing-${index}`, customerListingSnapshot: { title: "Placement" },
    placementPriceMinor: "100", writingSelected: false, writingPriceMinor: "0", targetUrl: "https://buyer.test",
    anchorText: "link", articleText: "article", writingBrief: null, customerStatus,
  })),
});

test("terminal items cannot make a mixed order complete or resolved", () => {
  for (const active of ["ORDER_RECEIVED", "CONTENT_REVIEW", "PREPARING", "IN_PROGRESS", "LINK_VERIFICATION"]) {
    for (const terminal of ["COMPLETE", "RESOLVED"]) {
      assert.equal(customerOrderProjection(orderWithStatuses(terminal, active)).status, active);
      assert.equal(customerOrderProjection(orderWithStatuses(active, terminal)).status, active);
    }
  }
  assert.equal(customerOrderProjection(orderWithStatuses("RESOLVED", "CONTENT_REVIEW", "COMPLETE", "IN_PROGRESS")).status, "IN_PROGRESS");
  assert.equal(customerOrderProjection(orderWithStatuses("COMPLETE", "COMPLETE")).status, "COMPLETE");
  assert.equal(customerOrderProjection(orderWithStatuses("COMPLETE", "RESOLVED")).status, "RESOLVED");
});

test("customer order progress retains dates and all publication URLs without exposing internal fields", () => {
  const order = orderWithStatuses("COMPLETE");
  Object.assign(order.items[0], {
    lastUpdatedAt: "2026-10-29T09:30:00.000Z", nextUpdateAt: "2026-10-30T12:00:00.000Z",
    publicationUrls: ["https://publication.example/one", "https://publication.example/two"],
    supplierId: "private", sourceCostMinor: "50", internalNotes: "private notes",
  });
  const [projected] = customerOrderProjection(order).items;
  assert.equal(projected.lastUpdatedAt, order.items[0].lastUpdatedAt);
  assert.equal(projected.nextUpdateAt, order.items[0].nextUpdateAt);
  assert.deepEqual(projected.publicationUrls, order.items[0].publicationUrls);
  assert.equal(projected.googleIndexingStatus, "UNKNOWN");
  for (const field of ["supplierId", "sourceCostMinor", "internalNotes"]) assert.equal(field in projected, false);
  const [withoutProgress] = customerOrderProjection(orderWithStatuses("ORDER_RECEIVED")).items;
  assert.equal(withoutProgress.lastUpdatedAt, null);
  assert.equal(withoutProgress.nextUpdateAt, null);
  assert.deepEqual(withoutProgress.publicationUrls, []);
  assert.equal(withoutProgress.googleIndexingStatus, null);
});

test("customer milestone history is an explicit public allowlist", () => {
  const result = customerOrderProjection({
    id: "order-history", customerStatus: "IN_PROGRESS", currency: "USD", placementTotalMinor: "100",
    writingTotalMinor: "0", totalMinor: "100", createdAt: new Date("2026-10-28T00:00:00Z"),
    items: [{
      id: "item-history", listingId: "listing-1", customerListingSnapshot: { title: "Example" },
      placementPriceMinor: "100", writingSelected: false, writingPriceMinor: "0", targetUrl: "https://buyer.test",
      anchorText: "link", articleText: "article", writingBrief: null, customerStatus: "IN_PROGRESS",
      milestoneHistory: [{ status: "IN_PROGRESS", nextUpdateAt: "2026-10-31T00:00:00.000Z", occurredAt: "2026-10-29T00:00:00.000Z", internalState: "SENT_TO_SUPPLIER", staffNote: "private" }],
    }],
  });
  assert.deepEqual(result.items[0].milestoneHistory, [{
    status: "IN_PROGRESS", nextUpdateAt: "2026-10-31T00:00:00.000Z", occurredAt: "2026-10-29T00:00:00.000Z",
  }]);
  const page = readFileSync(new URL("../src/app/customer/orders/page.tsx", import.meta.url), "utf8");
  assert.match(page, /aria-label="Placement update history"/);
  assert.match(page, /\[\.\.\.item\.milestoneHistory\]\.reverse\(\)/);
});

test("customer Orders view renders each item's projected dates and publication links with safe new-tab attributes", () => {
  const page = readFileSync(new URL("../src/app/customer/orders/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const lastUpdatedAt = item\.lastUpdatedAt \?\? order\.createdAt/);
  assert.match(page, /<span>Last updated<\/span><time dateTime=\{lastUpdatedAt\}/);
  assert.match(page, /<span>Next update<\/span>\{item\.nextUpdateAt \? <time dateTime=\{item\.nextUpdateAt\}/);
  assert.match(page, /Your approval was saved\. The placement below shows its latest progress\./);
  assert.doesNotMatch(page, /order remains Preparing while GPHKM resends/);
  assert.match(page, /pendingDate}>To be scheduled<\/span>/);
  assert.match(page, /item\.publicationUrls\.map\(\(url, index\) =>/);
  assert.match(page, /Google indexing: \{item\.googleIndexingStatus === "UNKNOWN"/);
  assert.match(page, /<a href=\{url\} target="_blank" rel="noopener noreferrer">Open live publication/);
});


test("order pagination reaches all history and bounds page inputs and query size", () => {
  const ids = Array.from({ length: 121 }, (_, index) => index);
  const visited = [];
  for (const page of [1, "2", 3]) {
    const result = customerOrderPagination(page, ids.length);
    assert.equal(result.totalPages, 3);
    visited.push(...ids.slice(result.offset, result.offset + result.limit));
  }
  assert.deepEqual(visited, ids);
  for (const invalid of [undefined, null, "0", "-1", "1.5", "1e2", "2x", ["2"], Infinity, NaN, "999999999999999999999"]) {
    assert.equal(customerOrderPagination(invalid, 121).page, 1);
  }
  assert.deepEqual(customerOrderPagination("999", 121), { page: 3, totalPages: 3, totalOrders: 121, limit: 50, offset: 100 });
  assert.deepEqual(customerOrderPagination("2", 0), { page: 1, totalPages: 1, totalOrders: 0, limit: 50, offset: 0 });
  assert.equal(customerOrderPagination(1, 121, 1000).limit, 100);
  assert.equal(customerOrderPagination(1, 121, -5).limit, 1);
});

test("order count and rows share organization and Member scope with a stable bounded query", () => {
  const server = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const paged = server.slice(server.indexOf("export async function getMyOrdersPage"), server.indexOf("export async function getMyOrderItemForSupport"));
  assert.match(paged, /withOrganizationContext\(headers, organizationId, async \(tx, role\)/);
  assert.match(paged, /const scope = \[eq\(customerOrder.organizationId, organizationId\)\]/);
  assert.match(paged, /if \(role === "MEMBER"\) scope.push\(eq\(customerOrder.actorUserId, actor.userId\)\)/);
  assert.match(paged, /count\(\*\)::integer.*from\(customerOrder\).where\(and\(\.\.\.scope\)\)/);
  assert.match(paged, /orderBy\(desc\(customerOrder.createdAt\), desc\(customerOrder.id\)\).limit\(pagination.limit\).offset\(pagination.offset\)/);
  const page = readFileSync(new URL("../src/app/customer/orders/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getMyOrdersPage\(await headers\(\), organizationId, params.page\)/);
  assert.match(page, /organizationId=\$\{encodeURIComponent\(organizationId\)\}&page=\$\{target\}/);
  assert.match(page, /Page \{page\} of \{totalPages\}/);
  assert.match(page, /\{page > 1 \? <Link href=\{pageHref\(page - 1\)\}>← Newer orders<\/Link> : <span \/>\}/);
  assert.match(page, /\{page < totalPages \? <Link href=\{pageHref\(page \+ 1\)\}>Older orders →<\/Link> : <span \/>\}/);
});

test("Support can attach an off-page item’s order without widening customer order scope", () => {
  const server = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const lookup = server.slice(server.indexOf("export async function getMyOrderItemForSupport"));
  assert.match(lookup, /requireVerifiedCustomer\(headers\)/);
  assert.match(lookup, /withOrganizationContext\(headers, organizationId, async \(tx, role\)/);
  assert.match(lookup, /eq\(customerOrder.organizationId, organizationId\)/);
  assert.match(lookup, /eq\(customerOrderItem.id, itemId\)/);
  assert.match(lookup, /eq\(customerOrder.checkoutState, "PAID"\)/);
  assert.match(lookup, /if \(role === "MEMBER"\) scope.push\(eq\(customerOrder.actorUserId, actor.userId\)\)/);
  assert.match(lookup, /where\(and\(\.\.\.scope\)\).limit\(1\)/);
  assert.doesNotMatch(lookup, /supplier|sourceCost|articleText|writingBrief/);
  const support = readFileSync(new URL("../src/app/customer/support/page.tsx", import.meta.url), "utf8");
  assert.match(support, /const itemId = firstQueryValue\(params\.itemId\)/);
  assert.match(support, /getMyOrderItemForSupport\(requestHeaders, organizationId, itemId\)/);
  assert.match(support, /if \(selectedItem && !orderOptions\.some\(\(order\) => order\.id === selectedItem\.orderId\)\)/);
  assert.match(support, /label: `Order #\$\{selectedItem\.orderId\.slice\(0, 8\)\.toUpperCase\(\)\} · includes selected placement`/);
  assert.match(support, /getMyOrderForSupport\(requestHeaders, organizationId, orderId\)/);
  assert.match(support, /if \(selectedOrder && !orderOptions\.some/);
  assert.match(support, /const selectedOrderId = unavailableAssociation \? "" : requestedOrderId/);
  assert.match(support, /unavailableAssociation \? <p[\s\S]*: <form action=\{openSupportAction\}/);
});

test("content-change eligibility is projected only for the orderer", () => {
  const order = { ...orderWithStatuses("PREPARING"), actorUserId: "orderer" };
  order.items[0].canRequestContentChange = true;
  assert.equal(customerOrderProjection(order, "orderer").items[0].canRequestContentChange, true);
  assert.equal(customerOrderProjection(order, "owner").items[0].canRequestContentChange, false);
});
