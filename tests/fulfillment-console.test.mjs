import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  customerSafeFulfillmentProjection,
  contentReviewReasonOptions,
  fulfillmentFollowUpUpdate,
  fulfillmentTransitionChoices,
  customerStatusForMilestone,
  isFulfillmentOverdue,
  mayAssignFulfillment,
  mayReadFulfillmentContent,
  validateNextUpdate,
  validatePublicationUrl,
} from "../src/modules/fulfillment/console.ts";

test("fulfillment item content is assigned-Admin scoped and Super Admin access is explicit", () => {
  assert.equal(mayReadFulfillmentContent({ role: "ADMIN", userId: "admin-1", assignedAdminId: "admin-1" }), true);
  assert.equal(mayReadFulfillmentContent({ role: "ADMIN", userId: "admin-2", assignedAdminId: "admin-1" }), false);
  assert.equal(mayReadFulfillmentContent({ role: "SUPER_ADMIN", userId: "root", assignedAdminId: null }), true);
  assert.equal(mayReadFulfillmentContent({ role: "FINANCE", userId: "finance", assignedAdminId: "finance" }), false);
  assert.equal(mayAssignFulfillment("ADMIN"), true);
  assert.equal(mayAssignFulfillment("SUPER_ADMIN"), true);
  assert.equal(mayAssignFulfillment("FINANCE"), false);
});

test("customer milestone projection allowlists only customer-safe fields", () => {
  const projection = customerSafeFulfillmentProjection({
    id: "item-1", customerStatus: "IN_PROGRESS", updatedAt: new Date("2026-10-28T08:00:00.000Z"),
    nextUpdateAt: new Date("2026-10-29T12:00:00.000Z"),
    supplierId: "private-supplier", assignedAdminId: "staff-user", sourceCost: 900,
  });
  assert.deepEqual(projection, {
    id: "item-1", status: "IN_PROGRESS", lastUpdatedAt: "2026-10-28T08:00:00.000Z", nextUpdateAt: "2026-10-29T12:00:00.000Z",
  });
  assert.equal(customerStatusForMilestone("COMPLETE_RESOLVED", "CANCELED_REFUNDED"), "RESOLVED");
  assert.equal(customerStatusForMilestone("COMPLETE_RESOLVED", "COMPLETED"), "COMPLETE");
});

test("manual publication evidence URL and next-update date reject unsafe or malformed input", () => {
  assert.equal(validatePublicationUrl("https://publisher.example/post/1"), "https://publisher.example/post/1");
  assert.throws(() => validatePublicationUrl("javascript:alert(1)"), /valid live publication URL/);
  assert.throws(() => validatePublicationUrl("https://user:pass@publisher.example/post"), /valid live publication URL/);
  const now = new Date("2026-10-28T00:00:00.000Z");
  assert.equal(validateNextUpdate("2026-10-29", now).toISOString(), "2026-10-29T12:00:00.000Z");
  assert.throws(() => validateNextUpdate("2026-10-27", now), /next year/);
  assert.throws(() => validateNextUpdate("not-a-date", now), /next-update date/);
});

test("overdue staff follow-ups exclude missing dates and terminal items", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");
  assert.equal(isFulfillmentOverdue(new Date("2026-10-29T11:59:59.000Z"), "IN_FULFILLMENT", now), true);
  assert.equal(isFulfillmentOverdue(now, "COMPLETED", now), false);
  assert.equal(isFulfillmentOverdue(now, "CANCELED_REFUNDED", now), false);
  assert.equal(isFulfillmentOverdue(null, "IN_FULFILLMENT", now), false);
  assert.equal(isFulfillmentOverdue(new Date("2026-10-29T12:00:01.000Z"), "IN_FULFILLMENT", now), false);
});


