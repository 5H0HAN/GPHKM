import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSupplierNotice, renderSupplierNoticeEml } from "../src/modules/fulfillment/supplier-notice.ts";

const schemaMigration = await readFile(new URL("../src/db/migrations/0109_supplier_item_notices.sql", import.meta.url), "utf8");
const securityMigration = await readFile(new URL("../src/db/migrations/0110_supplier_item_notice_security.sql", import.meta.url), "utf8");
const manualOutcomeMigration = await readFile(new URL("../src/db/migrations/0113_supplier_notice_manual_outcome_evidence.sql", import.meta.url), "utf8");
const scopedSecurityMigration = await readFile(new URL("../src/db/migrations/0189_scope_supplier_notices_to_current_item.sql", import.meta.url), "utf8");
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
  const dispatch = scopedSecurityMigration.split("CREATE FUNCTION public.gphkm_supplier_notice_dispatch")[1].split("$$;")[0];
  const access = scopedSecurityMigration.split("CREATE OR REPLACE FUNCTION public.gphkm_supplier_item_notice_access")[1].split("$$;")[0];
  assert.match(dispatch, /f\.handed_off_at IS NOT NULL[\s\S]*f\.assigned_admin_id = actor_id[\s\S]*FOR UPDATE/);
  assert.match(dispatch, /pi\.route_generation = route\.route_generation[\s\S]*p\.supplier_id = route\.supplier_id/);
  assert.match(dispatch, /attempt\.state IN \('ACCEPTED', 'DELIVERY_ISSUE'\) AND attempt\.accepted_at IS NOT NULL/);
  assert.match(dispatch, /attempt\.type IN \('MANUAL_SENT', 'MANUAL_SEND'\) AND attempt\.state = 'MANUAL_SENT'/);
  assert.doesNotMatch(access, /handed_off_at|supplier_packet_access|route_generation/,
    "an assignment or route change does not hide a notice from the currently assigned Admin");
  assert.match(service, /gphkm_supplier_notice_dispatch/);
  assert.doesNotMatch(service, /select[\s\S]*from\(supplierPacket\)/);
  assert.match(service, /gphkm_lock_supplier_item_notice/);
  assert.match(service, /selectDistinctOn\(\[supplierItemNoticeAttempt\.noticeId\]/,
    "reconciliation loads latest attempts in a batch rather than issuing a query per notice");
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
