import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentChangeStatus, hashOrderContent, isStaleRecipientReconsent, mayRequestContentChange, mergeContentChange, validateContentChangePatch } from "../src/modules/orders/content-changes.ts";

test("content change accepts bounded text fields and rejects unsafe or irrelevant fields", () => {
  assert.deepEqual(validateContentChangePatch({ targetUrl: "https://example.test/path", anchorText: "new anchor" }, false), {
    targetUrl: "https://example.test/path", anchorText: "new anchor",
  });
  assert.throws(() => validateContentChangePatch({ targetUrl: "javascript:alert(1)" }, false), /HTTP or HTTPS/);
  assert.throws(() => validateContentChangePatch({ articleText: "wrong mode" }, true), /writing review/);
  assert.deepEqual(validateContentChangePatch({ articleText: "replacement article" }, true, true), { articleText: "replacement article" });
  assert.throws(() => validateContentChangePatch({ articleText: "wrong mode" }, true, false), /writing review/);
  assert.throws(() => validateContentChangePatch({ articleText: "x".repeat(20_001) }, false), /invalid/);
  assert.throws(() => validateContentChangePatch({ arbitrary: "value" }, false), /Only text fields/);
});

test("approved content merges onto the base and hashes deterministically", () => {
  const original = { targetUrl: "https://old.test", anchorText: "old", articleText: "article", writingBrief: null, instructions: "" };
  const changed = mergeContentChange(original, validateContentChangePatch({ anchorText: "new" }, false));
  assert.equal(changed.targetUrl, original.targetUrl);
  assert.equal(changed.anchorText, "new");
  assert.equal(hashOrderContent(changed), hashOrderContent({ ...changed }));
  assert.notEqual(hashOrderContent(changed), hashOrderContent(original));
  assert.notEqual(hashOrderContent(changed, { supplierId: "supplier-a", recipientEmail: "a@example.test" }), hashOrderContent(changed, { supplierId: "supplier-b", recipientEmail: "b@example.test" }));
});

test("handoff and request event states are explicit", () => {
  assert.equal(mayRequestContentChange({ requesterId: "a", ordererId: "a", handedOffAt: null, state: "READY_FOR_HANDOFF" }), true);
  assert.equal(mayRequestContentChange({ requesterId: "b", ordererId: "a", handedOffAt: null, state: "READY_FOR_HANDOFF" }), false);
  assert.equal(mayRequestContentChange({ requesterId: "a", ordererId: "a", handedOffAt: new Date(), state: "READY_FOR_HANDOFF" }), false);
  assert.equal(contentChangeStatus([{ eventType: "CONSENTED" }, { eventType: "APPROVED" }]), "CONSENTED");
  assert.equal(contentChangeStatus([{ eventType: "APPROVED" }]), "APPROVED_AWAITING_CONSENT");
});

test("database records are append-only and handoff waits for request and exact-version consent", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0018_order_item_content_changes.sql", import.meta.url), "utf8");
  assert.match(migration, /REVOKE UPDATE, DELETE ON order_item_content_change_request/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON order_item_content_version/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON order_item_content_change_event/);
  assert.match(migration, /NEW\.content_hash IS DISTINCT FROM version_row\.content_hash/);
  assert.match(migration, /latest\.event_type IN \('REQUESTED','APPROVED'\)/);
  assert.match(migration, /fulfillment_requires_resolved_content_changes/);
});

