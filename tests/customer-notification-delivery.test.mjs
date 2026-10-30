import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("notification worker is isolated, leased, idempotent, and avoids blind retries", async () => {
  const [migration, worker] = await Promise.all([
    read("../src/db/migrations/0025_customer_notification_delivery.sql"),
    read("../scripts/customer-notification-worker.ts"),
  ]);
  assert.match(migration, /session_user <> 'gphkm_worker'/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /status = 'UNKNOWN'.*LEASE_EXPIRED_REVIEW/s);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.gphkm_claim_customer_notification_emails[\s\S]*TO gphkm_worker/);
  assert.match(migration, /FROM PUBLIC, gphkm_runtime/);
  assert.match(worker, /Idempotency-Key/);
  assert.match(worker, /gphkm-customer-\$\{job\.outbox_id\}/);
  assert.match(worker, /NETWORK_OUTCOME_UNKNOWN/);
  assert.match(worker, /IDEMPOTENCY_WINDOW_REVIEW/);
  assert.match(worker, /EMAIL_PREFERENCE_DISABLED/);
  assert.match(worker, /RECIPIENT_UNVERIFIED/);
});

test("email preference is per-user and reconciliation is Super Admin audited", async () => {
  const [migration, deliveryMigration, schema, source] = await Promise.all([
    read("../src/db/migrations/0026_customer_notification_reconciliation.sql"),
    read("../src/db/migrations/0025_customer_notification_delivery.sql"),
    read("../src/db/notification-schema.ts"),
    read("../src/server/notifications/customer.ts"),
  ]);
  assert.match(deliveryMigration, /customer_notification_preference_self_read/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'SUPER_ADMIN'\)/);
  assert.match(migration, /CUSTOMER_NOTIFICATION_EMAIL_RECONCILED/);
  assert.match(migration, /append_only/);
  assert.match(schema, /transactionalEmailEnabled: boolean/);
  assert.match(source, /onConflictDoUpdate/);
});

test("Resend webhook events are signature-gated, tagged, deduplicated, and ordered by provider time", async () => {
  const [migration, route, worker] = await Promise.all([
    read("../src/db/migrations/0028_rich_justice.sql"),
    read("../src/app/api/webhooks/resend/route.ts"),
    read("../scripts/customer-notification-worker.ts"),
  ]);
  assert.match(migration, /app\.resend_webhook_verified/);
  assert.match(migration, /ON CONFLICT \(provider_event_id\) DO NOTHING/);
  assert.match(migration, /event_created_at DESC/);
  assert.match(route, /verifyResendWebhook/);
  assert.match(route, /gphkm_outbox/);
  assert.match(worker, /name: "gphkm_outbox"/);
});
