import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const finance = await import("../src/modules/supplier-finance/validation.ts");

test("USD amounts become exact integer minor units without floating point", () => {
  assert.equal(finance.parseUsdMinor("125.7"), "12570");
  assert.equal(finance.parseUsdMinor("0.00"), null);
  assert.equal(finance.parseUsdMinor("0.00", true), "0");
  assert.equal(finance.parseUsdMinor("01.20"), null);
  assert.equal(finance.parseUsdMinor("1.001"), null);
  assert.equal(finance.parseUsdMinor("1e2"), null);
  assert.equal(finance.parseUsdMinor("$12.00"), null);
});

test("reason, evidence reference, and payment date inputs are bounded and normalized", () => {
  assert.equal(finance.normalizeFinanceReason("  corrected invoice  "), "corrected invoice");
  assert.equal(finance.normalizeFinanceReason("ab"), null);
  assert.equal(finance.normalizeFinanceReason("bad\nreason"), null);
  assert.equal(finance.normalizeEvidenceReference(" INV-302 "), "INV-302");
  assert.equal(finance.normalizeEvidenceReference("bad\nheader"), null);
  assert.equal(finance.normalizeEvidenceReference("https://files.example/receipt"), null);
  assert.equal(finance.parsePaymentDate("2026-10-28")?.toISOString(), "2026-10-28T00:00:00.000Z");
  assert.equal(finance.parsePaymentDate("2026-02-30"), null);
  assert.equal(finance.parsePaymentDate("10/28/2026"), null);
});

test("supplier transfer evidence accepts only bounded PDF or EML bytes", () => {
  const pdf = Buffer.from("%PDF-1.7 receipt");
  const eml = Buffer.from("From: finance@example.invalid\r\nSubject: Transfer receipt\r\n\r\nSent");
  const foldedEml = Buffer.from("From: finance@example.invalid\nSubject: Transfer\n\treceipt\n\nSent");
  assert.equal(finance.validSupplierTransferEvidence("PDF", pdf), true);
  assert.equal(finance.validSupplierTransferEvidence("EML", eml), true);
  assert.equal(finance.validSupplierTransferEvidence("EML", foldedEml), true);
  assert.equal(finance.validSupplierTransferEvidence("PDF", Buffer.from("not a pdf")), false);
  assert.equal(finance.validSupplierTransferEvidence("EML", Buffer.from([0, 1, 2])), false);
  assert.equal(finance.validSupplierTransferEvidence("EML", Buffer.from("receipt")), false);
  assert.equal(finance.validSupplierTransferEvidence("EML", Buffer.from("From finance@example.invalid\n\nReceipt")), false);
  assert.equal(finance.validSupplierTransferEvidence("EML", Buffer.from("\tSubject: orphan continuation\n\nReceipt")), false);
  assert.equal(finance.validSupplierTransferEvidence("EXE", pdf), false);
  assert.equal(finance.validSupplierTransferEvidence("PDF", Buffer.alloc(5 * 1024 * 1024 + 1)), false);
});

test("database finance records are role-scoped, audited, and immutable", async () => {
  const sql = await readFile(new URL("../src/db/migrations/0019_supplier_finance_records.sql", import.meta.url), "utf8");
  assert.match(sql, /'FINANCE'[\s\S]*'SUPER_ADMIN'/);
  assert.match(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON supplier_listing_cost_event, supplier_order_item_cost_event, supplier_payment_record FROM gphkm_runtime/);
  assert.match(sql, /supplier_payment_record_audited BEFORE INSERT/);
  assert.match(sql, /marketplace_listing_cost_audited BEFORE INSERT OR UPDATE/);
  assert.match(sql, /gphkm_finance_supplier_name\(target_supplier_id text\)/);
});

test("finance reconciliation pages transfer evidence and reads latest cost projections", async () => {
  const source = await readFile(new URL("../src/server/catalog/supplier-finance.ts", import.meta.url), "utf8");
  assert.match(source, /selectDistinctOn\(\[[\s\S]*supplierOrderItemCostEvent\.component/);
  assert.match(source, /where\(inArray\(supplierTransferAllocation\.transferEventId, transfers\.map\(\(transfer\) => transfer\.id\)\)\)/);
  assert.match(source, /staffCatalogPagination\(requestedPages\.transfers/);
  assert.match(source, /limit\(transferPagination\.limit\)\.offset\(transferPagination\.offset\)/);
  assert.doesNotMatch(source, /supplierTransferEvent\.createdAt\)\.limit\(500\)/);
  const reportStart = source.indexOf("export async function getSupplierFinanceData");
  const reportEnd = source.indexOf("export async function searchSupplierTransferItems", reportStart);
  assert.match(source.slice(reportStart, reportEnd), /\}, "repeatable read"\);/);
});

