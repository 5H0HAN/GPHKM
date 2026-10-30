import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staffCatalogPagination } from "../src/modules/catalog/pagination.ts";

test("staff catalog pagination reaches every listing and clamps untrusted page inputs", () => {
  const all = Array.from({ length: 127 }, (_, index) => index);
  const visited = [];
  for (const page of [1, "2", 3]) {
    const result = staffCatalogPagination(page, all.length);
    assert.equal(result.totalPages, 3);
    visited.push(...all.slice(result.offset, result.offset + result.limit));
  }
  assert.deepEqual(visited, all);
  assert.equal(staffCatalogPagination("999", 127).page, 3);
  for (const invalid of [undefined, null, "0", "1.5", "1e3", "3x", ["2"], Infinity, NaN]) {
    assert.equal(staffCatalogPagination(invalid, 127).page, 1);
  }
});

test("staff listing and supplier directory queries use total counts, stable order, and bounded page size", () => {
  const server = readFileSync(new URL("../src/server/catalog/admin.ts", import.meta.url), "utf8");
  for (const name of ["listStaffListings", "listStaffSuppliersPage"]) {
    const start = server.indexOf(`export async function ${name}`);
    const next = server.indexOf("\nexport async function ", start + 1);
    const body = server.slice(start, next < 0 ? undefined : next);
    assert.match(body, /count\(\*\)::int/);
    assert.match(body, /orderBy\(desc\([\s\S]*desc\([\s\S]*\.limit\(pagination\.limit\)\.offset\(pagination\.offset\)/);
  }
  const catalogPage = readFileSync(new URL("../src/app/staff/(console)/catalog/page.tsx", import.meta.url), "utf8");
  const suppliersPage = readFileSync(new URL("../src/app/staff/(console)/suppliers/page.tsx", import.meta.url), "utf8");
  assert.match(catalogPage, /listStaffListings\(await headers\(\), requestedPage\)/);
  assert.match(suppliersPage, /listStaffSuppliersPage\(requestHeaders, requestedPage \?\? "1"\)/);
  assert.match(catalogPage, /aria-label="Catalog pages"/);
  assert.match(suppliersPage, /aria-label="Supplier pages"/);
  assert.match(server, /export async function listStaffSuppliers\(headers: Headers\)/);
});

test("supplier profiles page contacts and inventory and expose only aggregate refund counts", () => {
  const server = readFileSync(new URL("../src/server/catalog/admin.ts", import.meta.url), "utf8");
  const start = server.indexOf("export async function getStaffSupplierProfile");
  const next = server.indexOf("\nexport async function ", start + 1);
  const profile = server.slice(start, next);
  assert.match(profile, /staffCatalogPagination\(requestedPages\.contacts/);
  assert.match(profile, /orderBy\(desc\(supplierContact\.isPrimary\), supplierContact\.name, supplierContact\.id\)/);
  assert.match(profile, /limit\(contactPagination\.limit\)\.offset\(contactPagination\.offset\)/);
  assert.match(profile, /staffCatalogPagination\(requestedPages\.inventory/);
  assert.match(profile, /orderBy\(listing\.title, listing\.id\)[\s\S]*limit\(inventoryPagination\.limit\)\.offset\(inventoryPagination\.offset\)/);
  assert.match(profile, /gphkm_supplier_operational_refunded_count/);
  assert.doesNotMatch(profile, /gphkm_supplier_item_refund_totals/);

  const page = readFileSync(new URL("../src/app/staff/(console)/suppliers/[supplierId]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /aria-label="Supplier contact pages"/);
  assert.match(page, /aria-label="Supplier inventory pages"/);
  assert.match(page, /<dt>Refunded<\/dt>/);

  const migration = readFileSync(new URL("../src/db/migrations/0118_supplier_profile_refund_count.sql", import.meta.url), "utf8");
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'ADMIN'\)/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'SUPER_ADMIN'\)/);
  assert.match(migration, /RETURNS bigint/);
  assert.match(migration, /HAVING sum\(ledger\.delta_minor\) > 0/);
  assert.doesNotMatch(migration, /RETURNS TABLE|refunded_minor|customer_email|article_text|payment_payload/i);
});

test("metric refresh candidates paginate across the entire catalog and preserve the selected page", () => {
  const service = readFileSync(new URL("../src/server/catalog/metrics.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/staff/(console)/metrics/page.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/staff/(console)/metrics/actions.ts", import.meta.url), "utf8");
  assert.match(service, /staffCatalogPagination\(requestedPage, count\?\.total \?\? 0\)/);
  assert.match(service, /orderBy\(desc\(listing\.updatedAt\), desc\(listing\.id\)\)\.limit\(pagination\.limit\)\.offset\(pagination\.offset\)/);
  assert.match(page, /listMetricRefreshCandidates\(requestHeaders, requestedPage\)/);
  assert.match(page, /aria-label="Metric refresh pages"/);
  assert.match(page, /name="page" value=\{refreshData\.page\}/);
  assert.match(actions, /staff\/metrics\?page=\$\{page\}&refreshed=/);
});
