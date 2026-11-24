import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("shared cart has an accessible, confirmed per-item remove control on every page", async () => {
  const component = await readFile(new URL("../src/app/customer/customer-cart-button.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/customer/customer.module.css", import.meta.url), "utf8");

  assert.match(component, /className=\{styles\.cartItemRemoveButton\}/);
  assert.match(component, /aria-label=\{`Remove \$\{title\} from shared cart`\}/);
  assert.doesNotMatch(component, /!isMarketplace && <button/);
  assert.match(component, /removeConfirmation\?\.listingId === item\.listingId/);
  assert.match(component, /This also removes its saved details for everyone in your organization\./);
  assert.match(component, /ref=\{removeCancelRef\}[^>]*>Keep placement/);
  assert.match(component, /useLayoutEffect\(\(\) => \{ if \(removeConfirmation\) removeCancelRef\.current\?\.focus\(\); \}, \[removeConfirmation\]\)/);
  assert.match(component, /action: "remove", listingId, generationId: removeConfirmation\.generationId, version: removeConfirmation\.version/);
  assert.match(component, /removeConfirmation: \{ listingId: item\.listingId, generationId: item\.generationId, version: item\.version \}/);
  assert.match(component, /loading && items\.length === 0/);
  assert.match(component, /Updating saved placements…/);
  assert.match(component, /notice: currentItems \? result\.error \?\? "The shared cart changed\. Review the current placements and try again\." : ""/);
  assert.match(component, /notice && <p role="status"/);
  assert.match(styles, /\.cartDock \{ position: relative; z-index: 4; \}/);
  assert.match(styles, /\.cartItemRemoveButton svg/);
  assert.match(styles, /\.cartItemRemoveConfirmActions/);
});

test("shared detail inputs capture values before deferred state updates", async () => {
  const source = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  const start = source.indexOf('<details className="catalogCopyDetails">');
  const sharedDetails = source.slice(start, source.indexOf("</details>", start));

  for (const field of ["targetUrl", "anchorText", "instructions", "articleText", "writingBrief"]) {
    assert.match(sharedDetails, new RegExp(`updateSharedDetail\\("${field}", event\\.currentTarget\\.value\\)`));
  }
  assert.match(source, /function updateSharedDetail\(field: keyof typeof sharedDetails, value: string\)\s*\{\s*setSharedDetails\(current => \(\{ \.\.\.current, \[field\]: value \}\)\);\s*\}/);
  assert.doesNotMatch(sharedDetails, /setSharedDetails\(\(current\).*event\.currentTarget\.value/s);
});
test("marketplace selection drops a placement removed from the shared cart", async () => {
  const catalog = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  const cart = await readFile(new URL("../src/app/customer/customer-cart-button.tsx", import.meta.url), "utf8");

  assert.match(catalog, /detail\?\.action !== "remove"/);
  assert.match(catalog, /detail\.organizationId !== organizationId/);
  assert.match(catalog, /cartDirtyRef\.current\.delete\(listingId\)/);
  assert.match(catalog, /delete next\[listingId\]/);
  assert.match(catalog, /delete cartVersionsRef\.current\[listingId\]/);
  assert.match(cart, /detail: \{ action: "remove", organizationId, listingId \}/);
});
