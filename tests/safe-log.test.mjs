import test from "node:test";
import assert from "node:assert/strict";
import { safeCorrelationFields } from "../src/server/observability/safe-log.ts";

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
