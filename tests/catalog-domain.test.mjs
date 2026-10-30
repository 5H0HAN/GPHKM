import assert from "node:assert/strict";
import test from "node:test";

const catalog = await import("../src/modules/catalog/domain.ts");
const { LISTING_CATEGORY_NAMES } = await import("../src/modules/catalog/taxonomy.ts");

const listing = {
  id: "listing-1", revision: 3, status: "LIVE", commercialSource: "SUPPLIER_SOURCED", supplierId: "supplier-secret",
  fulfillmentSupplierId: "supplier-secret", sourceCostCents: 7000, urlVisibleWithoutRecharge: false,
  title: "Technology site", description: "A reviewed placement", websiteUrl: "https://example.com/",
  countryCode: "US", primaryLanguage: "English", categories: ["Technology & Gadgets"], retailPriceCents: 12000,
  linkType: "DOFOLLOW", linkValidity: "PERMANENT", turnaroundDays: 14, allowsSportsAndGaming: false,
  allowsPharmacy: false, allowsCrypto: false, allowsForeignLanguage: false, sponsoredContentMarking: true,
  writingEnabled: true, writingPriceCents: 3000, writingTurnaroundDays: 5, writingFirstDraftCents: 1000,
  writingFinalDraftCents: 2000, buyerRequirements: null, metrics: [
    { provider: "OPEN_PAGE_RANK", metricScope: "REGISTERED_DOMAIN", value: 0, status: "AVAILABLE", observedOn: "2026-10-28", source: "provider", redistributionApproved: true, attributionText: "Open PageRank" },
    { provider: "OPEN_PAGE_RANK", metricScope: "HOST", value: 7.25, status: "AVAILABLE", observedOn: "2026-10-28", source: "provider", redistributionApproved: true, attributionText: "Open PageRank" },
    { provider: "MOZ_DA", value: 40, status: "AVAILABLE", observedOn: "2026-10-28", source: "private", redistributionApproved: false, attributionText: null },
  ], createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
};

test("customer projection is explicit and withholds URLs without access", () => {
  const result = catalog.toCustomerListing(listing, { canBrowse: true, hasHiddenUrlAccess: false });
  assert.ok(result);
  assert.equal("websiteUrl" in result, false);
  assert.equal("supplierId" in result, false);
  assert.equal("commercialSource" in result, false);
  assert.equal("sourceCostCents" in result, false);
  assert.deepEqual(result.metrics.map((metric) => [metric.provider, metric.metricScope]), [
    ["OPEN_PAGE_RANK", "REGISTERED_DOMAIN"], ["OPEN_PAGE_RANK", "HOST"],
  ]);
  assert.equal(result.metrics[0].value, 0);
  assert.equal(result.metrics[0].metricScope, "REGISTERED_DOMAIN");
  assert.equal(result.metrics[1].value, 7.25);
  assert.equal(catalog.toCustomerListing(listing, { canBrowse: false, hasHiddenUrlAccess: true }), null);
  assert.equal(catalog.toCustomerListing({ ...listing, urlVisibleWithoutRecharge: true }, { canBrowse: true, hasHiddenUrlAccess: false }).websiteUrl, listing.websiteUrl);
});

test("catalog role policy excludes Finance management and Admin source costs", () => {
  assert.equal(catalog.canManageCatalog("ADMIN"), true);
  assert.equal(catalog.canManageCatalog("FINANCE"), false);
  assert.equal(catalog.canManageCatalog("SUPER_ADMIN"), true);
  assert.equal(catalog.toInternalListingProjection(listing, "ADMIN").sourceCostCents, undefined);
  assert.equal(catalog.toInternalListingProjection(listing, "FINANCE"), null);
  assert.equal(catalog.toInternalListingProjection(listing, "SUPER_ADMIN").sourceCostCents, 7000);
  assert.deepEqual(catalog.toFinanceCostProjection(listing, "FINANCE"), {
    listingId: "listing-1", revision: 3, retailPriceCents: 12000, sourceCostCents: 7000,
  });
  assert.equal(catalog.toSupplierProjection({ id: "s", name: "Private", contactName: null, email: "a@example.com", phone: null, notes: null, active: true, createdAt: "now", updatedAt: "now" }, "FINANCE"), null);
});

