import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

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

test("supplier email send is disabled when the provider is not configured", () => {
  const page = source("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx");
  assert.match(page, /const resendReady = resendEnvConfigured\(\)/);
  assert.match(page, /disabled=\{!resendReady\}/);
});

test("content-change request and sharing-consent forms are orderer-only in the UI", () => {
  const page = source("../src/app/customer/orders/page.tsx");
  const form = source("../src/app/customer/orders/content-change-form.tsx");
  assert.match(page, /canAct=\{order\.isOrderer\}/);
  assert.match(form, /props\.canRequest && props\.canAct/);
  assert.match(form, /props\.canAct \? <form action=\{consentToContentChangeAction\}/);
});
