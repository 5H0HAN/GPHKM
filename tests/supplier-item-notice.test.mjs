import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSupplierNotice, renderSupplierNoticeEml } from "../src/modules/fulfillment/supplier-notice.ts";

const schemaMigration = await readFile(new URL("../src/db/migrations/0109_supplier_item_notices.sql", import.meta.url), "utf8");
const securityMigration = await readFile(new URL("../src/db/migrations/0110_supplier_item_notice_security.sql", import.meta.url), "utf8");
const manualOutcomeMigration = await readFile(new URL("../src/db/migrations/0113_supplier_notice_manual_outcome_evidence.sql", import.meta.url), "utf8");
const scopedSecurityMigration = await readFile(new URL("../src/db/migrations/0163_order_scoped_support.sql", import.meta.url), "utf8");
const service = await readFile(new URL("../src/server/fulfillment/supplier-notices.ts", import.meta.url), "utf8");

test("supplier notices state the requested action without claiming it happened", () => {
  const notice = buildSupplierNotice("WITHDRAWAL", "GPH-1234-5678", "Customer received a cancellation review");
  assert.match(notice.subject, /stop\/withdraw/);
  assert.match(notice.body, /does not mean the work has stopped/);
  assert.throws(() => buildSupplierNotice("WITHDRAWAL", "ref", "bad\r\nBcc: attacker@example.test"));
  assert.throws(() => buildSupplierNotice("CORRECTION", "ref", "no"));
});

test("EML header values cannot inject headers and body is transport encoded", () => {
  const eml = renderSupplierNoticeEml({ recipient: "supplier@example.test\r\nBcc: bad@example.test", subject: "Correct\nBcc: bad@example.test", body: "Body" });
  assert.match(eml, /^To: supplier@example\.test\s+Bcc: bad@example\.test\r\nSubject: Correct Bcc: bad@example\.test\r\n/);
  assert.match(eml, /Content-Transfer-Encoding: base64/);
  assert.doesNotMatch(eml, /\r\nBcc:/);
});

test("database and service keep notice snapshots tied to assigned handed-off items and append-only results", () => {
  assert.match(schemaMigration, /FOREIGN KEY|REFERENCES public\.support_case/);
  assert.match(securityMigration, /f\.handed_off_at IS NOT NULL/);
  assert.match(securityMigration, /gphkm_supplier_packet_access/);
  assert.match(securityMigration, /supplier notice snapshots and events are append-only/);
  assert.match(securityMigration, /OLD\.state IN \('ACCEPTED','MANUAL_SENT'\) AND NEW\.state IN \('SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM'\)/);
  assert.match(service, /appendAuditEvent/);
  assert.match(service, /recordManualSupplierItemNotice/);
  assert.match(service, /actualRecipient !== notice\.recipient/);
  assert.match(schemaMigration, /state IN \('MANUAL_SENT','SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM'\)/);
  assert.doesNotMatch(service, /update\(orderItemFulfillment\)/);
  assert.match(service, /UNKNOWN/);
  assert.match(service, /postHandoffRefundRequest\.state, "APPROVED"/);
});

test("notice preparation requires proof for the current supplier route, while existing records remain reconcilable", () => {
  const insertGuard = scopedSecurityMigration.split("CREATE OR REPLACE FUNCTION public.gphkm_supplier_notice_insert_guard")[1].split("$$;")[0];
  assert.match(insertGuard, /FOR UPDATE[\s\S]*FOR KEY SHARE/);
  assert.match(insertGuard, /route_supplier_id[\s\S]*route_generation_value/);
  assert.match(insertGuard, /attempt\.type = 'SEND' AND attempt\.state = 'DELIVERED' AND attempt\.delivered_at IS NOT NULL/);
  assert.match(insertGuard, /attempt\.type IN \('MANUAL_SENT','MANUAL_SEND'\) AND attempt\.state = 'MANUAL_SENT' AND attempt\.sent_at IS NOT NULL/);
  assert.doesNotMatch(insertGuard, /handed_off_at IS NOT NULL/,
    "a later route change must not hide an immutable notice that still needs reconciliation");
  assert.match(service, /eq\(supplierPacketItem\.routeGeneration, orderItemFulfillmentSupplier\.routeGeneration\)/);
  assert.match(service, /attempt\.state = 'DELIVERED'[\s\S]*attempt\.delivered_at is not null/);
  assert.match(service, /selectDistinctOn\(\[supplierItemNoticeAttempt\.noticeId\]/,
    "reconciliation loads latest attempts in a batch rather than issuing a query per notice");
  assert.match(service, /attempt\.packet_id = public\.supplier_packet\.id[\s\S]*attempt\.recipient\) = lower\(public\.supplier_packet\.recipient\)/,
    "notice preparation correlates delivery proof to the selected outer packet");
  assert.match(service, /refund\.case_id = public\.supplier_item_notice\.case_id[\s\S]*refund\.order_item_id = public\.supplier_item_notice\.order_item_id/,
    "refund reconciliation correlates each approved exception to its exact notice");
});

test("manual send evidence remains valid when its supplier outcome is reconciled", () => {
  assert.match(manualOutcomeMigration, /DROP CONSTRAINT IF EXISTS supplier_item_notice_attempt_check/);
  assert.match(manualOutcomeMigration, /DROP CONSTRAINT IF EXISTS supplier_item_notice_manual_sent_shape/);
  assert.match(manualOutcomeMigration, /SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM/);
  assert.match(manualOutcomeMigration, /manual_reference.*sent_at/s);
  assert.match(service, /state: input\.outcome,\s*providerReference/);
});
