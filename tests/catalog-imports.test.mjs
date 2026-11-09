import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { strToU8, zipSync } from "fflate";

const imports = await import("../src/modules/catalog/imports.ts");
const importReview = await import("../src/modules/catalog/import-review.ts");
const catalogDomain = await import("../src/modules/catalog/domain.ts");

function xlsxBuffer({ formula = false, external = false, macro = false, worksheetPath = "worksheets/sheet1.xml", extra = {} } = {}) {
  const cells = formula
    ? '<row r="2"><c r="A2" t="str"><f>HYPERLINK(\"https://example.test\")</f><v>Example</v></c></row>'
    : '<row r="2"><c r="A2" t="s"><v>1</v></c></row>';
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${macro ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"}"/><Override PartName="/xl/${worksheetPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inventory" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${worksheetPath}"/>${external ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.test" TargetMode="External"/>' : ""}</Relationships>`),
    "xl/sharedStrings.xml": strToU8('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>websiteUrl</t></si><si><t>https://example.com</t></si></sst>'),
    [`xl/${worksheetPath}`]: strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row>${cells}</sheetData></worksheet>`),
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

test("XLSX formula inspection uses the workbook's actual worksheet target", async () => {
  const worksheetPath = "worksheets/inventory.xml";
  assert.equal((await imports.parseXlsx(xlsxBuffer({ worksheetPath }), "inventory.xlsx"))[0].rows[1][0], "https://example.com");
  await assert.rejects(imports.parseXlsx(xlsxBuffer({
    formula: true,
    worksheetPath,
    extra: { "xl/worksheets/sheet1.xml": strToU8("<worksheet/>") },
  }), "inventory.xlsx"), /IMPORT_FORMULA_REJECTED/);
});

test("XLSX parsing admits one worker at a time and releases capacity after completion", async () => {
  const first = imports.parseXlsx(xlsxBuffer(), "first.xlsx");
  await assert.rejects(imports.parseXlsx(xlsxBuffer(), "second.xlsx"), /PARSER_BUSY/);
  assert.equal((await first)[0].name, "Inventory");
  await assert.rejects(imports.parseXlsx(Buffer.from("not a zip"), "invalid.xlsx"), /XLSX_INVALID/);
  assert.equal((await imports.parseXlsx(xlsxBuffer(), "third.xlsx"))[0].name, "Inventory");
});

test("thin wiring guard: XLSX archive inspection precedes parsing and worker resources stay bounded", async () => {
  assert.equal(imports.IMPORT_LIMITS.xlsxParseMilliseconds, 10_000);
  assert.equal(imports.IMPORT_LIMITS.xlsxParserMemoryMb, 128);
  const source = await readFile(new URL("../src/modules/catalog/imports.ts", import.meta.url), "utf8");
  assert.match(source, /inspectXlsxArchive\(buffer, Parser\);[\s\S]*readXlsxFile\(buffer, \{ trim: false \}\)/);
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
  const categorized = imports.applyPlatformCategoryOverride(candidates[0], ["Business", "Technology & Gadgets"]);
  const resolved = imports.resolveDuplicate(categorized, {
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

test("import URL lookup shares canonicalization and preserves every stored duplicate", () => {
  assert.equal(catalogDomain.normalizeWebsiteUrlLookupKey("HTTPS://Example.COM"), "https://example.com");
  assert.equal(catalogDomain.normalizeWebsiteUrlLookupKey("https://example.com:443/"), "https://example.com");
  assert.equal(catalogDomain.normalizeWebsiteUrlLookupKey("https://www.example.com/"), "https://www.example.com");
  assert.equal(catalogDomain.normalizeWebsiteUrlLookupKey("https://example.com:8443/"), null);
  assert.equal(catalogDomain.normalizeWebsiteUrlLookupKey("https://example.com/path/"), null);

  const candidates = imports.stageImportRows({
    rows: [["website"], ["HTTPS://EXAMPLE.COM"], ["example.com"], ["www.example.com"]],
    mapping: { websiteUrl: 0 },
    existingListings: [
      { id: "upper-slashless", websiteUrl: "https://Example.com" },
      { id: "lower-with-slash", websiteUrl: "https://example.com/" },
      { id: "www-distinct", websiteUrl: "https://www.example.com/" },
      { id: "invalid-path", websiteUrl: "https://example.com/path/" },
    ],
  });

  assert.equal(candidates[0].values.websiteUrl, "https://example.com/");
  assert.deepEqual(candidates[0].duplicateOfListingIds.sort(), ["lower-with-slash", "upper-slashless"]);
  assert.equal(candidates[0].status, "DUPLICATE_REVIEW");
  assert.deepEqual(candidates[1].duplicateOfListingIds.sort(), ["lower-with-slash", "upper-slashless"]);
  assert.equal(candidates[1].duplicateOfRow, 2);
  assert.deepEqual(candidates[2].duplicateOfListingIds, ["www-distinct"]);
  assert.deepEqual(imports.listingWebsiteUrlLookupKeys(candidates.map((candidate) => candidate.values.websiteUrl)), [
    "https://example.com", "https://www.example.com",
  ]);
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
  assert.equal(candidates[1].status, "NEEDS_REVIEW");
  assert.ok(candidates[1].warnings.includes("WEBSITE_NEW_MARKER_CONFIRMATION_REQUIRED"));
  assert.throws(() => imports.stageImportRows({ rows, mapping: { websiteUrl: 0 }, existingListings: [], headerRowNumber: 101 }), /HEADER_ROW_INVALID/);
});

test("supplier category labels require a row-specific platform selection and keep the original label", () => {
  const familiarRows = [["domain", "title", "description", "country", "language", "category", "link", "term", "days", "sponsored"],
    ["general.example", "General Site", "Description", "US", "English", "General", "DOFOLLOW", "PERMANENT", "10", "yes"]];
  const rows = [["domain", "title", "description", "country", "language", "category", "link", "term", "days", "sponsored"],
    ["example.com", "Example", "Description", "US", "English", "Fintech and Money", "DOFOLLOW", "PERMANENT", "10", "yes"]];
  const mapping = { websiteUrl: 0, title: 1, description: 2, countryCode: 3, primaryLanguage: 4, categories: 5,
    linkType: 6, linkValidity: 7, turnaroundDays: 8, sponsoredContentMarking: 9 };
  const pending = imports.stageImportRows({ rows, mapping, existingListings: [] })[0];
  assert.equal(pending.status, "NEEDS_REVIEW");
  assert.ok(pending.warnings.includes("FIELD_VALUE_NEEDS_REVIEW:categories"));
  const familiar = imports.stageImportRows({ rows: familiarRows, mapping, existingListings: [] })[0];
  assert.equal(familiar.status, "NEEDS_REVIEW");
  assert.ok(familiar.warnings.includes("CATEGORY_ROW_MAPPING_REQUIRED"));
  assert.equal(familiar.values.categories, undefined);
  const override = imports.applyPlatformCategoryOverride(pending, ["Fintech"]);
  assert.equal(override.status, "READY");
  assert.equal(override.values.categories, "Fintech");
  assert.equal(imports.getPersistableImportValues(pending, rows[1], mapping).originalValues.categories, "Fintech and Money");
});

test("row review items name the fields to fix and open the right review action", () => {
  const items = importReview.buildImportReviewItems({
    status: "NEEDS_REVIEW",
    values: { title: "Site", description: "Description", countryCode: "US", turnaroundDays: 1, sponsoredContentMarking: true },
    errors: [],
    warnings: ["WEBSITE_NEW_MARKER_CONFIRMATION_REQUIRED", "TURNAROUND_INSTANT_REVIEW_REQUIRED", "LISTING_DETAILS_NEED_REVIEW", "CATEGORY_ROW_MAPPING_REQUIRED"],
    platformCategories: [], retailPriceSaved: false, duplicateOfRow: null,
  });
  assert.deepEqual(items.map((item) => item.label), ["Website URL", "Turnaround days", "GPHKM categories", "Language", "Link type", "Placement term", "USD retail price"]);
  assert.ok(items.every((item) => !/^[A-Z0-9_]+$/.test(item.message)));
  const duplicate = importReview.buildImportReviewItems({
    status: "DUPLICATE_REVIEW",
    values: { title: "Site", description: "Description", countryCode: "US", primaryLanguage: "English", linkType: "DOFOLLOW", linkValidity: "PERMANENT", turnaroundDays: 3, sponsoredContentMarking: true },
    errors: [], warnings: ["POSSIBLE_DUPLICATE_DOMAIN"], platformCategories: ["Business"], retailPriceSaved: true, duplicateOfRow: 14,
  });
  assert.equal(duplicate.at(-1).section, "decisions");
  assert.match(duplicate.at(-1).message, /row 14/);
});

test("staging exposes website matches as review decisions and keeps source-only columns out of listing values", () => {
  const rows = [
    ["website", "title", "description", "country", "language", "category", "link type", "term", "turnaround", "sponsored", "cost"],
    ["Example.com", "Example", "A reviewed placement", "US", "English", "Business", "DOFOLLOW", "PERMANENT", "10", "yes", "$40"],
  ];
  const mapping = {
    websiteUrl: 0, title: 1, description: 2, countryCode: 3, primaryLanguage: 4,
    categories: 5, linkType: 6, linkValidity: 7, turnaroundDays: 8, sponsoredContentMarking: 9,
  };
  const [candidate] = imports.stageImportRows({
    rows, mapping, existingListings: [
      { id: "listing-one", websiteUrl: "https://example.com/" },
      { id: "listing-two", websiteUrl: "https://EXAMPLE.com/" },
    ],
  });
  assert.equal(candidate.status, "DUPLICATE_REVIEW");
  assert.deepEqual(candidate.duplicateOfListingIds, ["listing-one", "listing-two"]);
  const saved = imports.getPersistableImportValues(candidate, rows[1], mapping);
  assert.equal(saved.originalValues.websiteUrl, "Example.com");
  assert.equal("cost" in saved.originalValues, false);
  assert.equal("sourceCostCents" in saved.stagedValues, false);
  const review = importReview.buildImportReviewItems({
    status: candidate.status, values: candidate.values, errors: candidate.errors, warnings: candidate.warnings,
    platformCategories: [], retailPriceSaved: false, duplicateOfRow: candidate.duplicateOfRow,
  });
  assert.ok(review.some((item) => item.section === "decisions" && item.label === "Possible website match"));
  assert.ok(review.some((item) => item.field === "proposedRetailPriceUsd"));
});

test("import apply preparation admits only ready rows after category and duplicate review", () => {
  const rows = [
    ["website", "title", "description", "country", "language", "category", "link type", "term", "turnaround", "sponsored"],
    ["ready.example", "Ready", "Ready placement", "US", "English", "Business", "DOFOLLOW", "PERMANENT", "10", "yes"],
    ["ready.example", "Separate", "Distinct supplier offer", "US", "English", "Business", "DOFOLLOW", "ONE_YEAR", "14", "no"],
    ["review.example", "Incomplete", "", "US", "English", "Business", "DOFOLLOW", "PERMANENT", "10", "yes"],
  ];
  const mapping = {
    websiteUrl: 0, title: 1, description: 2, countryCode: 3, primaryLanguage: 4,
    categories: 5, linkType: 6, linkValidity: 7, turnaroundDays: 8, sponsoredContentMarking: 9,
  };
  const candidates = imports.stageImportRows({ rows, mapping, existingListings: [] });
  const ready = imports.applyPlatformCategoryOverride(candidates[0], ["Business"]);
  const duplicateNeedsCategoryReview = candidates[1];
  assert.equal(duplicateNeedsCategoryReview.status, "DUPLICATE_REVIEW");
  assert.equal(duplicateNeedsCategoryReview.duplicateOfRow, 2);
  const duplicateWithCategory = imports.applyPlatformCategoryOverride(duplicateNeedsCategoryReview, ["Business"]);
  const separate = imports.resolveDuplicate(duplicateWithCategory, {
    decision: "KEEP_SEPARATE", staffUserId: "staff-1", reason: "Distinct placement terms",
    decidedAt: "2026-10-28T00:00:00.000Z",
  });
  const rejected = imports.resolveDuplicate(duplicateWithCategory, {
    decision: "REJECT", staffUserId: "staff-1", reason: "Duplicate offer",
    decidedAt: "2026-10-28T00:00:00.000Z",
  });
  const incomplete = imports.applyPlatformCategoryOverride(candidates[2], ["Business"]);

  assert.equal(ready.status, "READY");
  assert.equal(separate.status, "READY", "a confirmed duplicate decision returns the row to apply review");
  assert.equal(rejected.status, "REJECTED");
  assert.equal(incomplete.status, "NEEDS_REVIEW");
  assert.equal(candidates[0].status, "NEEDS_REVIEW", "preparation does not mutate the saved source candidate");
  const selected = imports.prepareSelectedRowsForApply([ready, separate, incomplete], [2, 3, 4, 5], "ADMIN");
  assert.deepEqual(selected.map((row) => row.rowNumber), [2, 3], "review-only and rejected rows are skipped while confirmed rows are prepared");
  assert.equal(selected[0].listing.status, "DRAFT");
  assert.equal(selected[0].listing.websiteUrl, "https://ready.example/");
  assert.equal(selected[0].listing.sourceCostCents, null);
  assert.equal(selected[0].listing.writingEnabled, false);
  assert.equal("retailPriceCents" in selected[0].listing, false, "retail price stays in the explicit review/apply input");
  assert.throws(() => imports.toDraftListingInput(incomplete), /IMPORT_ROW_INCOMPLETE/);
  assert.deepEqual(imports.prepareSelectedRowsForApply([ready, rejected], [2, 3], "ADMIN").map((row) => row.rowNumber), [2],
    "an explicit duplicate rejection is excluded from draft creation");
  assert.deepEqual(imports.prepareSelectedRowsForApply([ready], [2], "SUPER_ADMIN").map((row) => row.rowNumber), [2]);
  assert.throws(() => imports.prepareSelectedRowsForApply([ready], [2], "FINANCE"), /FORBIDDEN/);
  assert.throws(() => imports.prepareSelectedRowsForApply([ready], [2, 2], "ADMIN"), /SELECTION_INVALID/);
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

test("public Sheets fetch follows only approved Google redirects and rejects unsafe destinations", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), redirect: options.redirect });
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: "https://drive.googleusercontent.com/download.csv" } });
    return new Response("domain,title\nhttps://example.com,Example", { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
  };
  try {
    const csv = await imports.fetchPublicSheetCsv("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit?gid=17");
    assert.match(csv, /^domain,title/);
    assert.deepEqual(requests, [
      { url: "https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/export?format=csv&gid=17", redirect: "manual" },
      { url: "https://drive.googleusercontent.com/download.csv", redirect: "manual" },
    ]);
    globalThis.fetch = async () => { throw new Error("redirect denied"); };
    await assert.rejects(imports.fetchPublicSheetCsv("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit"), /SHEET_FETCH_FAILED/);
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
    await assert.rejects(imports.fetchPublicSheetCsv("https://docs.google.com/spreadsheets/d/1aBcdefghijklmnopQRSTuvwxYZ1234567890/edit"), /SHEET_FETCH_FAILED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("thin wiring guard: ambiguous import commit leaves its upload registered for reference-aware cleanup", async () => {
  const source = await readFile(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  assert.match(source, /let transactionCallbackReturned = false/);
  assert.match(source, /transactionCallbackReturned = true;\s*return \{ batchId, rowCount/);
  assert.match(source, /linkPrivateFileUpload\(tx, sourceObjectKey\)/);
  assert.match(source, /if \(!transactionCallbackReturned\) await queuePrivateFileDeleteOutsideTransaction\(sourceObjectKey\)/);
});

test("thin wiring guard: selected-row apply keeps supplier authorization around the transaction helper", async () => {
  const source = await readFile(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  const wrapper = source.match(/export async function applySelectedImportRows\([\s\S]*?\n}\n/);
  assert.ok(wrapper, "authenticated apply command remains present");
  assert.match(wrapper[0], /staffTransaction\(headers, "supplier\.manage"/);
  assert.match(wrapper[0], /applySelectedImportRowsInTransaction\(tx, userId, batchId, selections, stopOnSkip\)/);
});

test("thin wiring guard: import URL lookups bind key lists as PostgreSQL arrays", async () => {
  const source = await readFile(new URL("../src/server/catalog/imports.ts", import.meta.url), "utf8");
  assert.equal((source.match(/ANY\(\$\{sql\.param\(websiteUrlKeys\)\}::text\[\]\)/g) ?? []).length, 3,
    "staging, correction, and apply lookups must pass the whole URL key list as one text array");
  assert.doesNotMatch(source, /ANY\(\$\{websiteUrlKeys/,
    "interpolating a JavaScript array directly expands it into SQL chunks instead of binding a PostgreSQL array");
});
