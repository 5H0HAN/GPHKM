import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  customerSafeFulfillmentProjection,
  customerOrderStages,
  customerStageSummary,
  contentReviewReasonOptions,
  customerStatusForFulfillmentTransition,
  fulfillmentReasonCodeForTransition,
  fulfillmentStateLabel,
  fulfillmentTransitionGuidance,
  fulfillmentFollowUpUpdate,
  fulfillmentTransitionChoices,
  customerStatusForMilestone,
  isFulfillmentOverdue,
  mayAssignFulfillment,
  mayReadFulfillmentContent,
  maximumNextUpdateDate,
  minimumNextUpdateDate,
  nextUpdateDateInputValue,
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
  assert.equal(customerStatusForMilestone("ORDER_RECEIVED", "CONFIRMED"), "ORDER_RECEIVED");
  assert.equal(customerStatusForMilestone("CONTENT_REVIEW", "CONTENT_PREPARATION"), "CONTENT_REVIEW");
  assert.equal(customerStatusForMilestone("PREPARING_YOUR_PLACEMENT", "HANDOFF_PENDING"), "PREPARING");
  assert.equal(customerStatusForMilestone("PUBLICATION_IN_PROGRESS", "IN_FULFILLMENT"), "IN_PROGRESS");
  assert.equal(customerStatusForMilestone("LINK_VERIFICATION", "EVIDENCE_REVIEW"), "LINK_VERIFICATION");
  assert.equal(customerStatusForFulfillmentTransition("PREPARING_YOUR_PLACEMENT", "ON_HOLD", "CONTENT_REVIEW"), "CONTENT_REVIEW");
  assert.equal(customerStatusForFulfillmentTransition("PREPARING_YOUR_PLACEMENT", "ON_HOLD", "ORDER_RECEIVED"), "ORDER_RECEIVED");
});

test("customer order stages share one ordered label set and keep resolved separate from complete", () => {
  assert.deepEqual(customerOrderStages, [
    ["ORDER_RECEIVED", "Order received"],
    ["CONTENT_REVIEW", "Content review"],
    ["PREPARING", "Preparing your placement"],
    ["IN_PROGRESS", "Publication in progress"],
    ["LINK_VERIFICATION", "Link verification"],
    ["COMPLETE", "Complete"],
  ]);
  for (const [index, [status, label]] of customerOrderStages.entries()) {
    assert.deepEqual(customerStageSummary(status), {
      index, label, stageNumber: index + 1, totalStages: 6, resolved: false,
    });
  }
  assert.deepEqual(customerStageSummary("RESOLVED"), {
    index: -1, label: "Resolved", stageNumber: null, totalStages: 6, resolved: true,
  });
  assert.equal(customerStageSummary("UNRECOGNIZED").stageNumber, null);
  assert.equal(customerStageSummary("UNRECOGNIZED").label, "Status unavailable");
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

test("fulfillment detail distinguishes unavailable items from recoverable post-action read errors", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/page.tsx", import.meta.url), "utf8");
  const loader = page.slice(page.indexOf("try { result = await getFulfillmentItem"), page.indexOf("const contentChanges"));
  assert.match(loader, /error\.message === "Forbidden"\) return/);
  assert.match(loader, /error\.message === "Item unavailable"\) notFound\(\)/);
  assert.match(loader, /logSafeFailure\("fulfillment_item_load_failed"/);
  assert.match(loader, /Your previous action may already have completed/);
  assert.doesNotMatch(loader, /redirect\("\/staff(?:\/sign-in)?"\)/);
  assert.doesNotMatch(loader, /catch \{ notFound\(\)/);
});

test("packet detail keeps unexpected post-action read failures retryable without hiding authorization boundaries", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  const loader = page.slice(page.indexOf("try { data = await getSupplierPacket"), page.indexOf("const { packet, attempts"));
  assert.match(loader, /error\.message === "Unauthorized"\) redirect\("\/staff\/sign-in"\)/,
    "an expired or missing staff session follows the normal sign-in path instead of being logged as a packet failure");
  assert.match(loader, /\["Forbidden", "Packet unavailable"\]\.includes\(error\.message\)\) notFound\(\)/);
  assert.match(loader, /logSafeFailure\("supplier_packet_preview_failed"/);
  assert.match(loader, /Your previous action may already have completed/);
  assert.doesNotMatch(loader, /catch \{[^}]*notFound\(\)/);
});