test("Finance listing, order-item, and transfer histories are paged and supplier item search is capped and scoped", async () => {
  const source = await readFile(new URL("../src/server/catalog/supplier-finance.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/suppliers/finance/page.tsx", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/app/staff/(console)/suppliers/finance/transfer-allocation-editor.tsx", import.meta.url), "utf8");
  assert.match(source, /staffCatalogPagination\(requestedPages\.listings/);
  assert.match(source, /staffCatalogPagination\(requestedPages\.orderItems/);
  assert.match(source, /staffCatalogPagination\(requestedPages\.transfers/);
  assert.match(source, /requireStaffAccess\(headers, "costs\.read"\)/);
  assert.match(source, /ilike\(orderItemFinancial\.orderItemId, `\$\{query\}%`\)/);
  assert.match(source, /\.limit\(25\)/);
  assert.match(page, /Finance listing pages/);
  assert.match(page, /Finance order item pages/);
  assert.match(page, /Supplier transfer pages/);
  assert.match(page, /transfersPage=/);
  assert.match(editor, /Search order items/);
});

test("accepted equivalents keep checkout snapshots while Finance reconciles original and approved supplier routes", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0104_equivalent_supplier_finance.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/supplier-finance.ts", import.meta.url), "utf8");
  const allocations = await readFile(new URL("../src/db/migrations/0091_supplier_transfer_allocations.sql", import.meta.url), "utf8");
  assert.match(migration, /accepted\.content_hash = accepted_route\.content_hash/);
  assert.match(migration, /customer_order\.actor_user_id = accepted\.actor_user_id/);
  assert.match(migration, /gphkm_finance_item_supplier_allowed/);
  assert.match(service, /const supplierId = input\.component === "WRITING" \? null : input\.supplierId/);
  assert.match(service, /supplierOrderItemCostEvent\.supplierId, supplierId/);
  assert.match(service, /gphkm_finance_item_supplier_allowed\(requested\.order_item_id/);
  assert.match(allocations, /supplier_transfer_allocation/);
  assert.match(allocations, /allocation\.amount_minor/);
});

test("writing direct costs require a purchased writing add-on in application and database", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0116_require_purchased_writing_for_cost.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/supplier-finance.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/suppliers/finance/page.tsx", import.meta.url), "utf8");
  assert.match(migration, /item\.id = target_order_item_id AND item\.writing_selected/);
  assert.match(migration, /component = 'WRITING' AND supplier_id IS NULL AND public\.gphkm_finance_writing_cost_allowed\(order_item_id\)/);
  assert.match(service, /if \(input\.component === "WRITING"\)[\s\S]*gphkm_finance_writing_cost_allowed/);
  assert.match(page, /item\.writingSelected \? usd\(item\.writingCostMinor\) : "Not ordered"/);
  assert.match(page, /item\.writingSelected && <option value="WRITING">Writing<\/option>/);
});

test("supplier transfer receipts are mandatory, private, immutable, and Finance-scoped", async () => {
  const schema = await readFile(new URL("../src/db/supplier-finance-schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0117_supplier_transfer_evidence.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/catalog/supplier-finance.ts", import.meta.url), "utf8");
  const upload = await readFile(new URL("../src/app/api/staff/suppliers/finance/transfers/route.ts", import.meta.url), "utf8");
  const download = await readFile(new URL("../src/app/api/staff/suppliers/finance/transfers/evidence/[evidenceId]/route.ts", import.meta.url), "utf8");
  const editor = await readFile(new URL("../src/app/staff/(console)/suppliers/finance/transfer-allocation-editor.tsx", import.meta.url), "utf8");
  assert.match(schema, /supplierTransferEvidence = pgTable\("supplier_transfer_evidence"/);
  assert.match(migration, /supplier_transfer_requires_evidence[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /supplier_transfer_evidence_finance_read[\s\S]*'FINANCE'[\s\S]*'SUPER_ADMIN'/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE ON public\.supplier_transfer_evidence FROM gphkm_runtime/);
  assert.match(service, /savePrivateFile\(evidence\.bytes\)/);
  assert.match(service, /requestHash[\s\S]*evidenceSha256/);
  assert.match(service, /if \(!transactionCallbackReturned\) await deletePrivateFile\(storageKey\)/);
  assert.match(service, /readPrivateFile\(row\.storageKey, 5 \* 1024 \* 1024\)/);
  assert.match(upload, /new URL\(origin\)\.origin !== new URL\(staffOrigin\)\.origin/);
  assert.match(upload, /MAX_REQUEST_BYTES/);
  assert.match(download, /Content-Disposition/);
  assert.match(download, /X-Content-Type-Options/);
  assert.match(editor, /name="evidenceFile" type="file"[^>]*required/);
});
