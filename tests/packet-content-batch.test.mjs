import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolvePacketContentRows } from "../src/modules/orders/packet-content.ts";

test("packet content projection accepts only exact consent, current supplier/recipient, and accepted terms", () => {
  const at = new Date("2026-11-03T10:00:00Z");
  const version = (itemId, requestId, supplierId, recipientEmail, contentHash) => ({
    id: `v-${itemId}`, itemId, requestId, version: 4, targetUrl: "https://target.example/path",
    anchorText: "anchor", articleText: "approved body", instructions: "publish carefully",
    supplierId, recipientEmail, contentHash, noticeVersion: null, consentedAt: at,
  });
  const result = resolvePacketContentRows({
    itemIds: ["consented", "unresolved", "stale-supplier", "stale-recipient"],
    latestRequests: [
      { itemId: "consented", requestId: "request-consented" },
      { itemId: "unresolved", requestId: "request-unresolved" },
      { itemId: "stale-supplier", requestId: "request-stale-supplier" },
      { itemId: "stale-recipient", requestId: "request-stale-recipient" },
    ],
    routes: [
      { itemId: "consented", supplierId: "supplier-A", recipientEmail: "ops-a@example.test" },
      { itemId: "unresolved", supplierId: "supplier-A", recipientEmail: "ops-a@example.test" },
      { itemId: "stale-supplier", supplierId: "supplier-B", recipientEmail: "ops-a@example.test" },
      { itemId: "stale-recipient", supplierId: "supplier-A", recipientEmail: "new@example.test" },
    ],
    versions: [
      version("consented", "request-consented", "supplier-A", "ops-a@example.test", "hash-consented"),
      version("unresolved", "request-unresolved", "supplier-A", "ops-a@example.test", "hash-unresolved"),
      version("stale-supplier", "request-stale-supplier", "supplier-A", "ops-a@example.test", "hash-stale-supplier"),
      version("stale-recipient", "request-stale-recipient", "supplier-A", "old@example.test", "hash-stale-recipient"),
    ],
    latestEvents: [
      { requestId: "request-consented", eventType: "CONSENTED", versionId: "v-consented", contentHash: "hash-consented", noticeVersion: "notice-1", createdAt: at },
      { requestId: "request-unresolved", eventType: "REQUESTED", versionId: null, contentHash: null, noticeVersion: null, createdAt: at },
      { requestId: "request-stale-supplier", eventType: "CONSENTED", versionId: "v-stale-supplier", contentHash: "hash-stale-supplier", noticeVersion: "notice-1", createdAt: at },
      { requestId: "request-stale-recipient", eventType: "CONSENTED", versionId: "v-stale-recipient", contentHash: "hash-stale-recipient", noticeVersion: "notice-1", createdAt: at },
    ],
    declinedRequestIds: [],
    acceptedTerms: [{ requestId: "request-consented", contentHash: "hash-consented", terms: { title: "Accepted equivalent" } }],
  });
  assert.equal(result.get("consented").error, undefined);
  assert.equal(result.get("consented").content.supplierId, "supplier-A");
  assert.deepEqual(result.get("consented").content.listingTerms, { title: "Accepted equivalent" });
  assert.match(result.get("unresolved").error.message, /latest customer content change is resolved/);
  assert.match(result.get("stale-supplier").error.message, /exact approved content and recipient/);
  assert.match(result.get("stale-recipient").error.message, /exact approved content and recipient/);
});

test("accepted equivalent terms attach only when the accepted content hash matches the consent", () => {
  const at = new Date("2026-11-03T10:00:00Z");
  const result = resolvePacketContentRows({
    itemIds: ["item"], latestRequests: [{ itemId: "item", requestId: "request" }],
    routes: [{ itemId: "item", supplierId: "supplier-A", recipientEmail: "ops@example.test" }],
    versions: [{ id: "version", itemId: "item", requestId: "request", version: 2, targetUrl: "https://target.example", anchorText: "a", articleText: null, instructions: null, supplierId: "supplier-A", recipientEmail: "ops@example.test", contentHash: "consented-hash", noticeVersion: null, consentedAt: at }],
    latestEvents: [{ requestId: "request", eventType: "CONSENTED", versionId: "version", contentHash: "consented-hash", noticeVersion: "notice-1", createdAt: at }],
    declinedRequestIds: [], acceptedTerms: [{ requestId: "request", contentHash: "different-hash", terms: { title: "Stale terms" } }],
  });
  assert.equal(result.get("item").error, undefined);
  assert.equal(Object.hasOwn(result.get("item").content, "listingTerms"), false);
});

