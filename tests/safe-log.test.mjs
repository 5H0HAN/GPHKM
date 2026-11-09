import test from "node:test";
import assert from "node:assert/strict";
import { logSafeFailure, safeCorrelationFields } from "../src/server/observability/safe-log.ts";

test("safe logs retain only bounded identifiers and fixed correlation dimensions", () => {
  assert.deepEqual(safeCorrelationFields({
    actorId: "usr_123", organizationId: "org_123", paymentAttemptId: "pa_123", providerEventId: "evt_123",
    permission: "wallet.reconcile", reasonCode: "ROLE_PERMISSION_DENIED", customerEmail: "person@example.com",
    articleText: "private text", amount: "50.00", providerPayload: "secret", unknown: "hidden",
  }), {
    actorId: "usr_123", organizationId: "org_123", paymentAttemptId: "pa_123", providerEventId: "evt_123",
    permission: "wallet.reconcile", reasonCode: "ROLE_PERMISSION_DENIED",
  });
  assert.deepEqual(safeCorrelationFields({ actorId: "line\nbreak", organizationId: "x".repeat(129) }), {});
});

test("safe failure logs expose only a bounded database permission target", () => {
  const originalError = console.error;
  let message = "";
  console.error = (value) => { message = String(value); };
  try {
    logSafeFailure("packet_prepare_failed", Object.assign(new Error("permission denied for function public.gphkm_is_active_staff"), {
      code: "42501", detail: "private article text must not be logged",
    }), "request-123", { orderId: "order-123", customerEmail: "private@example.com" });
  } finally {
    console.error = originalError;
  }
  const logged = JSON.parse(message);
  assert.equal(logged.databaseObject, "function:public.gphkm_is_active_staff");
  assert.equal(logged.orderId, "order-123");
  assert.equal("customerEmail" in logged, false);
  assert.doesNotMatch(message, /private article|private@example\.com/);
});

test("safe failure logs expose only allowlisted packet guard reasons", () => {
  const originalError = console.error;
  let message = "";
  console.error = (value) => { message = String(value); };
  try {
    logSafeFailure("packet_prepare_failed", Object.assign(new Error("packet item does not match the order-time fulfillment snapshot"), {
      code: "23514", detail: "private article text must not be logged",
    }), "request-456");
  } finally {
    console.error = originalError;
  }
  const logged = JSON.parse(message);
  assert.equal(logged.databaseReason, "packet item does not match the order-time fulfillment snapshot");
  assert.doesNotMatch(message, /private article/);
});