test("listing terms require exact money, relation, legal topic flags, and writing-stage totals", () => {
  const valid = { ...listing };
  assert.deepEqual(catalog.validateListingTerms(valid), []);
  assert.ok(catalog.validateListingTerms({ ...valid, categories: LISTING_CATEGORY_NAMES.slice(0, 8) }).some((error) => error.field === "categories"));
  assert.ok(catalog.validateListingTerms({ ...valid, websiteUrl: "http://example.com" }).some((error) => error.code === "INVALID_HTTPS_ORIGIN"));
  assert.ok(catalog.validateListingTerms({ ...valid, retailPriceCents: 1.25 }).some((error) => error.field === "retailPriceCents"));
  assert.ok(catalog.validateListingTerms({ ...valid, writingFirstDraftCents: 1500 }).some((error) => error.code === "WRITING_STAGES_MUST_EQUAL_PRICE"));
  assert.ok(catalog.validatePublishableListing({ ...valid, allowsCrypto: null }).some((error) => error.code === "TOPIC_FLAGS_MUST_BE_REVIEWED"));
  assert.ok(catalog.validatePublishableListing({ ...valid, title: "example.com" }).some((error) => error.code === "HIDDEN_WEBSITE_ADDRESS_IN_BUYER_COPY"));
  assert.equal(catalog.containsWebsiteAddress("More info: publisher.net"), true);
  assert.deepEqual(catalog.validatePublishableListing({ ...valid, urlVisibleWithoutRecharge: true, title: "example.com" }), []);
  assert.equal(catalog.toCustomerListing({ ...valid, allowsCrypto: null }, { canBrowse: true, hasHiddenUrlAccess: true }), null);
});

test("supplier-sourced listings use one supplier for source and fulfillment", () => {
  assert.ok(catalog.validateListingRelationships("SUPPLIER_SOURCED", "supplier-a", null).some((error) => error.code === "FULFILLMENT_SUPPLIER_REQUIRED"));
  assert.deepEqual(catalog.validateListingRelationships("SUPPLIER_SOURCED", "supplier-a", "supplier-a"), []);
  assert.ok(catalog.validateListingRelationships("SUPPLIER_SOURCED", "supplier-a", "supplier-b").some((error) => error.code === "SUPPLIER_MISMATCH"));
  assert.deepEqual(catalog.validateListingRelationships("PLATFORM_OWNED", null, "supplier-b"), []);
  assert.ok(catalog.validatePublishableListing({ ...listing, fulfillmentSupplierId: null }).some((error) => error.code === "FULFILLMENT_SUPPLIER_REQUIRED"));
});

test("lifecycle transitions and purchase snapshots are explicit", () => {
  assert.equal(catalog.canTransitionListing("DRAFT", "REVIEW", "ADMIN"), true);
  assert.equal(catalog.canTransitionListing("DRAFT", "LIVE", "SUPER_ADMIN"), false);
  assert.equal(catalog.canTransitionListing("LIVE", "PAUSED", "FINANCE"), false);
  const snapshot = catalog.makeListingSnapshot(listing);
  assert.equal(snapshot.revision, listing.revision);
  assert.equal("sourceCostCents" in snapshot, false);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("supplier contacts require bounded safe fields and valid email", () => {
  assert.deepEqual(catalog.validateSupplierInput({ name: "Example Media", email: "ops@example.com", phone: null, contactName: null, notes: null }), []);
  assert.ok(catalog.validateSupplierInput({ name: "", email: "not-an-email\r\nBcc: x@example.test", phone: null, contactName: null, notes: null }).length >= 2);
});
