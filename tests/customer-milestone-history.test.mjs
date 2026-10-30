import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../src/db/migrations/0096_customer_order_milestone_history.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/db/order-schema.ts", import.meta.url), "utf8");

test("milestone history stores only customer-safe status and next-update facts from database triggers", () => {
  assert.match(migration, /AFTER INSERT OR UPDATE ON public\.order_item_fulfillment/);
  assert.match(migration, /OLD\.customer_status IS NOT DISTINCT FROM NEW\.customer_status[\s\S]*OLD\.next_update_at IS NOT DISTINCT FROM NEW\.next_update_at/);
  assert.match(migration, /INSERT INTO public\.customer_order_item_milestone \(id, order_item_id, status, next_update_at, occurred_at\)/);
  assert.doesNotMatch(migration, /supplier_id|staff_note|internal_state|packet_id|article_text/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.customer_order_item_milestone/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.customer_order_item_milestone FROM gphkm_runtime/);
  assert.match(migration, /gphkm_customer_can_read_order_item/);
  assert.match(migration, /gphkm_staff_can_read_order_item/);
  assert.match(schema, /customer_order_item_milestone_status_valid/);
});

test("customer order reads select only scoped milestone fields and expose an allowlisted timeline", () => {
  assert.match(server, /customerOrderItemMilestone\.status/);
  assert.match(server, /customerOrderItemMilestone\.nextUpdateAt/);
  assert.match(server, /customerOrderItemMilestone\.occurredAt/);
  assert.match(server, /where\(inArray\(customerOrderItemMilestone\.orderItemId, itemIds\)\)/);
  const projection = readFileSync(new URL("../src/modules/orders/checkout.ts", import.meta.url), "utf8");
  assert.match(projection, /milestoneHistory: \(item\.milestoneHistory \?\? \[\]\)\.map/);
  assert.match(projection, /status: milestone\.status,[\s\S]*nextUpdateAt: milestone\.nextUpdateAt,[\s\S]*occurredAt: milestone\.occurredAt/);
  assert.doesNotMatch(projection.slice(projection.indexOf("milestoneHistory:")), /supplierId|internalState|staffNote/);
});
