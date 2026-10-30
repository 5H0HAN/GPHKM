import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";

const imports = await import("../src/modules/catalog/imports.ts");

function xlsxBuffer({ formula = false, external = false, macro = false, extra = {} } = {}) {
  const cells = formula
    ? '<row r="2"><c r="A2" t="str"><f>HYPERLINK(\"https://example.test\")</f><v>Example</v></c></row>'
    : '<row r="2"><c r="A2" t="s"><v>1</v></c></row>';
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${macro ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${external ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.test" TargetMode="External"/>' : ""}</Relationships>`),
    "xl/sharedStrings.xml": strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>websiteUrl</t></si><si><t>https://example.com</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row>${cells}</sheetData></worksheet>`),
    ...(macro ? { "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) } : {}),
    ...extra,
  }));
}

test("CSV parser handles quoted values and rejects formulas or malformed input", () => {
  const parsed = imports.parseCsv('websiteUrl,title\r\nhttps://example.com,"A, site"\r\n');
  assert.deepEqual(parsed.rows, [["websiteUrl", "title"], ["https://example.com", "A, site"]]);
  assert.throws(() => imports.parseCsv("domain,name\nhttps://example.com,=HYPERLINK(1)"), /FORMULA/);
  assert.throws(() => imports.parseCsv('domain,name\nhttps://example.com,"unterminated'), /CSV_INVALID/);
  assert.throws(() => imports.parseCsv("domain,name\nhttps://example.com,-2+3"), /FORMULA/);
});

test("XLSX reader rejects formulas, external links, macro formats, and malformed archives", async () => {
  const parsed = await imports.parseXlsx(xlsxBuffer(), "supplier.xlsx");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "Inventory");
  await assert.rejects(imports.parseXlsx(xlsxBuffer({ formula: true }), "supplier.xlsx"), /FORMULA_REJECTED/);
  await assert.rejects(imports.parseXlsx(xlsxBuffer({ external: true }), "supplier.xlsx"), /EXTERNAL_LINK/);
  await assert.rejects(imports.parseXlsx(xlsxBuffer({ macro: true }), "supplier.xlsx"), /EXTERNAL_OR_MACRO/);
  await assert.rejects(imports.parseXlsx(Buffer.from("not a zip"), "supplier.xlsx"), /XLSX_INVALID/);
  await assert.rejects(imports.parseXlsx(xlsxBuffer({ extra: { "xl/unexpected.xml": strToU8("A".repeat(9 * 1024 * 1024)) } }), "supplier.xlsx"), /ENTRY_TOO_LARGE/);
  await assert.rejects(imports.parseXlsx(xlsxBuffer(), "supplier.xlsm"), /MACRO_FORMAT/);
});

test("XLSX parsing admits one worker at a time and releases capacity after completion", async () => {
  const first = imports.parseXlsx(xlsxBuffer(), "first.xlsx");
  await assert.rejects(imports.parseXlsx(xlsxBuffer(), "second.xlsx"), /PARSER_BUSY/);
  assert.equal((await first)[0].name, "Inventory");
  await assert.rejects(imports.parseXlsx(Buffer.from("not a zip"), "invalid.xlsx"), /XLSX_INVALID/);
  assert.equal((await imports.parseXlsx(xlsxBuffer(), "third.xlsx"))[0].name, "Inventory");

  const route = await readFile(new URL("../src/app/api/staff/catalog/import/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/suppliers/imports/page.tsx", import.meta.url), "utf8");
  assert.match(route, /IMPORT_XLSX_PARSER_BUSY[\s\S]*error=busy/);
  assert.match(page, /An XLSX file is already being parsed/);
});

test("XLSX archive inspection and parsing run with worker time and memory bounds", () => {
  assert.equal(imports.IMPORT_LIMITS.xlsxParseMilliseconds, 10_000);
  assert.equal(imports.IMPORT_LIMITS.xlsxParserMemoryMb, 128);
  const source = readFileSync(new URL("../src/modules/catalog/imports.ts", import.meta.url), "utf8");
  assert.match(source, /inspectXlsxArchive\(buffer\);[\s\S]*readXlsxFile\(buffer, \{ trim: false \}\)/);
  assert.match(source, /resourceLimits:[\s\S]*maxOldGenerationSizeMb: IMPORT_LIMITS\.xlsxParserMemoryMb/);
  assert.match(source, /xlsxParseMilliseconds[\s\S]*worker\.terminate\(\)/);
});