test("historical supplier packets remain reviewable when live order eligibility changes", async () => {
  const service = readFileSync(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  const detail = service.slice(service.indexOf("export async function getSupplierPacket"), service.indexOf("export async function recordSupplierAcknowledgement"));
  const current = service.slice(service.indexOf("async function loadCurrentPacket"), service.indexOf("function resendConfig"));
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  assert.match(detail, /catch \(error\)[\s\S]*error instanceof StaleSupplierPacketSnapshotError[\s\S]*packet = jsonPacket\(row\.packet\)[\s\S]*staleSnapshot = true/);
  assert.match(detail, /if \(!\(error instanceof StaleSupplierPacketSnapshotError\)\) throw error/,
    "database and operational errors still fail visibly instead of being mislabeled as stale history");
  assert.match(current, /resolution\?\.error\) throw new StaleSupplierPacketSnapshotError/);
  assert.match(current, /Packet item is no longer eligible for a new handoff/);
  assert.match(current, /if \(!article\) throw new StaleSupplierPacketSnapshotError/);
  assert.match(page, /Historical supplier packet[\s\S]*saved contents remain available for review and reconciliation/);
});

test("packet resend UI enforces its required reason and warns before duplicating an accepted send", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/actions.ts", import.meta.url), "utf8");
  assert.match(page, /const latestProviderAttempt = attempts\.find\(\(attempt\) => attempt\.type === "SEND"\)/);
  assert.match(page, /const priorSendExists = attempts\.some/);
  assert.match(page, /Reason for resending \(required\)[\s\S]*required=\{priorSendExists\}/);
  assert.match(actions, /error\.message === "A prior send exists; an audited deliberate resend reason is required" \? "resend-reason"/);
  assert.match(page, /latest\.error === "resend-reason"[\s\S]*Before sending again, check its delivery status/);
  assert.match(page, /A previous send was accepted by the provider\. Check its delivery status before trying again/);
  assert.match(page, /Check Resend delivery status or the reconciliation queue before deciding whether to resend/);
  assert.match(page, /The provider may still deliver its copy, so a duplicate is possible\. GPHKM keeps both attempts in history/);
  assert.match(page, /Start manual email handoff/);
});

test("manual-send confirmation errors preserve the reservation and explain safe recovery", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  const field = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/device-time-field.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/staff/fulfillment/packets/[packetId]/manual/route.ts", import.meta.url), "utf8");
  assert.match(page, /latest\.error === "manual" \? <p[\s\S]*GPHKM could not record the manual send, and its reservation is still open/);
  assert.match(page, /latest\.error === "manual-failed" \? <p[\s\S]*could not confirm whether the manual handoff was recorded[\s\S]*email may already have been sent/);
  assert.match(page, /Do not send this packet again while the outcome is unclear/);
  assert.match(page, /Refresh and check Attempt history before taking another action/);
  assert.match(field, /Use the actual time the email was sent/);
  assert.match(field, /after the reservation began/);
  assert.match(page, /Use a reference from the sent message, such as its Message-ID\. Do not invent one\./);
  assert.match(page, /latest\.error === "manual-time"/);
  assert.match(page, /latest\.error === "manual-recipient"/);
  assert.match(page, /latest\.error === "manual-evidence"/);
  assert.match(route, /function manualFailureResult\(error: unknown\)/);
  assert.match(route, /case "Enter the actual sent time with its timezone after beginning the handoff": return "manual-time"/);
  assert.match(route, /if \(!\(error instanceof Error\)\) return "manual-failed"/);
  assert.match(route, /default: return "manual-failed"/);
  assert.match(route, /!Number\.isSafeInteger\(length\) \|\| length < 1\) return redirectToPacket\(packetId, "manual-failed"\)/);
  assert.doesNotMatch(route, /return redirectToPacket\(packetId, `error=\$\{error\.message\}`\)/);
});

