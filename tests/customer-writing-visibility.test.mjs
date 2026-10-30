import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerOrderProjection } from "../src/modules/orders/checkout.ts";

const order = {
  id: "member-order", actorUserId: "member-orderer", customerStatus: "CONTENT_REVIEW", currency: "USD",
  placementTotalMinor: "10000", writingTotalMinor: "5000", totalMinor: "15000", createdAt: new Date("2026-10-28T00:00:00Z"),
  items: [{
    id: "writing-item", listingId: "listing", customerListingSnapshot: { title: "Placement" }, placementPriceMinor: "10000",
    writingSelected: true, writingPriceMinor: "5000", targetUrl: "https://customer.example.test/", anchorText: "Anchor",
    articleText: null, writingBrief: "Brief visible under order policy", customerStatus: "CONTENT_REVIEW",
    writingWorkflow: { state: "FIRST_DRAFT_READY", firstDraftText: "PRIVATE_MEMBER_DRAFT", revisionRequestText: null, finalDraftText: null, approvedArticleText: null },
  }],
};

test("shared-order Owner customer projection excludes another member's writing draft text and state even if staff RLS supplied them", () => {
  const owner = customerOrderProjection(order, "organization-owner");
  assert.equal(owner.isOrderer, false);
  assert.equal(owner.items[0].writingWorkflow, undefined);
  assert.equal(JSON.stringify(owner).includes("PRIVATE_MEMBER_DRAFT"), false);
  assert.equal(JSON.stringify(owner).includes("FIRST_DRAFT_READY"), false);
  const unknownViewer = customerOrderProjection(order);
  assert.equal(unknownViewer.items[0].writingWorkflow, undefined);
  const orderer = customerOrderProjection(order, "member-orderer");
  assert.equal(orderer.isOrderer, true);
  assert.equal(orderer.items[0].writingWorkflow.firstDraftText, "PRIVATE_MEMBER_DRAFT");
});

test("writing reads use only the current orderer's items before projection", () => {
  const source = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  assert.match(source, /rows\.filter\(\(order\) => order\.actorUserId === actor\.userId\)/);
  assert.match(source, /items\.filter\(\(item\) => ownOrderIds\.has\(item\.orderId\)\)/);
  assert.match(source, /inArray\(orderItemWriting\.orderItemId, writingItemIds\)/);
  assert.match(source, /customerOrderProjection\(\{ \.\.\.order, items: byOrder\.get\(order\.id\) \?\? \[\] \}, actor\.userId\)/);
});