test("mapping and staging validate listing fields and duplicate review while rejecting source-cost imports", () => {
  const rows = [
    ["domain", "title", "description", "country", "language", "categories", "link", "term", "days", "cost", "sponsored"],
    ["https://example.com", "Example", "Example placement", "US", "English", "Business|Technology & Gadgets", "DOFOLLOW", "PERMANENT", "10", "$40.75", "yes"],
    ["https://example.com", "Second", "Second placement", "US", "English", "Business", "NOFOLLOW", "ONE_YEAR", "15", "$50", "no"],
    ["http://bad.example", "Bad", "", "USA", "Not A Language", "Unknown", "DIRECTION", "FOREVER", "0", "bad-cost", "maybe"],
  ];
  const mapping = {
    websiteUrl: 0, title: 1, description: 2, countryCode: 3, primaryLanguage: 4,
    categories: 5, linkType: 6, linkValidity: 7, turnaroundDays: 8, sponsoredContentMarking: 10,
  };
  const candidates = imports.stageImportRows({ rows, mapping, existingListings: [{ id: "old", websiteUrl: "https://example.com/" }] });
  assert.equal(candidates[0].status, "DUPLICATE_REVIEW");
  const persisted = imports.getPersistableImportValues(candidates[0], rows[1], mapping);
  assert.equal(persisted.originalValues.title, "Example");
  assert.equal("sourceCostCents" in persisted.originalValues, false);
  assert.equal("sourceCostCents" in persisted.stagedValues, false);
  assert.equal(candidates[1].duplicateOfRow, 2);
  assert.equal(candidates[2].status, "INVALID");
  const resolved = imports.resolveDuplicate(candidates[0], {
    decision: "KEEP_SEPARATE", staffUserId: "staff-1", reason: "Supplier has distinct placement terms", decidedAt: "2026-10-28T00:00:00.000Z",
  });
  assert.equal(resolved.status, "READY");
  assert.equal(resolved.duplicateResolution.staffUserId, "staff-1");
  const applied = imports.prepareSelectedRowsForApply([resolved, candidates[1], candidates[2]], [2, 3], "ADMIN");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].listing.status, "DRAFT");
  assert.equal("retailPriceCents" in applied[0].listing, false);
  assert.throws(() => imports.prepareSelectedRowsForApply(candidates, [2], "FINANCE"), /FORBIDDEN/);
});

test("imports can map a later header row and safely normalize bare domains", () => {
  const rows = [
    ["Supplier title row"],
    ["Guest Post Sites List", "Moz DA", "Sample Post Link"],
    ["example.org", "61", "https://example.org/sample-post/"],
    ["example.net New", "58", "https://example.net/sample-post/"],
  ];
  const candidates = imports.stageImportRows({ rows, mapping: { websiteUrl: 0 }, existingListings: [], headerRowNumber: 2 });
  assert.equal(candidates[0].rowNumber, 3);
  assert.equal(candidates[0].values.websiteUrl, "https://example.org/");
  assert.equal(candidates[0].status, "NEEDS_REVIEW");
  assert.equal(candidates[1].rowNumber, 4);
  assert.equal(candidates[1].status, "INVALID");
  assert.throws(() => imports.stageImportRows({ rows, mapping: { websiteUrl: 0 }, existingListings: [], headerRowNumber: 101 }), /HEADER_ROW_INVALID/);
});

