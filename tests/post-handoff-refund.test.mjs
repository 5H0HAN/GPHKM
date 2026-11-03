import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePostHandoffRefundDecision, validatePostHandoffRefundRequest } from "../src/modules/support/post-handoff-refunds.ts";

const migration = await readFile(new URL("../src/db/migrations/0163_order_scoped_support.sql", import.meta.url), "utf8");
const ambiguityFix = await readFile(new URL("../src/db/migrations/0165_fix_plpgsql_output_column_ambiguity.sql", import.meta.url), "utf8");
const refundBaseMigration = await readFile(new URL("../src/db/migrations/0020_post_handoff_refunds.sql", import.meta.url), "utf8");
const service = await readFile(new URL("../src/server/support/post-handoff-refunds.ts", import.meta.url), "utf8");

test("post-handoff request and decision values are exact and bounded", () => {
  const caseId = "11111111-1111-4111-8111-111111111111";
  const orderItemId = "33333333-3333-4333-8333-333333333333";
  const idempotencyKey = "22222222-2222-4222-8222-222222222222";
  assert.equal(validatePostHandoffRefundRequest({ caseId, orderItemId, idempotencyKey, amountMinor: "12500", reason: "Supplier could not fulfill" }).amountMinor, "12500");
  assert.throws(() => validatePostHandoffRefundRequest({ caseId, orderItemId, idempotencyKey, amountMinor: "12.50", reason: "Supplier could not fulfill" }));
  assert.throws(() => validatePostHandoffRefundRequest({ caseId, orderItemId, idempotencyKey, amountMinor: "-1", reason: "Supplier could not fulfill" }));
  assert.throws(() => validatePostHandoffRefundRequest({ caseId, orderItemId: "not-an-item", idempotencyKey, amountMinor: "12500", reason: "Supplier could not fulfill" }));
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
  assert.match(migration, /target_order_item_id text, target_idempotency_key text/);
  assert.match(migration, /customer_order_item WHERE id = target_order_item_id AND order_id = case_row\.order_id/);
  assert.match(migration, /merged_into_case_id FROM public\.support_case WHERE id = request_row\.case_id/);
  assert.match(refundBaseMigration, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON post_handoff_refund_request FROM gphkm_runtime/);
  assert.match(service, /staffTx\(headers, "refund\.exception\.approve"/);
  assert.match(service, /staffTx\(headers, "fulfillment\.manage"/);
});

test("refund and cancellation SQL qualifies fields that shadow RETURNS TABLE outputs", () => {
  const decision = ambiguityFix.split("CREATE OR REPLACE FUNCTION public.gphkm_decide_order_item_cancellation")[1].split("$$;")[0];
  const request = ambiguityFix.split("CREATE OR REPLACE FUNCTION public.gphkm_request_post_handoff_refund")[1].split("$$;")[0];
  const refundDecision = ambiguityFix.split("CREATE OR REPLACE FUNCTION public.gphkm_decide_post_handoff_refund")[1].split("$$;")[0];
  assert.match(decision, /fulfillment\.order_item_id = request_row\.order_item_id/);
  assert.match(decision, /writing\.order_item_id = item_row\.id/);
  assert.doesNotMatch(decision, /WHERE\s+order_item_id\s*=/);
  assert.match(request, /existing_request\.organization_id = case_row\.organization_id/);
  assert.match(request, /wallet\.organization_id = case_row\.organization_id/);
  assert.match(request, /ledger\.organization_id = case_row\.organization_id/);
  assert.match(refundDecision, /fulfillment\.order_item_id = request_row\.order_item_id/);
  assert.match(refundDecision, /wallet\.organization_id = request_row\.organization_id/);
  assert.match(refundDecision, /ledger\.organization_id = request_row\.organization_id/);
  assert.doesNotMatch(refundDecision, /WHERE\s+(?:order_item_id|organization_id)\s*=/);
});
