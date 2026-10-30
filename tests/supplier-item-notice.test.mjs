import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildSupplierNotice, renderSupplierNoticeEml } from "../src/modules/fulfillment/supplier-notice.ts";

const schemaMigration = await readFile(new URL("../src/db/migrations/0109_supplier_item_notices.sql", import.meta.url), "utf8");
const securityMigration = await readFile(new URL("../src/db/migrations/0110_supplier_item_notice_security.sql", import.meta.url), "utf8");
const manualOutcomeMigration = await readFile(new URL("../src/db/migrations/0113_supplier_notice_manual_outcome_evidence.sql", import.meta.url), "utf8");
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

test("manual send evidence remains valid when its supplier outcome is reconciled", () => {
  assert.match(manualOutcomeMigration, /DROP CONSTRAINT IF EXISTS supplier_item_notice_attempt_check/);
  assert.match(manualOutcomeMigration, /DROP CONSTRAINT IF EXISTS supplier_item_notice_manual_sent_shape/);
  assert.match(manualOutcomeMigration, /SUPPLIER_STOP_CONFIRMED','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM/);
  assert.match(manualOutcomeMigration, /manual_reference.*sent_at/s);
  assert.match(service, /state: input\.outcome,\s*providerReference/);
});