test("packet consent resolution stays bounded for 25 items and 50 versions each", async () => {
  const contentService = await readFile(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  const start = contentService.indexOf("export async function getConsentedSupplierPacketContentBatch");
  const end = contentService.indexOf("\n}\n", start) + 2;
  const resolver = contentService.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(contentService, /const MAX_PACKET_CONTENT_VERSIONS_PER_ITEM = 50/);
  assert.match(resolver, /row_number\(\) over \(partition by[\s\S]*order by[\s\S]*version[\s\S]*desc\)/);
  assert.match(resolver, /where\(lte\(rankedVersions\.rowNumber, MAX_PACKET_CONTENT_VERSIONS_PER_ITEM\)\)/);
  assert.match(resolver, /selectDistinctOn\(\[orderItemContentChangeEvent\.requestId\]/);
  assert.match(resolver, /resolvePacketContentRows\(/);
  assert.match(resolver, /selectedVersionHashes/);

  const queryPlan = resolver.replace(/const rankedVersions = tx\.select\([\s\S]*?\.as\("ranked_packet_content_versions"\);/, "");
  const queryCalls = queryPlan.match(/tx\.select(?:DistinctOn)?\(/g) ?? [];
  assert.equal(queryCalls.length, 6, "the batch SQL performs a fixed maximum of six database reads, independent of item/version count");
  assert.doesNotMatch(resolver, /for \(const[\s\S]{0,700}?await tx\./, "no per-item or per-version database query loop is allowed");
  const itemIds = Array.from({ length: 25 }, (_, index) => `item-${index}`);
  const latestRequests = itemIds.map((itemId) => ({ itemId, requestId: `request-${itemId}` }));
  const routes = itemIds.map((itemId) => ({ itemId, supplierId: "supplier-A", recipientEmail: "current@example.test" }));
  const versions = itemIds.flatMap((itemId) => Array.from({ length: 50 }, (_, index) => ({
    id: `version-${itemId}-${index + 1}`, itemId, requestId: `request-${itemId}`, version: index + 1,
    targetUrl: "https://target.example/", anchorText: "approved anchor", articleText: "approved article",
    instructions: "", supplierId: "supplier-A", recipientEmail: "current@example.test",
    contentHash: `hash-${itemId}-${index + 1}`, noticeVersion: null, consentedAt: new Date("2026-11-03T10:00:00Z"),
  })));
  const latestEvents = itemIds.map((itemId) => ({
    requestId: `request-${itemId}`, eventType: "CONSENTED", versionId: `version-${itemId}-50`,
    contentHash: `hash-${itemId}-50`, noticeVersion: "notice-v1", createdAt: new Date("2026-11-03T10:00:00Z"),
  }));
  assert.equal(versions.length, 1250, "fixture contains the maximum 25 items × 50 candidate versions");
  const projected = resolvePacketContentRows({ itemIds, latestRequests, routes, versions, latestEvents, declinedRequestIds: [], acceptedTerms: [] });
  assert.equal(projected.size, 25);
  assert.ok(itemIds.every((itemId) => projected.get(itemId)?.content?.version === 50),
    "the projection resolves every item from its latest consented version after receiving the maximum bounded candidate set");

  const packetService = await readFile(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  const [candidateStart, prepareStart, currentPacketStart] = [
    packetService.indexOf("export async function listPacketCandidates"),
    packetService.indexOf("export async function prepareSupplierPackets"),
    packetService.indexOf("async function loadCurrentPacket"),
  ];
  assert.match(packetService.slice(candidateStart, prepareStart), /getConsentedSupplierPacketContentBatch\(/);
  assert.match(packetService.slice(prepareStart, currentPacketStart), /getConsentedSupplierPacketContentBatch\(/);
  assert.match(packetService.slice(currentPacketStart, packetService.indexOf("function resendConfig", currentPacketStart)), /getConsentedSupplierPacketContentBatch\(/);
  assert.doesNotMatch(packetService, /getConsentedSupplierPacketContent\(tx/);
  assert.match(packetService, /offer\.order_item_id = public\.supplier_fulfillment_outcome\.order_item_id[\s\S]*offer\.support_case_id = public\.supplier_fulfillment_outcome\.support_case_id/,
    "the nested failure-route check qualifies its outer columns so inner offer columns cannot shadow them");
});
