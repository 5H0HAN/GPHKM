import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("catalog filters and pagination preserve native link navigation", async () => {
  const source = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/customer/customer.module.css", import.meta.url), "utf8");
  const filters = source.slice(source.indexOf("export function CatalogFilters"), source.indexOf("export function CatalogPagination"));
  const pagination = source.slice(source.indexOf("export function CatalogPagination"));

  assert.match(filters, /<Link href=\{`\/customer\/catalog\?organizationId=/);
  assert.doesNotMatch(filters, /<button[^>]*onClick=\{\(\) => router\.push/);
  assert.match(pagination, /function pageHref\(nextPage: number\)/);
  assert.match(pagination, /<Link href=\{pageHref\(page - 1\)\}>Previous<\/Link>/);
  assert.match(pagination, /<Link href=\{pageHref\(page \+ 1\)\}>Next<\/Link>/);
  assert.match(pagination, /params\.set\("q", search\)/);
  assert.match(pagination, /params\.set\("category", category\)/);
  assert.match(filters, /name="country"/);
  assert.match(filters, /name="language"/);
  assert.match(filters, /name="doFollowOnly"/);
  assert.match(pagination, /params\.set\("country", country\)/);
  assert.match(pagination, /params\.set\("language", language\)/);
  assert.match(pagination, /params\.set\("doFollowOnly", "1"\)/);
  const customerQuery = await readFile(new URL("../src/server/catalog/customer.ts", import.meta.url), "utf8");
  assert.match(customerQuery, /eq\(listing\.countryCode, country\)/);
  assert.match(customerQuery, /eq\(listing\.primaryLanguage, language\)/);
  assert.match(customerQuery, /eq\(listing\.linkType, "DOFOLLOW"\)/);
  assert.match(source, /useEffect\(\(\) => \{ if \(error\) errorRef\.current\?\.focus\(\); \}, \[error\]\)/);
  assert.match(source, /role="alert" tabIndex=\{-1\}/);
  assert.match(styles, /catalogPagination a:focus-visible/);
});
