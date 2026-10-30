import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { correlateResendAttempt } from "../src/modules/fulfillment/resend-correlation.ts";
import { monotonicProviderAttemptState } from "../src/modules/fulfillment/workflow.ts";

const attemptId = "a3d8f8f0-0673-4f43-a439-8d5d9652b51b";
const emailId = "resend-email-01";
const attempt = { id: attemptId, provider: "RESEND", type: "SEND", providerReference: null };

test("signed Resend attempt tags correlate events before the POST response stores the email ID", () => {
  assert.deepEqual(correlateResendAttempt({ emailId, taggedAttemptId: attemptId, taggedAttempt: attempt }), {
    attemptId, conflict: false,
  });
  assert.deepEqual(correlateResendAttempt({ emailId, referenceAttempt: { ...attempt, providerReference: emailId } }), {
    attemptId, conflict: false,
  });
  assert.deepEqual(correlateResendAttempt({ emailId }), { attemptId: null, conflict: false });
});

test("tag, attempt, and provider-reference conflicts fail closed", () => {
  const other = { ...attempt, id: "b3d8f8f0-0673-4f43-a439-8d5d9652b51b", providerReference: emailId };
  assert.deepEqual(correlateResendAttempt({ emailId, taggedAttemptId: attemptId, taggedAttempt: attempt, referenceAttempt: other }), {
    attemptId: null, conflict: true,
  });
  assert.deepEqual(correlateResendAttempt({ emailId, taggedAttemptId: attemptId, taggedAttempt: { ...attempt, providerReference: "other-email" } }), {
    attemptId: null, conflict: true,
  });
  assert.deepEqual(correlateResendAttempt({ emailId, taggedAttemptId: "malformed", taggedAttempt: null }), {
    attemptId: null, conflict: true,
  });
});

test("late provider/API responses cannot downgrade packet delivery state", () => {
  assert.equal(monotonicProviderAttemptState("DELIVERED", "ACCEPTED"), "DELIVERED");
  assert.equal(monotonicProviderAttemptState("DELIVERED", "UNKNOWN"), "DELIVERED");
  assert.equal(monotonicProviderAttemptState("DELIVERY_ISSUE", "ACCEPTED"), "DELIVERY_ISSUE");
  assert.equal(monotonicProviderAttemptState("ACCEPTED", "UNKNOWN"), "ACCEPTED");
  assert.equal(monotonicProviderAttemptState("DELIVERY_ISSUE", "DELIVERED"), "DELIVERED");
  assert.equal(monotonicProviderAttemptState("SENDING", "DELIVERED"), "DELIVERED");
});

test("send tags, signed webhook routing, persistence, and runtime RLS stay connected", () => {
  const packetServer = readFileSync(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  const webhookRoute = readFileSync(new URL("../src/app/api/webhooks/resend/route.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../src/db/migrations/0111_resend_packet_webhook_correlation.sql", import.meta.url), "utf8");
  assert.match(packetServer, /name: "gphkm_packet_attempt", value: attemptId/);
  assert.match(webhookRoute, /taggedAttemptId:/);
  assert.match(packetServer, /providerEmailId: input\.emailId/);
  assert.match(packetServer, /set_config\('app\.resend_webhook_event_id'/);
  assert.match(packetServer, /set_config\('app\.resend_webhook_attempt_id'/);
  assert.match(migration, /supplier_packet_provider_event_webhook_read/);
  assert.match(migration, /provider_event_id = nullif\(current_setting\('app\.resend_webhook_event_id'/);
  assert.match(migration, /provider_reference = nullif\(current_setting\('app\.resend_webhook_email_id'/);
  assert.match(migration, /supplier_packet_attempt_provider_reference_uq/);
});
