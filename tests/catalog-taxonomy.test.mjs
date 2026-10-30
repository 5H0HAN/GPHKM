import assert from "node:assert/strict";
import test from "node:test";

const { isValidListingCategorySelection, LISTING_CATEGORY_LIMIT, LISTING_CATEGORY_NAMES } =
  await import("../src/modules/catalog/taxonomy.ts");

test("category vocabulary and seven-category selection are enforced", () => {
  assert.equal(LISTING_CATEGORY_NAMES.length, 87);
  assert.equal(LISTING_CATEGORY_LIMIT, 7);
  assert.equal(isValidListingCategorySelection(["Business"]), true);
  assert.equal(isValidListingCategorySelection(LISTING_CATEGORY_NAMES.slice(0, 7)), true);
  assert.equal(isValidListingCategorySelection([]), false);
  assert.equal(isValidListingCategorySelection(LISTING_CATEGORY_NAMES.slice(0, 8)), false);
  assert.equal(isValidListingCategorySelection(["Business", "Business"]), false);
  assert.equal(isValidListingCategorySelection(["Unlisted category"]), false);
  assert.equal(isValidListingCategorySelection(null), false);
});
