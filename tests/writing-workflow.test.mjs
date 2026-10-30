import assert from "node:assert/strict";
import test from "node:test";
import { nextWritingState, validateWritingText } from "../src/modules/orders/writing.ts";

test("writing service supports first-draft approval and exactly one revision", () => {
  assert.equal(nextWritingState("WAITING_FOR_FIRST_DRAFT", "FIRST_DRAFT"), "FIRST_DRAFT_READY");
  assert.equal(nextWritingState("FIRST_DRAFT_READY", "APPROVE"), "APPROVED_FIRST");
  assert.equal(nextWritingState("FIRST_DRAFT_READY", "REQUEST_REVISION"), "REVISION_REQUESTED");
  assert.equal(nextWritingState("REVISION_REQUESTED", "FINAL_DRAFT"), "FINAL_DRAFT_READY");
  assert.equal(nextWritingState("FINAL_DRAFT_READY", "APPROVE"), "APPROVED_FINAL");
  assert.equal(nextWritingState("FINAL_DRAFT_READY", "DECLINE_FINAL"), "CUSTOMER_DECLINED_FINAL");
  assert.throws(() => nextWritingState("REVISION_REQUESTED", "REQUEST_REVISION"), /unavailable/);
  assert.throws(() => nextWritingState("FINAL_DRAFT_READY", "REQUEST_REVISION"), /unavailable/);
  assert.throws(() => nextWritingState("APPROVED_FINAL", "FINAL_DRAFT"), /unavailable/);
  assert.throws(() => nextWritingState("FIRST_DRAFT_READY", "DECLINE_FINAL"), /unavailable/);
  assert.throws(() => nextWritingState("CUSTOMER_DECLINED_FINAL", "DECLINE_FINAL"), /unavailable/);
});

test("final-writing decline is a DB-atomic item wallet credit and requires a live pre-handoff writing review", async () => {
  const migration = await (await import("node:fs/promises")).readFile(new URL("../src/db/migrations/0130_nebulous_inhumans.sql", import.meta.url), "utf8");
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('gphkm:wallet-risk:' \|\| org_id/);
  assert.match(migration, /o\.actor_user_id = actor_id/);
  assert.match(migration, /writing_row\.state <> 'FINAL_DRAFT_READY'/);
  assert.match(migration, /fulfillment_row\.state <> 'AWAITING_CUSTOMER_APPROVAL'/);
  assert.match(migration, /'WRITING_STAGE_REFUND', 'writing-decline-final:'/);
  assert.match(migration, /writing_refund_ledger_entry_id = ledger_id/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_decline_order_item_writing\(text\) TO gphkm_runtime/);
});

test("writing text is bounded and rejects unsafe controls while allowing prose", () => {
  assert.equal(validateWritingText("  first line\nsecond line  ", 200), "first line\nsecond line");
  assert.throws(() => validateWritingText("\u0007bad", 200), /invalid/);
  assert.throws(() => validateWritingText("x".repeat(201), 200), /invalid/);
  assert.throws(() => validateWritingText("  ", 200), /invalid/);
});
