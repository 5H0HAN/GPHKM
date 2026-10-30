import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("staff live queue alerts use existing permission-checked queues and link to review pages", () => {
  const alerts = readFileSync(new URL("../src/server/observability/operations-alerts.ts", import.meta.url), "utf8");
  for (const permission of ["fulfillment.manage", "wallet.reconcile"]) assert.ok(alerts.includes(`hasStaffPermission(role, "${permission}")`));
  for (const source of ["listFulfillmentQueue", "listSupplierPacketReconciliation", "getStripeWalletReconciliation", "listOpenStripeAttempts", "getLatestFinanceReconciliation"]) assert.ok(alerts.includes(source));
  for (const href of ["/staff/fulfillment", "/staff/fulfillment/packets/reconciliation", "/staff/reconciliation"]) assert.ok(alerts.includes(href));
  assert.doesNotMatch(alerts, /articleText|writingBrief|supplierContact|customerEmail|paymentPayload/);
  const page = readFileSync(new URL("../src/app/staff/(console)/page.tsx", import.meta.url), "utf8");
  assert.match(page, /aria-label="Operations needing attention"/);
  assert.match(page, /Review queue/);
});
