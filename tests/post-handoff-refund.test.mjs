import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePostHandoffRefundDecision, validatePostHandoffRefundRequest } from "../src/modules/support/post-handoff-refunds.ts";

const migration = await readFile(new URL("../src/db/migrations/0020_post_handoff_refunds.sql", import.meta.url), "utf8");
const service = await readFile(new URL("../src/server/support/post-handoff-refunds.ts", import.meta.url), "utf8");

test("post-handoff request and decision values are exact and bounded", () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const idempotencyKey = "22222222-2222-4222-8222-222222222222";
  assert.equal(validatePostHandoffRefundRequest({ caseId, idempotencyKey, amountMinor: "12500", reason: "Supplier could not fulfill" }).amountMinor, "12500");
  assert.throws(() => validatePostHandoffRefundRequest({ caseId, idempotencyKey, amountMinor: "12.50", reason: "Supplier could not fulfill" }));
  assert.throws(() => validatePostHandoffRefundRequest({ caseId, idempotencyKey, amountMinor: "-1", reason: "Supplier could not fulfill" }));
  assert.throws(() => validatePostHandoffRefundDecision({ requestId: caseId, decision: "APPROVED", amountMinor: "0", idempotencyKey, reason: "Approve" }));
  assert.throws(() => validatePostHandoffRefundDecision({ requestId: caseId, decision: "DENIED", amountMinor: "1", idempotencyKey, reason: "Deny" }));
  assert.equal(validatePostHandoffRefundDecision({ requestId: caseId, decision: "DENIED", amountMinor: "0", idempotencyKey, reason: "Deny this exception" }).amountMinor, "0");
});

test("database path requires Finance Review, post-cutoff state, and Finance/Super Admin", () => {
  assert.match(migration, /case_row\.state <> 'FINANCE_REVIEW'/);
  assert.match(migration, /fulfillment_row\.handed_off_at IS NULL AND fulfillment_row\.work_started_at IS NULL/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'FINANCE'\).*gphkm_is_active_staff\(actor_id, 'SUPER_ADMIN'\)/s);
  assert.match(migration, /target_amount > request_row\.requested_amount_minor OR target_amount > captured - refunded/);
  assert.match(migration, /'POST_HANDOFF_CASE_REFUND'/);
  assert.match(migration, /POST_HANDOFF_REFUND_DECIDED/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON post_handoff_refund_request FROM gphkm_runtime/);
  assert.match(service, /staffTx\(headers, "refund\.exception\.approve"/);
  assert.match(service, /staffTx\(headers, "fulfillment\.manage"/);
});
