import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("both staff order helper assignment branches require a current active Admin", () => {
  const sql = readFileSync(new URL("../src/db/migrations/0016_active_staff_order_access.sql", import.meta.url), "utf8");
  for (const helper of ["gphkm_staff_can_read_order_item", "gphkm_staff_can_read_order"]) {
    const start = sql.indexOf(`FUNCTION public.${helper}(`);
    const definition = sql.slice(start, sql.indexOf("$$;", start));
    assert.match(definition, /public\.gphkm_is_active_staff\(target_user_id, 'SUPER_ADMIN'\) OR \(\s*public\.gphkm_is_active_staff\(target_user_id, 'ADMIN'\) AND EXISTS/);
    assert.match(definition, /f\.assigned_admin_id = target_user_id/);
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.gphkm_staff_can_read_order_item\(text,text\) FROM PUBLIC/);
});

test("customer order queries explicitly scope Members before fetching items, independent of staff RLS", () => {
  const source = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const query = source.slice(source.indexOf("export async function getMyOrders"));
  assert.match(query, /const actor = await requireVerifiedCustomer\(headers\)/);
  assert.match(query, /withOrganizationContext\(headers, organizationId, async \(tx, role\)/);
  assert.match(query, /const scope = \[eq\(customerOrder\.organizationId, organizationId\)\]/);
  assert.match(query, /if \(role === "MEMBER"\) scope\.push\(eq\(customerOrder\.actorUserId, actor\.userId\)\)/);
  assert.match(query, /from\(customerOrder\)\s*\.where\(and\(\.\.\.scope\)\)/);
  assert.match(query, /inArray\(customerOrderItem\.orderId, ids\)/);
});
