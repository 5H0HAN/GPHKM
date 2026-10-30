import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("notification inbox is recipient and organization scoped with read-only state changes", async () => {
  const sql = await readFile(new URL("../src/db/migrations/0021_customer_notifications.sql", import.meta.url), "utf8");
  assert.match(sql, /recipient_user_id = nullif\(current_setting\('app\.user_id', true\), ''\)/);
  assert.match(sql, /organization_id = nullif\(current_setting\('app\.organization_id', true\), ''\)/);
  assert.match(sql, /GRANT SELECT, UPDATE\(read_at\) ON customer_notification TO gphkm_runtime/);
  assert.match(sql, /REVOKE ALL ON customer_notification_email_outbox FROM PUBLIC, gphkm_runtime/);
  assert.match(sql, /source_key text NOT NULL UNIQUE/);
});

test("order and support triggers emit generic messages without customer content or private case detail", async () => {
  const sql = await readFile(new URL("../src/db/migrations/0021_customer_notifications.sql", import.meta.url), "utf8");
  assert.match(sql, /customer_order_notification_after_status/);
  assert.match(sql, /customer_support_notification_after_event/);
  assert.match(sql, /customer_writing_action_notification_after_state/);
  assert.match(sql, /customer_content_change_action_notification/);
  assert.match(sql, /customer_cancellation_action_notification/);
  assert.match(sql, /GPHKM sent an update to your Support request/);
  assert.match(sql, /GPHKM is reviewing your Support request/);
  assert.doesNotMatch(sql, /NEW\.body/);
  assert.doesNotMatch(sql, /NEW\.body|FINANCE_DECISION|payment payload/i);
});

test("customer notification reads use explicit projections and only update readAt", async () => {
  const service = await readFile(new URL("../src/server/notifications/customer.ts", import.meta.url), "utf8");
  assert.match(service, /withOrganizationContext/);
  assert.match(service, /eq\(customerNotification\.recipientUserId, actor\.userId\)/);
  assert.match(service, /set\(\{ readAt: new Date\(\) \}\)/);
  assert.doesNotMatch(service, /supplier|articleText|writingBrief|payment/i);
});

test("customer notification inbox paginates under organization and recipient RLS", async () => {
  const service = await readFile(new URL("../src/server/notifications/customer.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/customer/notifications/page.tsx", import.meta.url), "utf8");
  const action = await readFile(new URL("../src/app/customer/notifications/actions.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0100_customer_notification_inbox_index.sql", import.meta.url), "utf8");
  assert.match(service, /withOrganizationContext/);
  assert.match(service, /staffCatalogPagination\(requestedPage, total\?\.count \?\? 0\)/);
  assert.match(service, /orderBy\(desc\(customerNotification\.createdAt\), desc\(customerNotification\.id\)\)/);
  assert.match(page, /Notification pages/);
  assert.match(page, /name="page" value=\{result\.pagination\.page\}/);
  assert.match(action, /page=\$\{page\}/);
  assert.match(migration, /customer_notification_inbox_idx[\s\S]*created_at, id/);
});
