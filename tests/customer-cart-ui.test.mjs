import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("shared cart has an accessible, confirmed per-item remove control on every page", async () => {
  const component = await readFile(new URL("../src/app/customer/customer-cart-button.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/app/customer/customer.module.css", import.meta.url), "utf8");

  assert.match(component, /className=\{styles\.cartItemRemoveButton\}/);
  assert.match(component, /aria-label=\{`Remove \$\{title\} from shared cart`\}/);
  assert.doesNotMatch(component, /!isMarketplace && <button/);
  assert.match(component, /confirmRemoveListingId === item\.listingId/);
  assert.match(component, /This also removes its saved details for everyone in your organization\./);
  assert.match(component, /ref=\{removeCancelRef\}[^>]*>Keep placement/);
  assert.match(component, /useLayoutEffect\(\(\) => \{ if \(confirmRemoveListingId\) removeCancelRef\.current\?\.focus\(\); \}, \[confirmRemoveListingId\]\)/);
  assert.match(component, /action: "remove", listingId, generationId: item\.generationId, version: item\.version/);
  assert.match(component, /notice: currentItems \? result\.error \?\? "The shared cart changed\. Review the current placements and try again\." : ""/);
  assert.match(component, /notice && <p role="status"/);
  assert.match(styles, /\.cartDock \{ position: relative; z-index: 4; \}/);
  assert.match(styles, /\.cartItemRemoveButton svg/);
  assert.match(styles, /\.cartItemRemoveConfirmActions/);
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