test("supplier imports preserve the supplier as fulfillment contact", async () => {
  const apply = await readFile(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../src/db/migrations/0103_require_supplier_fulfillment.sql", import.meta.url), "utf8");
  assert.match(apply, /validateListingRelationships\("SUPPLIER_SOURCED", batch\.supplierId, batch\.supplierId\)/);
  assert.match(apply, /commercialSource: "SUPPLIER_SOURCED", supplierId: batch\.supplierId, fulfillmentSupplierId: batch\.supplierId/);
  assert.match(migration, /UPDATE public\.marketplace_listing_sourcing[\s\S]*SET fulfillment_supplier_id = supplier_id[\s\S]*commercial_source = 'SUPPLIER_SOURCED'/);
  assert.match(migration, /CHECK \(supplier_id IS NULL OR \(fulfillment_supplier_id IS NOT NULL AND supplier_id = fulfillment_supplier_id\)\)/);
});

test("import review compares bounded existing listing snapshots without source costs", async () => {
  const server = await readFile(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/staff/(console)/suppliers/imports/[batchId]/page.tsx", import.meta.url), "utf8");
  assert.match(server, /duplicateOfListingIds\.slice\(0, 3\)/);
  assert.match(server, /listing\.retailPriceCents/);
  assert.match(server, /listing\.revision/);
  assert.match(server, /listingSourcing\.commercialSource/);
  assert.match(server, /sourceSupplierName: importSourceSupplier\.name/);
  assert.match(server, /fulfillmentSupplierName: importFulfillmentSupplier\.name/);
  assert.match(page, /Current listing/);
  assert.match(page, /Imported value/);
  assert.match(page, /Internal source:/);
  assert.match(page, /Import review never changes an existing listing/);
  assert.doesNotMatch(server.slice(server.indexOf("const matches ="), server.indexOf("const matchesById")), /sourceCost|supplierContact/);
});

test("manual column mapping accepts bounded zero-based indexes only", () => {
  assert.deepEqual(imports.parseColumnMapping({ websiteUrl: "0", title: "2" }), { websiteUrl: 0, title: 2 });
  assert.throws(() => imports.parseColumnMapping({ websiteUrl: "0", sourceCostCents: "9" }), /MAPPING_INVALID/);
  assert.throws(() => imports.parseColumnMapping({ websiteUrl: "1.5" }), /MAPPING_INVALID/);
  assert.throws(() => imports.parseColumnMapping({ unexpected: "0" }), /MAPPING_INVALID/);
});

test("Google Sheet references accept only fixed validated Google hosts", () => {
  assert.deepEqual(imports.extractPublicSheetReference("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit?gid=17#gid=17"), {
    spreadsheetId: "1aBcdefghijklmnopQRSTuvwxYZ1234567890", gid: "17",
  });
  for (const value of [
    "http://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit",
    "https://docs.google.evil/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit",
    "https://docs.google.com@127.0.0.1/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit",
    "https://docs.google.com/spreadsheets/d/short/edit",
    "https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit?gid=4&redirect=https://127.0.0.1",
    "https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit?gid=4#gid=9",
  ]) assert.throws(() => imports.extractPublicSheetReference(value), /REFERENCE_INVALID/);
});

test("public Sheets fetch uses the fixed CSV endpoint and rejects redirects", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  let requestOptions;
  globalThis.fetch = async (input, options) => {
    requestUrl = String(input);
    requestOptions = options;
    return new Response("domain,title\nhttps://example.com,Example", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
  };
  try {
    const csv = await imports.fetchPublicSheetCsv("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit?gid=17");
    assert.match(csv, /^domain,title/);
    assert.equal(requestUrl, "https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/export?format=csv&gid=17");
    assert.equal(requestOptions.redirect, "error");
    globalThis.fetch = async () => { throw new Error("redirect denied"); };
    await assert.rejects(imports.fetchPublicSheetCsv("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit"), /SHEET_FETCH_FAILED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inventory source files survive an ambiguous commit acknowledgement", () => {
  const source = readFileSync(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  assert.match(source, /let transactionCallbackReturned = false/);
  assert.match(source, /transactionCallbackReturned = true;\s*return \{ batchId, rowCount/);
  assert.match(source, /if \(!transactionCallbackReturned\) await deletePrivateFile\(sourceObjectKey\)/);
});
