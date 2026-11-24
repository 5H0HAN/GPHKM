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
  assert.match(styles, /\.cartDock \{ position: relative; z-index: 4; \}/);
  assert.match(styles, /\.cartItemRemoveButton svg/);
  assert.match(styles, /\.cartItemRemoveConfirmActions/);
});
