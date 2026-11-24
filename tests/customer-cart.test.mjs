import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateCustomerCartDraft } from "../src/modules/orders/cart.ts";

test("cart accepts unfinished placement details without treating them as checkout consent", () => {
  const result = validateCustomerCartDraft({
    targetUrl: "https://example.org/page",
    anchorText: "",
    instructions: "",
    articleText: "Draft article",
    writingBrief: "",
    useWriting: false,
  });
  assert.deepEqual(result, {
    targetUrl: "https://example.org/page",
    anchorText: "",
    instructions: "",
    articleText: "Draft article",
    writingBrief: "",
    useWriting: false,
  });
  assert.equal(validateCustomerCartDraft({ articleText: "First line\nSecond line" }).articleText, "First line\nSecond line");
  assert.equal(validateCustomerCartDraft({ targetUrl: " https://example.org/page " }).targetUrl, "https://example.org/page");
  assert.throws(() => validateCustomerCartDraft({ targetUrl: "https://example.org/a b" }), /cart details/);
});

test("cart draft validation rejects unsafe or oversized customer text", () => {
  assert.throws(() => validateCustomerCartDraft({ articleText: "bad\u0000text" }), /cart details/);
  assert.throws(() => validateCustomerCartDraft({ articleText: "a".repeat(20_001) }), /cart details/);
  assert.throws(() => validateCustomerCartDraft({ targetUrl: "javascript:alert(1)" }), /cart details/);
  assert.throws(() => validateCustomerCartDraft({ targetUrl: "https://user:pass@example.org" }), /cart details/);
  assert.throws(() => validateCustomerCartDraft({ unexpected: "value" }), /cart details/);
});

test("cart storage is organization-scoped with database-enforced active-member RLS", async () => {
  const migration = await readFile(new URL("../src/db/migrations/0202_customer_organization_cart.sql", import.meta.url), "utf8");
  const listingRetentionMigration = await readFile(new URL("../src/db/migrations/0205_protect_customer_cart_listing_deletion.sql", import.meta.url), "utf8");
  const generationMigration = await readFile(new URL("../src/db/migrations/0206_customer_cart_generation_tokens.sql", import.meta.url), "utf8");
  const schema = await readFile(new URL("../src/db/cart-schema.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/server/orders/cart.ts", import.meta.url), "utf8");
  assert.match(schema, /primaryKey\(\{ columns: \[table\.organizationId, table\.listingId\] \}\)/);
  assert.match(schema, /\.enableRLS\(\)/);
  assert.match(migration, /gphkm_is_active_org_member/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.customer_cart_item TO gphkm_runtime/);
  assert.match(listingRetentionMigration, /ON DELETE restrict/);
  assert.match(service, /withProtectedOrganizationContext/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /version/);
  assert.match(schema, /generationId: uuid\("generation_id"\)/);
  assert.match(generationMigration, /ADD COLUMN "generation_id" uuid DEFAULT gen_random_uuid\(\) NOT NULL/i);
});

test("checkout clears the saved organization cart in the successful order transaction", async () => {
  const checkout = await readFile(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const cartService = await readFile(new URL("../src/server/orders/cart.ts", import.meta.url), "utf8");
  const finalize = checkout.indexOf("gphkm_finalize_order_checkout");
  const clear = checkout.lastIndexOf("clearCheckedOutCustomerCartItems");
  assert.ok(clear > finalize);
  assert.match(cartService, /eq\(customerCartItem\.version, token\.version\)/);
  assert.match(cartService, /eq\(customerCartItem\.generationId, token\.generationId\)/);
  assert.match(cartService, /deleted\.rowCount !== 1/);
  assert.match(checkout, /parseCartVersions\(rawCartVersions, input\.items\)/);
  assert.doesNotMatch(checkout, /rawCartVersions\?: unknown/);
  assert.match(checkout, /savedRows\.length < input\.items\.length/);
  assert.match(checkout, /input\.items\.map\(\(item\) => item\.listingId\), cartVersions\)/);
});

test("cart accepts updated terms for off-page saved listings and protects pending saves on full-page exit", async () => {
  const catalog = await readFile(new URL("../src/app/customer/catalog-browser.tsx", import.meta.url), "utf8");
  assert.match(catalog, /listings\.find\(\(item\) => item\.id === listingId\) \?\? selectedRef\.current\[listingId\]\?\.listing/);
  assert.doesNotMatch(catalog, /keepalive:\s*true/);
  assert.match(catalog, /beforeunload/);
  assert.match(catalog, /!cartDirtyRef\.current\.size && !cartSavingRef\.current\.size/);
  assert.match(catalog, /generationId: token\.generationId/);
  assert.match(catalog, /generationId: result\.generationId/);
  assert.match(catalog, /await cartSavingRef\.current\.get\(listingId\)/);
});