test("database authorization and insert trigger reject content changes during cancellation review", () => {
  const migration = readFileSync(new URL("../src/db/migrations/0029_content_change_cancellation_guard.sql", import.meta.url), "utf8");
  assert.match(migration, /gphkm_change_request_before_handoff/);
  assert.match(migration, /state NOT IN \([\s\S]*'CANCELLATION_REQUESTED'/);
  assert.match(migration, /gphkm_validate_content_change_request/);
  assert.match(migration, /fulfillment_row\.state IN \([\s\S]*'CANCELLATION_REQUESTED'/);
});

test("service does not update the purchased order snapshot and returns explicit projections", () => {
  const source = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tx\.update\(customerOrderItem\)/);
  assert.match(source, /requesterId: actor\.userId, ordererId: item\.ordererId/);
  assert.match(source, /CONTENT_SHARING_NOTICE_VERSION/);
  assert.match(source, /versionId: version\.version_id/);
  assert.match(source, /gphkm_customer_approved_content/);
  assert.match(source, /return requests\.map\(\(request\) =>/);
});

test("customer order content uses the newest-first request and consented-version projection", () => {
  const service = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/customer/orders/page.tsx", import.meta.url), "utf8");
  assert.match(service, /orderBy\(desc\(orderItemContentChangeRequest\.requestNumber\)\)/);
  assert.match(page, /const latestChange = changes\[0\]/);
  assert.match(page, /changes\.find\(\(change\) => change\.status === "CONSENTED"\)/);
  assert.doesNotMatch(page, /changes\.at\(-1\)|\[\.\.\.changes\]\.reverse\(\)/);
});

test("customer approved-content batch uses individually bound request IDs", () => {
  const service = readFileSync(new URL("../src/server/orders/content-changes.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/customer/orders/page.tsx", import.meta.url), "utf8");
  const form = readFileSync(new URL("../src/app/customer/orders/content-change-form.tsx", import.meta.url), "utf8");
  const customerCss = readFileSync(new URL("../src/app/customer/customer.module.css", import.meta.url), "utf8");
  assert.ok(service.includes("where request.id in (${sql.join(requestIds.map((requestId) => sql`${requestId}`), sql`, `)})"));
  assert.doesNotMatch(service, /any\(\$\{requestIds\}::text\[\]\)/);
  assert.match(page, /customer_content_changes_load_failed/);
  assert.match(page, /Order approval details could not be loaded/);
  assert.match(form, /props\.approvedChange \? null/);
  assert.match(customerCss, /\.placementCard > section\[aria-labelledby\^="change-"\] pre[^{}]*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/);
});

test("staff marks superseded or recipient-mismatched re-consents stale without staling current approval", () => {
  const base = {
    purpose: "RECIPIENT_RECONSENT", status: "APPROVED_AWAITING_CONSENT", versionNumber: 2, latestContentVersionNumber: 2,
    versionSupplierId: "supplier-a", versionRecipientEmail: "contact@example.test",
    currentSupplierId: "supplier-a", currentRecipientEmail: "CONTACT@example.test", fulfillmentState: "HANDOFF_PENDING",
    handedOffAt: new Date(), workStartedAt: null,
  };
  assert.equal(isStaleRecipientReconsent(base), false);
  assert.equal(isStaleRecipientReconsent({ ...base, latestContentVersionNumber: 3 }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, currentRecipientEmail: "new@example.test" }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, versionSupplierId: "supplier-b" }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, fulfillmentState: "IN_FULFILLMENT" }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, status: "REQUESTED", versionNumber: null, versionSupplierId: null, versionRecipientEmail: null }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, status: "CONSENTED", fulfillmentState: "IN_FULFILLMENT", handedOffAt: null, workStartedAt: new Date() }), false);
  assert.equal(isStaleRecipientReconsent({ ...base, status: "CONSENTED", currentRecipientEmail: "new@example.test" }), true);
  assert.equal(isStaleRecipientReconsent({ ...base, purpose: "CONTENT_CHANGE", currentRecipientEmail: "new@example.test" }), false);

  const review = readFileSync(new URL("../src/app/staff/(console)/fulfillment/[itemId]/content-change-review.tsx", import.meta.url), "utf8");
  assert.match(review, /request\.approvedVersion && request\.status === "STALE"/);
  assert.match(review, /request\.approvedVersion && request\.status === "CONSENTED"/);
  assert.match(review, /request\.approvedVersion && request\.status === "APPROVED_AWAITING_CONSENT"/);
});
