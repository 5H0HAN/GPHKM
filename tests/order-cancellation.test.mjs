import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculatePreHandoffRefund, cancellationCustomerMessage } from "../src/modules/orders/cancellation.ts";

test("pre-handoff cancellation refunds placement and only undelivered writing stages", () => {
  const item = { placementPriceMinor: "12000", writingSelected: true, writingFirstStageMinor: "3000", writingFinalStageMinor: "2000" };
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "WAITING_FOR_FIRST_DRAFT" }), "17000");
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "FIRST_DRAFT_READY" }), "14000");
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "REVISION_REQUESTED" }), "14000");
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "FINAL_DRAFT_READY" }), "12000");
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "CUSTOMER_DECLINED_FINAL" }), "12000");
  assert.equal(calculatePreHandoffRefund({ ...item, writingState: "APPROVED_FIRST" }), "12000");
  assert.equal(calculatePreHandoffRefund({ placementPriceMinor: "12000", writingSelected: false, writingFirstStageMinor: "0", writingFinalStageMinor: "0" }), "12000");
});

test("refund calculation rejects missing writing state and malformed money", () => {
  assert.throws(() => calculatePreHandoffRefund({ placementPriceMinor: "12000", writingSelected: true, writingFirstStageMinor: "3000", writingFinalStageMinor: "2000" }));
  assert.throws(() => calculatePreHandoffRefund({ placementPriceMinor: "12.00", writingSelected: false, writingFirstStageMinor: "0", writingFinalStageMinor: "0" }));
  assert.throws(() => calculatePreHandoffRefund({ placementPriceMinor: "0", writingSelected: false, writingFirstStageMinor: "0", writingFinalStageMinor: "0" }));
});

test("customer cancellation message exposes only GPHKM review and wallet outcomes", () => {
  assert.match(cancellationCustomerMessage("REQUESTED"), /under review/);
  assert.match(cancellationCustomerMessage("APPROVED"), /organization wallet/);
  assert.throws(() => cancellationCustomerMessage("SUPPLIER_SOURCED"));
});

test("database boundary locks the item, enforces handoff cutoffs, and posts a ledger credit atomically", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0017_order_item_cancellation.sql", import.meta.url), "utf8");
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /handed_off_at IS NOT NULL/);
  assert.match(migration, /work_started_at IS NOT NULL/);
  assert.match(migration, /'SENDING','UNKNOWN','ACCEPTED','DELIVERED','DELIVERY_ISSUE','MANUAL_SENT'/);
  assert.match(migration, /'ITEM_CANCELLATION_REFUND'/);
  assert.match(migration, /'CANCELED_REFUNDED'/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON order_item_cancellation_request FROM gphkm_runtime/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_decide_order_item_cancellation/);
  assert.match(migration, /public\.gphkm_staff_can_read_order_item/);
});

test("staff cancellation review queue is paginated under the refund approval role", async () => {
  const service = await readFile(new URL("../src/server/orders/cancellation.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/support/cancellations.tsx", import.meta.url), "utf8");
  const action = await readFile(new URL("../src/app/staff/(console)/support/cancellation-actions.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0101_cancellation_queue_index.sql", import.meta.url), "utf8");
  assert.match(service, /requireStaffAccess\(headers, "refund\.pre-handoff\.approve"\)/);
  assert.match(service, /staffCatalogPagination\(requestedPage, count\?\.total \?\? 0\)/);
  assert.match(service, /orderBy\(orderItemCancellationRequest\.requestedAt, orderItemCancellationRequest\.id\)/);
  assert.match(page, /Cancellation request pages/);
  assert.match(action, /cancellationPage/);
  assert.match(migration, /order_item_cancellation_queue_idx/);
});
