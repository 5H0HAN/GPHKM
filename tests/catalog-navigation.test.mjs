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

test("customer ordering separates listing selection, item details, and final review", async () => {
  const source = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../src/app/customer/catalog/page.tsx", import.meta.url), "utf8");
  const listingCards = source.slice(source.indexOf("{step === \"browse\""), source.indexOf("{selectedListings.length > 0"));
  const detailsFlow = source.slice(source.indexOf("{step === \"details\""), source.indexOf("</> : <>", source.indexOf("{step === \"details\"")));

  assert.match(source, /useState<"browse" \| "details" \| "review">\("browse"\)/);
  assert.match(source, /The stated term describes the publisher&apos;s intent/);
  assert.match(source, /Website address hidden · revealed after a qualifying wallet recharge/);
  assert.doesNotMatch(listingCards, /Destination URL|Anchor text|<textarea/);
  assert.match(source, /Complete the destination URL, anchor text, and/);
  assert.match(source, /function removeSelected\(listingId: string\)/);
  assert.match(source, /Remove from order/);
  assert.match(detailsFlow, /Copy shared details across selected placements/);
  assert.match(source, /Review \{item\.useWriting \? "writing brief" : "article"\}/);
  assert.match(source, /shareWithPublicationPartner: true/);
  assert.match(source, /idempotencyKey: idempotencyKeyRef\.current/);
  assert.match(page, /filterProps=\{/);
});