test("follow-up updates change only dates with an assigned Admin or Super Admin and approved reason", () => {
  const now = new Date("2026-10-28T00:00:00.000Z");
  const input = { role: "ADMIN", userId: "admin-1", assignedAdminId: "admin-1", state: "ON_HOLD", nextUpdateAt: "2026-10-29", reasonCode: "PUBLICATION_UPDATE" };
  for (const state of ["CONFIRMED", "ON_HOLD", "CANCELLATION_REQUESTED", "IN_FULFILLMENT", "EVIDENCE_REVIEW"]) {
    assert.deepEqual(fulfillmentFollowUpUpdate({ ...input, state }, now), { nextUpdateAt: new Date("2026-10-29T12:00:00.000Z"), updatedAt: now });
  }
  assert.doesNotThrow(() => fulfillmentFollowUpUpdate({ ...input, role: "SUPER_ADMIN", assignedAdminId: null }, now));
  for (const change of [{ userId: "other" }, { role: "FINANCE" }, { assignedAdminId: null }, { state: "COMPLETED" }, { state: "CANCELED_REFUNDED" }, { reasonCode: "" }, { reasonCode: "free-text" }, { nextUpdateAt: "" }, { nextUpdateAt: "2026-10-27" }, { nextUpdateAt: "2027-02-30" }, { nextUpdateAt: "2028-01-01" }]) {
    assert.throws(() => fulfillmentFollowUpUpdate({ ...input, ...change }, now));
  }
});

test("hold-resume choices include only the saved active state and preserve supplier delivery restrictions", () => {
  for (const state of ["CONFIRMED", "CONTENT_PREPARATION", "AWAITING_CUSTOMER_APPROVAL", "READY_FOR_HANDOFF", "HANDOFF_PENDING", "IN_FULFILLMENT", "PUBLICATION_PENDING", "EVIDENCE_REVIEW"]) {
    assert.deepEqual(fulfillmentTransitionChoices("ON_HOLD", state, true).map((choice) => choice.value), [state]);
  }
  assert.deepEqual(fulfillmentTransitionChoices("ON_HOLD", null, false), []);
  assert.deepEqual(fulfillmentTransitionChoices("ON_HOLD", "COMPLETED", false), []);
  assert.equal(fulfillmentTransitionChoices("READY_FOR_HANDOFF", null, true).some((choice) => choice.value === "IN_FULFILLMENT"), false);
  assert.equal(fulfillmentTransitionChoices("READY_FOR_HANDOFF", null, false).some((choice) => choice.value === "IN_FULFILLMENT"), true);
});

test("unapproved GPHKM Writing cannot be marked ready or handed to placement", () => {
  const blocked = fulfillmentTransitionChoices("AWAITING_CUSTOMER_APPROVAL", null, true, false).map(({ value }) => value);
  assert.deepEqual(blocked, ["CONTENT_PREPARATION", "ON_HOLD"]);
  assert.ok(fulfillmentTransitionChoices("AWAITING_CUSTOMER_APPROVAL", null, true, true).some(({ value }) => value === "READY_FOR_HANDOFF"));
  assert.deepEqual(contentReviewReasonOptions.map(({ value }) => value), [
    "CONTENT_ILLEGAL_ABUSIVE", "CONTENT_PHISHING_MALWARE", "CONTENT_RIGHTS_UNCONFIRMED", "CONTENT_LISTING_REQUIREMENT", "CONTENT_SENSITIVE_TOPIC",
  ]);
});

test("follow-up command authenticates, locks the item, applies the validated date patch and appends audit atomically", () => {
  const source = readFileSync(new URL("../src/server/fulfillment/admin.ts", import.meta.url), "utf8");
  const command = source.slice(source.indexOf("export async function updateFulfillmentFollowUp("), source.indexOf("export async function updateFulfillmentState("));
  assert.match(source, /requireStaffAccess\(headers, "fulfillment.manage"\)/);
  assert.match(source, /set_config\('app.user_id'/);
  assert.match(command, /return staffTx\(headers/);
  assert.match(command, /for\("update"\)/);
  assert.match(command, /fulfillmentFollowUpUpdate\(\{ \.\.\.input, \.\.\.actor, assignedAdminId: fulfillment.assignedAdminId, state: fulfillment.state \}\)/);
  assert.match(command, /tx.update\(orderItemFulfillment\).set\(update\)/);
  assert.match(command, /appendAuditEvent\(tx/);
  assert.match(command, /FULFILLMENT_FOLLOW_UP_CHANGED/);
  assert.match(command, /reasonCode: input.reasonCode/);
  assert.doesNotMatch(command, /transitionItem|customerStatus:|state: input/);
});
