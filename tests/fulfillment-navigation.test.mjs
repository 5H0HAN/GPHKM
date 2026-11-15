import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fulfillmentItemRedirectTarget,
  fulfillmentQueueRedirectTarget,
  isFulfillmentItemId,
  isSafeStaffNavigationTarget,
} from "../src/app/staff/(console)/fulfillment/navigation.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("fulfillment redirect helpers allow only valid item IDs and bounded queue context", () => {
  const itemId = "5e68039f-bb28-47e3-989d-4e7728456652";
  assert.equal(isFulfillmentItemId(itemId), true);
  assert.equal(fulfillmentItemRedirectTarget(itemId, "updated"), `/staff/fulfillment/${itemId}?updated=1`);
  assert.equal(fulfillmentItemRedirectTarget(itemId, "follow-up-updated"), `/staff/fulfillment/${itemId}?followUpUpdated=1`);
  assert.equal(fulfillmentItemRedirectTarget(itemId, "packet-required"), `/staff/fulfillment/${itemId}?error=packet-required`);

  for (const malformed of ["..", ".", "../../staff", "https://evil.test", "", "not-a-uuid"]) {
    assert.equal(isFulfillmentItemId(malformed), false);
    assert.equal(fulfillmentItemRedirectTarget(malformed, "updated"), "/staff/fulfillment?invalid-item=1");
  }

  assert.equal(fulfillmentQueueRedirectTarget("3", "all", "updated"), "/staff/fulfillment?page=3&view=all&updated=1");
  for (const malformedPage of ["0", "-1", "1&view=all", "99999999999999999", ["2"]]) {
    assert.equal(fulfillmentQueueRedirectTarget(malformedPage, "active", "updated"), "/staff/fulfillment?updated=1");
  }
  assert.equal(fulfillmentQueueRedirectTarget("2", "all&admin=true", "assignment-failed"), "/staff/fulfillment?page=2&assignment-failed=1");
});

test("redirecting form accepts only canonical same-origin staff navigation targets", () => {
  for (const target of ["/staff/fulfillment", "/staff/fulfillment?page=2&view=all", "/staff/fulfillment/5e68039f-bb28-47e3-989d-4e7728456652?updated=1"]) {
    assert.equal(isSafeStaffNavigationTarget(target), true);
  }
  for (const target of [
    "//attacker.test/staff/fulfillment",
    "https://attacker.test/staff/fulfillment",
    "javascript:alert(1)",
    "/staff\\@attacker.test/fulfillment",
    "/staff/../admin",
    "/staff/%2e%2e/admin",
    "/staff/\u0000fulfillment",
    "staff/fulfillment",
    null,
  ]) {
    assert.equal(isSafeStaffNavigationTarget(target), false);
  }
});

test("supplier packet action is only offered when fulfillment has a supplier", () => {
  const page = source("../src/app/staff/(console)/fulfillment/page.tsx");
  const query = source("../src/server/fulfillment/admin.ts");
  assert.match(page, /row\.state === "READY_FOR_HANDOFF" && row\.fulfillmentSupplierId/);
  assert.match(query, /fulfillmentSupplierId: orderItemFulfillmentSupplier\.supplierId/);
});

test("bulk packet preparation keeps links to every created packet", () => {
  const action = source("../src/app/staff/(console)/fulfillment/packets/actions.ts");
  const page = source("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx");
  assert.match(action, /preparedIds=\$\{preparedIds\}/);
  assert.match(page, /Packets prepared for this order/);
  assert.match(page, /preparedPacketIds\.map/);
});

test("unexpected packet candidate load failures show a safe retry state instead of a false 404", () => {
  const page = source("../src/app/staff/(console)/fulfillment/packets/new/page.tsx");
  assert.match(page, /\["Forbidden", "Order unavailable"\]\.includes\(error\.message\)/);
  assert.doesNotMatch(page, /\["Unauthorized", "Forbidden", "Order unavailable"\]\.includes\(error\.message\)/);
  assert.match(page, /logSafeFailure\("supplier_packet_candidates_load_failed", error, requestId\)/);
  assert.match(page, /role="alert">No packet was prepared or sent\./);
  assert.match(page, /Retry/);
});

test("packet preparation failures are logged without exposing database errors in the UI", () => {
  const action = source("../src/app/staff/(console)/fulfillment/packets/actions.ts");
  assert.match(action, /logSafeFailure\("supplier_packet_prepare_failed", error, randomUUID\(\), \{ orderId \}\)/);
  assert.match(action, /&error=prepare/);
  assert.doesNotMatch(action, /console\.(?:error|log)\(error/);
});

test("packet readiness names missing checkout sharing consent before suggesting a state transition", () => {
  const packetService = source("../src/server/fulfillment/packets.ts");
  assert.match(packetService, /!row\.consent \? "Customer sharing consent is not recorded for this order\."/);
});

test("supplier email send is disabled when the provider is not configured", () => {
  const page = source("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx");
  assert.match(page, /const resendReady = resendEnvConfigured\(\)/);
  assert.match(page, /disabled=\{!resendReady\}/);
});

test("changed supplier recipients keep frozen packets available as read-only history", () => {
  const service = source("../src/server/fulfillment/packets.ts");
  const page = source("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx");
  assert.match(service, /contact\.email\.trim\(\)\.toLowerCase\(\) !== row\.recipient\.trim\(\)\.toLowerCase\(\)[\s\S]*?throw new StaleSupplierPacketSnapshotError/);
  assert.match(service, /error instanceof StaleSupplierPacketSnapshotError/);
  assert.match(page, /data\.staleSnapshot/);
  assert.match(page, /Historical supplier packet/);
  assert.match(page, /current order, customer approval, or supplier route no longer matches this packet/);
  assert.match(page, /cannot be sent or exported again/);
  assert.match(page, /latest\.reconciled === "1"[\s\S]*role="status"/);
  assert.doesNotMatch(page, /data\.staleRoute/);
});

test("content-change request and sharing-consent forms are orderer-only in the UI", () => {
  const page = source("../src/app/customer/orders/orders-view.tsx");
  const form = source("../src/app/customer/orders/content-change-form.tsx");
  assert.match(page, /canAct=\{order\.isOrderer\}/);
  assert.match(form, /props\.canRequest && props\.canAct/);
  assert.match(form, /props\.canAct \? <form action=\{consentToContentChangeAction\}/);
});