test("device timestamp pattern is valid HTML regex and requires a timezone", () => {
  const field = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/device-time-field.tsx", import.meta.url), "utf8");
  const source = field.match(/const SENT_TIME_PATTERN = "([^"]+)";/)?.[1];
  assert.ok(source, "the input exposes its ISO timestamp pattern");
  const pattern = new RegExp(`^(?:${source})$`, "v");
  assert.equal(pattern.test("2026-11-10T14:30:00+06:00"), true);
  assert.equal(pattern.test("2026-11-10T14:30:00-05:00"), true);
  assert.equal(pattern.test("2026-11-10T14:30:00Z"), true);
  assert.equal(pattern.test("2026-11-10T14:30:00"), false);
});

test("customer history keeps approved writing and cancellation outcomes read-only", () => {
  const view = readFileSync(new URL("../src/app/customer/orders/orders-view.tsx", import.meta.url), "utf8");
  const cancellation = readFileSync(new URL("../src/app/customer/orders/cancellation-form.tsx", import.meta.url), "utf8");
  const orderService = readFileSync(new URL("../src/server/orders/checkout.ts", import.meta.url), "utf8");
  const projection = readFileSync(new URL("../src/modules/orders/checkout.ts", import.meta.url), "utf8");
  assert.match(view, /!canManagePlacement && item\.writingSelected && item\.writingWorkflow\?\.approvedArticleText[\s\S]*?Approved article from GPHKM Writing/);
  assert.match(view, /!canManagePlacement && <OrderItemCancellationHistory history=\{item\.cancellationHistory \?\? \[\]\}/);
  assert.match(orderService, /row_number\(\) over \([\s\S]*partition by cancellation\.order_item_id[\s\S]*history_rank <= 20/);
  assert.match(orderService, /cancellationHistoryByItem\.get\(item\.id\) \?\? \[\]/);
  assert.match(cancellation, /export function OrderItemCancellationHistory/);
  assert.match(projection, /order\.actorUserId === viewerUserId && item\.writingSelected && item\.writingWorkflow/,
    "approved draft text remains scoped to the customer who placed the order");
});

test("staff recovery retry forces a fresh console access check and pause copy preserves the current customer stage", () => {
  const layout = readFileSync(new URL("../src/app/staff/(console)/layout.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/workflow-actions.tsx", import.meta.url), "utf8");
  assert.match(layout, /<a href="\/staff">Retry<\/a>/);
  assert.match(actions, /customer stays at their current order stage; the pause reason stays private/);
});

test("recording an actual manual send advances progress and keeps receipt acknowledgement separate", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  const field = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/device-time-field.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/actions.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  assert.match(field, /Use current device time/);
  assert.match(field, /deviceLocalIsoTimestamp\(new Date\(\)\)/);
  assert.match(field, /this device’s local time and timezone/);
  assert.match(page, /Recording the actual send moves eligible placements to Publication in Progress/);
  assert.match(page, /provider-confirmed delivery or a recorded actual manual send moves eligible placements to Publication in Progress/);
  assert.match(page, /Record supplier receipt/);
  assert.match(page, /name="confirmSupplierReceipt" required/);
  assert.match(actions, /get\(form, "confirmSupplierReceipt"\) !== "on"[\s\S]*error=ack-confirm/);
  assert.match(service, /confirmSupplierReceipt: boolean/);
  assert.match(service, /input\.confirmSupplierReceipt !== true/);
  assert.match(service, /confirmManualSupplierReceipt\([\s\S]*state: progress\.state, customerStatus: progress\.customerStatus/);
  assert.match(page, /latest\.acknowledged \? <section[\s\S]*Supplier receipt is recorded/);
  assert.match(actions, /acknowledged=1#supplier-acknowledgement/);
});

test("assignment result stays in the current fulfillment queue view and confirms success", () => {
  const actions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/actions.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/page.tsx", import.meta.url), "utf8");
  assert.match(actions, /fulfillmentQueueRedirectTarget\(field\(form, "page"\), field\(form, "view"\), "updated"\)/);
  assert.match(actions, /fulfillmentQueueRedirectTarget\(field\(form, "page"\), field\(form, "view"\), "assignment-failed"\)/);
  assert.match(page, /name="page" value=\{pagination\.page\}/);
  assert.match(page, /name="view" value=\{view\}/);
  assert.match(page, /Assignment saved\. The queue below shows the latest assignment\./);
  assert.match(page, /<RedirectingForm action=\{assignFulfillmentAction\}/);
  const redirectingForm = readFileSync(new URL("../src/app/staff/(console)/fulfillment/redirecting-form.tsx", import.meta.url), "utf8");
  assert.match(redirectingForm, /isSafeStaffNavigationTarget\(result\.redirectTo\)/);
  assert.match(redirectingForm, /window\.location\.assign\(result\.redirectTo\)/);
  assert.match(redirectingForm, /role="status">Saving/);
  assert.match(redirectingForm, /Your action may already have completed/);
  assert.match(redirectingForm, /if \(submittingRef\.current\) return/);
});

test("staff page and domain checks reuse one request-scoped actor while enforcing each permission", () => {
  const auth = readFileSync(new URL("../src/server/auth/staff.ts", import.meta.url), "utf8");
  assert.match(auth, /const getStaffActorForRequest = cache\(async \(headers: Headers\)/);
  assert.match(auth, /const actor = await getStaffActorForRequest\(headers\);[\s\S]*!hasStaffPermission\(role, permission\)/);
  assert.match(auth, /assertStaffPermission\(role, permission\)/);
});

test("post-save fulfillment and packet actions use a full staff-page navigation", () => {
  const fulfillmentActions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/actions.ts", import.meta.url), "utf8");
  const packetActions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/actions.ts", import.meta.url), "utf8");
  const fulfillmentPage = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/page.tsx", import.meta.url), "utf8");
  const packetPage = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/[packetId]/page.tsx", import.meta.url), "utf8");
  const preparePage = readFileSync(new URL("../src/app/staff/(console)/fulfillment/packets/new/page.tsx", import.meta.url), "utf8");
  const workflowActions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/workflow-actions.tsx", import.meta.url), "utf8");
  assert.match(fulfillmentActions, /updateFulfillmentAction\(form: FormData\): Promise<\{ redirectTo: string \}>/);
  assert.match(fulfillmentActions, /updateFulfillmentFollowUpAction\(form: FormData\): Promise<\{ redirectTo: string \}>/);
  assert.match(packetActions, /preparePacketsAction\(form: FormData\): Promise<\{ redirectTo: string \}>/);
  assert.match(packetActions, /sendSupplierPacketAction\(form: FormData\): Promise<\{ redirectTo: string \}>/);
  assert.match(workflowActions, /<RedirectingForm action=\{updateFulfillmentAction\}/);
  assert.match(fulfillmentPage, /<RedirectingForm action=\{updateFulfillmentFollowUpAction\}/);
  assert.match(packetPage, /<RedirectingForm action=\{sendSupplierPacketAction\}/);
  assert.match(preparePage, /<RedirectingForm action=\{preparePacketsAction\}/);
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
  assert.deepEqual(fulfillmentTransitionChoices("READY_FOR_HANDOFF", null, true).map(({ value }) => value), ["ON_HOLD"]);
  assert.equal(fulfillmentTransitionChoices("HANDOFF_PENDING", null, true).some(({ value }) => value === "IN_FULFILLMENT"), false);
  assert.equal(fulfillmentTransitionChoices("HANDOFF_PENDING", null, true, true, true).some(({ value }) => value === "IN_FULFILLMENT"), true);
});

test("the assigned fulfillment detail shows the latest consented instructions", () => {
  const source = readFileSync(new URL("../src/server/fulfillment/admin.ts", import.meta.url), "utf8");
  const detail = source.slice(source.indexOf("export async function getFulfillmentItem"), source.indexOf("export async function saveWritingDraft"));
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/page.tsx", import.meta.url), "utf8");
  assert.match(detail, /mayReadFulfillmentContent[\s\S]*eq\(orderItemContentChangeEvent.versionId, orderItemContentVersion.id\)[\s\S]*eq\(orderItemContentChangeEvent.contentHash, orderItemContentVersion.contentHash\)[\s\S]*"CONSENTED"[\s\S]*desc\(orderItemContentVersion.version\)/);
  assert.match(detail, /instructions: currentContent.instructions/, "an explicitly cleared instruction cannot fall back to checkout text");
  assert.match(page, /result.item.instructions[\s\S]*Publication instructions[\s\S]*result.item.instructions/);
});

test("fulfillment action errors stay on the item page with a recovery message", () => {
  const actions = readFileSync(new URL("../src/app/staff/(console)/fulfillment/actions.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/page.tsx", import.meta.url), "utf8");
  assert.match(actions, /error\.message === "Prepare the supplier packet before entering handoff preparation"[\s\S]*fulfillmentItemRedirectTarget\(itemId, "packet-required"\)/);
  assert.match(actions, /error\.message === "Confirm provider delivery or record the actual manual send before starting placement work"[\s\S]*fulfillmentItemRedirectTarget\(itemId, "delivery-required"\)/);
  assert.match(page, /query\.error === "packet-required"[\s\S]*Prepare the supplier packet/);
  assert.match(page, /query\.error === "delivery-required"[\s\S]*actual manual send is recorded/);
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

test("fulfillment progress reasons are derived from validated workflow steps", () => {
  assert.equal(fulfillmentReasonCodeForTransition("CONTENT_PREPARATION", "AWAITING_CUSTOMER_APPROVAL"), "CUSTOMER_ACTION_NEEDED");
  assert.equal(fulfillmentReasonCodeForTransition("READY_FOR_HANDOFF", "IN_FULFILLMENT"), "FULFILLMENT_STARTED");
  assert.equal(fulfillmentReasonCodeForTransition("ON_HOLD", "CONTENT_PREPARATION"), "RESUMED_WORK");
  assert.equal(fulfillmentReasonCodeForTransition("IN_FULFILLMENT", "ON_HOLD"), "PAUSED_FOR_REVIEW");
  assert.equal(fulfillmentReasonCodeForTransition("IN_FULFILLMENT", "ON_HOLD", "CONTENT_RIGHTS_UNCONFIRMED"), "CONTENT_RIGHTS_UNCONFIRMED");
  assert.throws(() => fulfillmentReasonCodeForTransition("IN_FULFILLMENT", "ON_HOLD", "CUSTOMER_ACTION_NEEDED"), /valid reason/);
  assert.throws(() => fulfillmentReasonCodeForTransition("CONFIRMED", "COMPLETED"), /valid next step/);
});

test("staff progress choices explain the scenario and use plain labels", () => {
  assert.equal(fulfillmentStateLabel("HANDOFF_PENDING"), "Waiting for supplier delivery");
  assert.equal(fulfillmentStateLabel("ON_HOLD"), "Paused for review");
  assert.match(fulfillmentTransitionGuidance("CONFIRMED", "CONTENT_PREPARATION"), /Order received to Content review/);
  assert.match(fulfillmentTransitionGuidance("CONTENT_PREPARATION", "AWAITING_CUSTOMER_APPROVAL"), /draft is ready for customer approval/);
  assert.match(fulfillmentTransitionGuidance("READY_FOR_HANDOFF", "IN_FULFILLMENT"), /Preparing to Publication in Progress/);
  assert.match(fulfillmentTransitionGuidance("HANDOFF_PENDING", "IN_FULFILLMENT"), /provider delivery is confirmed or staff records the actual manual send/);
  assert.match(fulfillmentTransitionGuidance("ON_HOLD", "IN_FULFILLMENT"), /saved when the placement was paused/);
});

test("customer update date controls stay valid around noon UTC and within the server limit", () => {
  const beforeNoon = new Date("2026-10-28T11:59:59.999Z");
  const atNoon = new Date("2026-10-28T12:00:00.000Z");
  assert.equal(minimumNextUpdateDate(beforeNoon), "2026-10-28");
  assert.equal(minimumNextUpdateDate(atNoon), "2026-10-29");
  assert.equal(maximumNextUpdateDate(new Date("2026-10-28T08:00:00.000Z")), "2027-10-28");
  assert.equal(maximumNextUpdateDate(new Date("2026-10-28T13:00:00.000Z")), "2027-10-29");
  assert.equal(nextUpdateDateInputValue(new Date("2026-10-29T12:00:00.000Z"), "2026-10-28", "2027-10-29"), "2026-10-29");
  assert.equal(nextUpdateDateInputValue(new Date("2026-10-27T12:00:00.000Z"), "2026-10-28", "2027-10-29"), "2026-10-28");
  assert.equal(nextUpdateDateInputValue(new Date("2028-01-01T12:00:00.000Z"), "2026-10-28", "2027-10-29"), "2026-10-28");
});

test("fulfillment detail separates customer dates, progress, supplier issues, and handoff waits", () => {
  const page = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/page.tsx", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../src/app/staff/(console)/fulfillment/workflow-actions.tsx", import.meta.url), "utf8");
  assert.match(page, /Schedule the next customer update/);
  assert.match(page, /does not send a message or change placement progress/);
  assert.match(page, /Change placement progress/);
  assert.match(page, /If the supplier reports a problem/);
  assert.match(page, /Customer-facing placement progress/);
  assert.match(page, /Customer placement stage/);
  assert.match(page, /Stage \$\{customerStage\.stageNumber\} of \$\{customerStage\.totalStages\}/);
  assert.match(page, /provider delivery is confirmed or staff records the actual manual send/);
  assert.match(page, /Start link verification becomes available/);
  assert.match(page, /there is no generic stage override/);
  assert.match(page, /Advance the customer stage/);
  assert.match(page, /A manual send is recorded and the customer is now at Publication in Progress/);
  assert.match(page, /This opens the packet page\. The customer’s stage changes after delivery is confirmed or an actual manual send is recorded there\./);
  assert.match(page, /<a className=\{styles\.open\} href=\{`\/staff\/fulfillment\/packets\/\$\{encodeURIComponent\(result\.currentPacket\.id\)\}#manual-mail-handoff`\}>Open packet handoff<\/a>/);
  assert.match(page, /Choose the confirmed situation/);
  assert.match(page, /result\.hasOpenSupplierOutcome/);
  assert.match(page, /awaitingSupplier \? /);
  assert.match(workflow, /fulfillmentTransitionGuidance\(state, currentStep\.value\)/);
  assert.match(workflow, /Next available action/);
  assert.match(workflow, /\{currentStep\.label\} and save update date/);
  assert.match(workflow, /Pause this placement for review/);
  assert.match(workflow, /max=\{maximumDate\}/);
  assert.doesNotMatch(page, /Follow-up reason<select/);
  assert.doesNotMatch(page, /Update reason<select/);
});
