import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import {
  acknowledgementFollowUpAt,
  assertPacketActionable,
  assertCompletePacketReplacement,
  buildSupplierPacket,
  customerOrderItemProjection,
  deliveryFollowUpAt,
  mayAccessSupplierPacket,
  mayRequestOrdinaryCancellation,
  mayStartSend,
  mayStartManualPacketHandoff,
  parseExplicitInstant,
  markUnknownAttempt,
  markProviderAccepted,
  markProviderDelivered,
  recordManualExportAttempt,
  recordManualHandoff,
  renderSupplierEmail,
  resolveUnknownAttempt,
  supplierDeliveryProjection,
  transitionItem,
} from "../src/modules/fulfillment/workflow.ts";
import { buildSupplierPacketPdf } from "../src/server/fulfillment/pdf.ts";
import {
  appendCaseReply,
  canViewCase,
  customerCaseProjection,
  decidePostHandoffRefund,
  openSupportCase,
  staffCaseProjection,
  transitionSupportCase,
} from "../src/modules/fulfillment/support-cases.ts";
import { readBoundedUtf8Body } from "../src/modules/fulfillment/webhook-body.ts";

test("supplier webhook body reader enforces a hard streaming byte cap", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("123")); controller.enqueue(new TextEncoder().encode("45")); controller.close(); } });
  assert.equal(await readBoundedUtf8Body(stream, 5), "12345");
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("123")); controller.enqueue(new TextEncoder().encode("456")); } });
  assert.equal(await readBoundedUtf8Body(oversized, 5), null);
  const cancelFails = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("123456")); },
    cancel() { throw new Error("cancel failed"); },
  });
  assert.equal(await readBoundedUtf8Body(cancelFails, 5), null);
  const invalidUtf8 = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([0xff])); controller.close(); } });
  assert.equal(await readBoundedUtf8Body(invalidUtf8, 5), null);
});

test("packet access requires every included item to remain assigned to the Admin", () => {
  const assigned = { packetAdminId: "admin_a", currentAdminId: "admin_a" };
  assert.equal(mayAccessSupplierPacket({ actorId: "admin_a", actorRole: "ADMIN", assignments: [assigned] }), true);
  assert.equal(mayAccessSupplierPacket({ actorId: "admin_b", actorRole: "ADMIN", assignments: [assigned] }), false);
  assert.equal(mayAccessSupplierPacket({ actorId: "admin_a", actorRole: "ADMIN", assignments: [assigned, { packetAdminId: "admin_a", currentAdminId: "admin_b" }] }), false);
  assert.equal(mayAccessSupplierPacket({ actorId: "admin_a", actorRole: "ADMIN", assignments: [] }), false);
  assert.equal(mayAccessSupplierPacket({ actorId: "super", actorRole: "SUPER_ADMIN", assignments: [assigned] }), true);
  assert.equal(mayAccessSupplierPacket({ actorId: "finance", actorRole: "FINANCE", assignments: [assigned] }), false);
});

const now = "2026-10-28T00:00:00.000Z";
const content = {
  placementRequirements: ["One contextual backlink"],
  targetUrl: "https://customer.example/path",
  anchorText: "Example anchor",
  article: "Approved publication-ready article.",
  instructions: "Use the approved article without changes.",
};
const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");

function packetInput(overrides = {}) {
  return {
    packetId: "pkt_opaque_01",
    version: 1,
    createdBy: "admin_a",
    createdByRole: "ADMIN",
    createdAt: now,
    recipient: "editor@example.net",
    items: [{
      orderItemId: "item_01",
      organizationId: "org_01",
      orderId: "order_01",
      supplierId: "supplier_01",
      assignedAdminId: "admin_a",
      reference: "GPH-ITEM-01",
      ...content,
      approvedArticle: true,
      consent: {
        disclosureVersion: "notice-3",
        contentHash,
        supplierId: "supplier_01",
        recipient: "editor@example.net",
        acceptedAt: now,
      },
    }],
    ...overrides,
  };
}

test("packet builder groups one order, organization, and supplier; consent binds exact content and recipient", () => {
  const packet = buildSupplierPacket(packetInput());
  assert.equal(packet.items.length, 1);
  assert.equal(packet.recipient, "editor@example.net");
  assert.ok(packet.contentHash.length === 64);
  assert.throws(() => buildSupplierPacket(packetInput({ items: [
    packetInput().items[0], { ...packetInput().items[0], supplierId: "supplier_02" },
  ] })), /one organization, order, and supplier/);
  assert.throws(() => buildSupplierPacket(packetInput({ items: [{ ...packetInput().items[0], article: "Changed after consent" }] })), /fresh consent/);
  assert.throws(() => buildSupplierPacket(packetInput({ recipient: "editor@example.net\r\nBcc:attacker@example.com" })), /recipient is invalid/);
  assert.throws(() => buildSupplierPacket(packetInput({ createdBy: "admin_b" })), /assigned Admin/);
  assert.throws(() => buildSupplierPacket(packetInput({ createdByRole: "FINANCE" })), /cannot prepare supplier packets/);
});

test("supplier EML contains minimal body, encodes body, and blocks ambiguous resend", () => {
  const packet = buildSupplierPacket(packetInput());
  const rendered = renderSupplierEmail(packet, 2_000_000);
  assert.match(rendered.eml, /^To: editor@example\.net\r\n/);
  assert.match(rendered.eml, /Content-Transfer-Encoding: base64/);
  const withPdf = renderSupplierEmail(packet, 2_000_000, Uint8Array.from([37, 80, 68, 70]));
  assert.match(withPdf.eml, /multipart\/mixed/);
  assert.match(withPdf.eml, /application\/pdf/);
  assert.match(withPdf.eml, /filename="publication-instructions\.pdf"/);
  for (const internalValue of ["org_01", "order_01", "supplier_01", "admin_a", "notice-3", contentHash]) {
    assert.equal(rendered.text.includes(internalValue), false, `supplier body must omit internal value ${internalValue}`);
    assert.equal(rendered.eml.includes(internalValue), false, `supplier EML must omit internal value ${internalValue}`);
  }
  assert.throws(() => renderSupplierEmail(packet, 1), /configured packet size limit/);
  const exported = recordManualExportAttempt({ packet, id: "export_1", actorId: "admin_a", actorRole: "ADMIN", at: now });
  assert.equal(exported.state, "MANUAL_EXPORTED");

  const sending = { id: "attempt_1", packetId: packet.id, packetVersion: 1, actorId: "admin_a", recipient: packet.recipient, state: "SENDING", createdAt: now };
  assert.throws(() => mayStartSend({ packet, attempts: [markUnknownAttempt(sending, now)], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient }), /Resolve the current send outcome/);
  const failed = resolveUnknownAttempt({ attempt: markUnknownAttempt(sending, now), outcome: "RECONCILED_FAILED", actorId: "admin_a", actorRole: "ADMIN", at: now, reason: "Provider confirms no message was accepted" });
  assert.throws(() => mayStartSend({ packet, attempts: [failed], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient }), /deliberate resend reason/);
  assert.doesNotThrow(() => mayStartSend({ packet, attempts: [failed], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient, deliberateResend: true, resendReason: "Provider reconciliation confirms no send" }));
});

test("supplier PDF and email renderers receive an allowlisted delivery projection", async () => {
  const packet = buildSupplierPacket(packetInput());
  const delivery = supplierDeliveryProjection(packet);
  assert.deepEqual(Object.keys(delivery).sort(), ["id", "items", "recipient", "version"]);
  assert.deepEqual(Object.keys(delivery.items[0]).sort(), ["anchorText", "article", "instructions", "placementRequirements", "reference", "targetUrl"]);
  const serializedDelivery = JSON.stringify(delivery);
  for (const internalValue of ["org_01", "order_01", "supplier_01", "admin_a", "notice-3", contentHash]) {
    assert.equal(serializedDelivery.includes(internalValue), false);
  }

  const pdfBytes = Buffer.from(await buildSupplierPacketPdf(packet));
  assert.ok(pdfBytes.length > 100);
  const rawPdf = pdfBytes.toString("latin1");
  for (const internalValue of ["org_01", "order_01", "supplier_01", "admin_a", "notice-3", contentHash]) {
    assert.equal(rawPdf.includes(internalValue), false, `supplier PDF must omit internal value ${internalValue}`);
  }
  const contentStream = rawPdf.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  assert.ok(contentStream, "PDF must contain a page content stream");
  const pdfOperators = inflateSync(Buffer.from(contentStream[1], "latin1")).toString("latin1");
  const renderedPdfText = pdfOperators.replace(/<([\da-f]+)> Tj/gi, (_match, hex) => Buffer.from(hex, "hex").toString("latin1"));
  assert.match(renderedPdfText, /GPHKM - Publication instructions/);
  for (const internalValue of ["org_01", "order_01", "supplier_01", "admin_a", "notice-3", contentHash]) {
    assert.equal(renderedPdfText.includes(internalValue), false, `rendered supplier PDF must omit internal value ${internalValue}`);
  }
});

test("send authorization rechecks recipient and reviewed packet version; provider timeout blocks cancellation", () => {
  const packet = buildSupplierPacket(packetInput());
  assert.throws(() => mayStartSend({ packet, attempts: [], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: "changed", currentRecipient: packet.recipient }), /create a new packet version/);
  assert.throws(() => mayStartSend({ packet, attempts: [], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: "changed@example.net" }), /create a new packet version/);
  const item = { id: "item_01", organizationId: "org_01", orderId: "order_01", orderedByUserId: "member_01", state: "HANDOFF_PENDING", updatedAt: now, purchasedAt: now, totalPaidMinor: 10000, currency: "USD" };
  assert.equal(mayRequestOrdinaryCancellation(item), false);
  for (const state of ["SENDING", "UNKNOWN", "ACCEPTED", "DELIVERED", "DELIVERY_ISSUE", "MANUAL_SENT"]) {
    assert.equal(mayRequestOrdinaryCancellation(item, { source: "PERSISTED", state }), false, `${state} must block ordinary cancellation`);
  }
  for (const state of ["READY", "MANUAL_EXPORTED", "RECONCILED_FAILED"]) {
    assert.equal(mayRequestOrdinaryCancellation(item, { source: "PERSISTED", state }), true, `${state} is proven pre-send`);
  }
  assert.equal(mayRequestOrdinaryCancellation(item, { source: "UNTRUSTED", state: "MANUAL_EXPORTED" }), false);
  assert.equal(mayRequestOrdinaryCancellation(item), false);
  const cancelInput = { item, to: "CANCELLATION_REQUESTED", actorId: "customer_1", actorType: "CUSTOMER", actorOrganizationId: "org_01", customerCanAccessItem: true, at: now, reason: "Please cancel", eventId: "cancel_1" };
  assert.throws(() => transitionItem(cancelInput), /Resolve the persisted handoff state/);
  assert.throws(() => transitionItem({ ...cancelInput, persistedHandoff: { source: "PERSISTED", state: "UNKNOWN" } }), /Resolve the persisted handoff state/);
  assert.doesNotThrow(() => transitionItem({ ...cancelInput, persistedHandoff: { source: "PERSISTED", state: "MANUAL_EXPORTED" } }));
  const accepted = markProviderAccepted({ attempt: { id: "attempt_1", packetId: "pkt", packetVersion: 1, actorId: "admin_a", recipient: "editor@example.net", state: "SENDING", createdAt: now }, providerReference: "provider-msg-1", acceptedAt: now });
  const delivered = markProviderDelivered({ attempt: accepted, providerReference: "provider-msg-1", deliveredAt: "2026-10-28T01:00:00.000Z" });
  assert.equal(delivered.state, "DELIVERED");
  assert.equal(markProviderDelivered({ attempt: { id: "attempt_2", packetId: "p", packetVersion: 1, actorId: "admin_a", recipient: "editor@example.net", state: "SENDING", createdAt: now }, providerReference: "provider-msg-2", deliveredAt: now }).state, "DELIVERED");
  assert.throws(() => markProviderDelivered({ attempt: delivered, providerReference: "provider-msg-1", deliveredAt: now }), /Conflicting delivery evidence/);
});

test("superseded packets and non-size holds cannot be sent or exported", () => {
  assert.throws(() => assertPacketActionable({ superseded: true, holdReason: null }, true), /superseded/);
  assert.throws(() => assertPacketActionable({ superseded: false, holdReason: "STAFF_REVIEW" }, true), /held/);
  assert.throws(() => assertPacketActionable({ superseded: false, holdReason: "PACKET_SIZE_REVIEW" }), /held/);
  assert.doesNotThrow(() => assertPacketActionable({ superseded: false, holdReason: "PACKET_SIZE_REVIEW" }, true));
  assert.doesNotThrow(() => assertPacketActionable({ superseded: false, holdReason: null }, true));
});

test("packet replacements include every item from the old packet and manual resend preserves the handoff cutoff", () => {
  assert.doesNotThrow(() => assertCompletePacketReplacement(["a", "b"], new Set(["a", "b", "c"])));
  assert.throws(() => assertCompletePacketReplacement(["a", "b"], new Set(["a"])), /every item in the existing packet/);
  const pending = [{ state: "HANDOFF_PENDING", handedOffAt: null, workStartedAt: null }];
  const handedOff = [{ state: "IN_FULFILLMENT", handedOffAt: new Date(now), workStartedAt: new Date(now) }];
  assert.equal(mayStartManualPacketHandoff(pending, false), true);
  assert.equal(mayStartManualPacketHandoff(handedOff, false), false);
  assert.equal(mayStartManualPacketHandoff(handedOff, true), true);
  assert.equal(mayStartManualPacketHandoff([], true), false);
});

test("manual handoff requires exact consent-bound recipient and records staff evidence", () => {
  const packet = buildSupplierPacket(packetInput());
  assert.throws(() => recordManualHandoff({ packet, actorId: "admin_a", actorRole: "ADMIN", sentAt: now, actualRecipient: "wrong@example.net", messageReference: "mail-1", maxEvidenceBytes: 2_000_000 }), /fresh consent/);
  const record = recordManualHandoff({ packet, actorId: "admin_a", actorRole: "ADMIN", sentAt: now, actualRecipient: "editor@example.net", messageReference: "message-01", evidence: { format: "eml", sizeBytes: 120, objectKey: "private/evidence/01" }, maxEvidenceBytes: 2_000_000 });
  assert.equal(record.recipient, packet.recipient);
  assert.equal(record.evidence.format, "eml");
  assert.equal(acknowledgementFollowUpAt(undefined, record.sentAt), "2026-10-31T00:00:00.000Z");
});

test("manual handoff timestamps require and honor an explicit timezone", () => {
  assert.equal(parseExplicitInstant("2026-10-30T14:30:00+06:00")?.toISOString(), "2026-10-30T08:30:00.000Z");
  assert.equal(parseExplicitInstant("2026-10-30T08:30:00Z")?.toISOString(), "2026-10-30T08:30:00.000Z");
  assert.equal(parseExplicitInstant("2026-10-30T14:30:00"), null);
  assert.equal(parseExplicitInstant("2026-02-30T14:30:00+06:00"), null);
  assert.equal(parseExplicitInstant("2026-10-30T14:30:00+14:30"), null);
});

test("manual handoff preserves uploaded evidence when transaction commit outcome is ambiguous", async () => {
  const service = await readFile(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  const manualHandoff = service.slice(service.indexOf("export async function recordManualSupplierHandoff"), service.indexOf("export async function reconcileManualSupplierHandoffUnsent"));
  assert.match(manualHandoff, /let transactionCallbackReturned = false;/);
  assert.match(manualHandoff, /transactionCallbackReturned = true;[\s\S]*return \{ attemptId: attempt\.id, state: "MANUAL_SENT"/);
  assert.match(manualHandoff, /if \(storageKey && !transactionCallbackReturned\) await deletePrivateFile\(storageKey\)/);
});

test("packet replacement supersedes prior versions and all send/export commands enforce packet state", async () => {
  const service = await readFile(new URL("../src/server/fulfillment/packets.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../src/modules/fulfillment/workflow.ts", import.meta.url), "utf8");
  const prepare = service.slice(service.indexOf("export async function prepareSupplierPackets"), service.indexOf("export async function getSupplierPacket"));
  assert.match(prepare, /supplierPacket\.supersededAt} is null/);
  assert.match(prepare, /assertCompletePacketReplacement\(/);
  assert.match(workflow, /Select every item in the existing packet/);
  assert.match(prepare, /set\(\{ supersededAt: new Date\(\) \}\)/);
  for (const name of ["sendSupplierPacket", "exportSupplierPacketEml", "exportSupplierPacketPdf"]) {
    const start = service.indexOf(`export async function ${name}`);
    const end = service.indexOf("\nexport async function ", start + 1);
    assert.match(service.slice(start, end < 0 ? undefined : end), /assertPacketActionable\(/, `${name} must reject stale or held packets`);
  }
});

test("manual handoff reservation blocks cancellation until audited as unsent", async () => {
  const packet = buildSupplierPacket(packetInput());
  const item = { id: "item_01", organizationId: "org_01", orderId: "order_01", orderedByUserId: "member_01", state: "HANDOFF_PENDING", updatedAt: now, purchasedAt: now, totalPaidMinor: 10000, currency: "USD" };
  const pending = { id: "manual_attempt_1", packetId: packet.id, packetVersion: packet.version, actorId: "admin_a", recipient: packet.recipient, state: "SENDING", createdAt: now, type: "MANUAL_SEND" };
  assert.equal(mayRequestOrdinaryCancellation(item, { source: "PERSISTED", state: pending.state }), false);
  assert.throws(() => mayStartSend({ packet, attempts: [pending], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient }), /Resolve the current send outcome/);
  const reconciled = { ...pending, state: "RECONCILED_FAILED" };
  assert.equal(mayRequestOrdinaryCancellation(item, { source: "PERSISTED", state: reconciled.state }), true);
  assert.throws(() => mayStartSend({ packet, attempts: [reconciled], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient }), /deliberate resend reason/);
  assert.doesNotThrow(() => mayStartSend({ packet, attempts: [reconciled], actorRole: "ADMIN", actorId: "admin_a", revalidatedPacketHash: packet.contentHash, currentRecipient: packet.recipient, deliberateResend: true, resendReason: "Confirmed no email was sent" }));

  const reservationMigration = await readFile(new URL("../src/db/migrations/0122_manual_handoff_reservation.sql", import.meta.url), "utf8");
  const attemptGuardFix = await readFile(new URL("../src/db/migrations/0123_manual_attempt_provider_compatibility.sql", import.meta.url), "utf8");
  const acknowledgementGuard = await readFile(new URL("../src/db/migrations/0124_manual_packet_acknowledgement.sql", import.meta.url), "utf8");
  const evidenceGuard = await readFile(new URL("../src/db/migrations/0125_manual_evidence_finalizer_scope.sql", import.meta.url), "utf8");
  assert.match(reservationMigration, /type = 'MANUAL_SEND'[\s\S]*state = 'SENDING'/);
  assert.match(reservationMigration, /NEW\.state = 'MANUAL_SENT'.*NEW\.sent_at < OLD\.created_at/s);
  assert.match(attemptGuardFix, /OLD\.type = 'SEND' AND OLD\.state = 'SENDING'/);
  assert.match(acknowledgementGuard, /type IN \('MANUAL_SENT','MANUAL_SEND'\)/);
  assert.match(evidenceGuard, /gphkm_supplier_packet_access\(NEW\.packet_id, NEW\.uploaded_by_user_id\)/);
});

test("item transitions enforce cancellation refund linkage, holds, and customer-safe projections", () => {
  const item = { id: "item_01", organizationId: "org_01", orderId: "order_01", orderedByUserId: "member_01", state: "CONFIRMED", updatedAt: now, purchasedAt: now, totalPaidMinor: 10000, currency: "USD" };
  const staffContext = { actorType: "STAFF", actorRole: "ADMIN", assignedAdminId: "admin_a" };
  const held = transitionItem({ item, to: "ON_HOLD", actorId: "admin_a", ...staffContext, at: now, reason: "Need customer correction", eventId: "evt_1" }).item;
  assert.throws(() => transitionItem({ item: held, to: "READY_FOR_HANDOFF", actorId: "admin_a", ...staffContext, at: now, reason: "Resume", eventId: "evt_2" }), /state it had before hold/);
  const canceled = transitionItem({ item: { ...item, state: "CANCELLATION_REQUESTED", stateBeforeCancellation: "CONFIRMED" }, to: "CANCELED_REFUNDED", actorId: "admin_a", ...staffContext, at: now, reason: "Approved pre-handoff refund", eventId: "evt_3", refundCreditId: "ledger_credit_1", refundMinor: 5000, eligibleRefundMinor: 5000 }).item;
  assert.equal(canceled.state, "CANCELED_REFUNDED");
  assert.throws(() => transitionItem({ item: { ...item, state: "CANCELLATION_REQUESTED", stateBeforeCancellation: "CONFIRMED" }, to: "CANCELED_REFUNDED", actorId: "admin_a", ...staffContext, at: now, reason: "Refund", eventId: "evt_4", refundCreditId: "ledger_credit_1", refundMinor: 5000 }), /exact policy-eligible amount/);
  assert.throws(() => transitionItem({ item, to: "COMPLETED", actorId: "member_01", actorType: "CUSTOMER", actorOrganizationId: "org_01", customerCanAccessItem: true, at: now, reason: "Complete", eventId: "evt_5" }), /Customers may only request cancellation/);
  assert.deepEqual(customerOrderItemProjection({ ...item, state: "HANDOFF_PENDING", supplierId: "supplier-secret", assignedAdminId: "staff-secret" }), { id: "item_01", state: "PREPARING_YOUR_PLACEMENT", lastUpdatedAt: now, nextUpdateAt: null });
});

test("GPHKM Writing blocks placement work until the customer approves a draft", () => {
  const item = { id: "writing-item", organizationId: "org_01", orderId: "order_01", orderedByUserId: "member_01", state: "AWAITING_CUSTOMER_APPROVAL", updatedAt: now, purchasedAt: now, totalPaidMinor: 10000, currency: "USD", writingSelected: true, writingApproved: false };
  const input = { item, to: "READY_FOR_HANDOFF", actorId: "admin_a", actorType: "STAFF", actorRole: "ADMIN", assignedAdminId: "admin_a", at: now, reason: "Ready", eventId: "writing-event-1" };
  assert.throws(() => transitionItem(input), /Customer must approve the GPHKM Writing draft/);
  assert.equal(transitionItem({ ...input, item: { ...item, writingApproved: true } }).item.state, "READY_FOR_HANDOFF");
  assert.throws(() => transitionItem({ ...input, item: { ...item, writingApproved: true }, to: "IN_FULFILLMENT" }), /Invalid item transition/);
});

test("accepted delivery follow-up starts at acceptance time", () => {
  assert.equal(deliveryFollowUpAt({ id: "a", packetId: "p", packetVersion: 1, actorId: "admin", recipient: "x@y.com", state: "ACCEPTED", createdAt: now, acceptedAt: now }), "2026-10-31T00:00:00.000Z");
  assert.equal(deliveryFollowUpAt({ id: "a", packetId: "p", packetVersion: 1, actorId: "admin", recipient: "x@y.com", state: "ACCEPTED", createdAt: now }), null);
});

test("support cases preserve internal notes and finance-only decisions from customer projections", () => {
  const opened = openSupportCase({ id: "case_1", organizationId: "org_1", openedByUserId: "member_1", orderId: "order_1", orderItemId: "item_1", summary: "Please review my order", at: now });
  assert.equal(canViewCase({ caseRecord: opened.supportCase, actorType: "CUSTOMER", userId: "owner", organizationId: "org_1", organizationRole: "OWNER" }), true);
  assert.equal(canViewCase({ caseRecord: opened.supportCase, actorType: "CUSTOMER", userId: "other", organizationId: "org_1", organizationRole: "MEMBER", isOwnOrder: false }), false);
  assert.equal(canViewCase({ caseRecord: opened.supportCase, actorType: "STAFF", userId: "finance_1", actorRole: "FINANCE" }), false);
  const internal = appendCaseReply({ supportCase: opened.supportCase, actorId: "admin_1", actorRole: "ADMIN", audience: "INTERNAL", body: "Supplier follow-up pending", at: now, eventId: "msg_internal" });
  const reply = appendCaseReply({ supportCase: opened.supportCase, actorId: "admin_1", actorRole: "ADMIN", audience: "CUSTOMER", body: "We are checking the update.", at: now, eventId: "msg_customer" });
  const finance = transitionSupportCase({ caseRecord: opened.supportCase, to: "FINANCE_REVIEW", actorId: "admin_1", actorRole: "ADMIN", at: now, eventId: "case_finance" }).supportCase;
  assert.equal(canViewCase({ caseRecord: finance, actorType: "STAFF", userId: "finance_1", actorRole: "FINANCE" }), true);
  assert.throws(() => transitionSupportCase({ caseRecord: finance, to: "RESOLVED", actorId: "admin_1", actorRole: "ADMIN", at: now, eventId: "case_resolve", reason: "refund denied" }), /Only Finance or Super Admin/);
  assert.throws(() => decidePostHandoffRefund({ supportCase: finance, actorId: "admin_1", actorRole: "ADMIN", decision: "APPROVED", amountMinor: 1000, itemPaidMinor: 5000, walletCreditId: "credit_1", walletCreditMinor: 1000, reason: "Case", at: now, eventId: "refund_decision" }), /Only Finance or Super Admin/);
  assert.throws(() => decidePostHandoffRefund({ supportCase: finance, actorId: "finance_1", actorRole: "FINANCE", decision: "APPROVED", amountMinor: 1000, itemPaidMinor: 5000, walletCreditId: "credit_1", walletCreditMinor: 900, reason: "Approved exception", at: now, eventId: "refund_decision_bad" }), /exact approved amount/);
  const projection = customerCaseProjection({ supportCase: opened.supportCase, events: [opened.event, internal, reply] });
  assert.equal(projection.messages.length, 1);
  assert.equal(JSON.stringify(projection).includes("Supplier follow-up"), false);
  assert.equal(JSON.stringify(projection).includes("Finance"), false);
  const approved = decidePostHandoffRefund({ supportCase: finance, actorId: "finance_1", actorRole: "FINANCE", decision: "APPROVED", amountMinor: 1000, itemPaidMinor: 5000, walletCreditId: "credit_1", walletCreditMinor: 1000, reason: "Documented exception", at: now, eventId: "refund_decision_ok" });
  const staffSafe = staffCaseProjection({ supportCase: finance, events: [opened.event, internal, reply, approved], userId: "admin_1", actorRole: "ADMIN", assignedAdminId: "admin_1" });
  assert.equal(JSON.stringify(staffSafe).includes("refund_decision_ok"), false);
  const resolved = transitionSupportCase({ caseRecord: finance, to: "RESOLVED", actorId: "finance_1", actorRole: "FINANCE", at: now, eventId: "case_resolved", reason: "Refund credited", financialDecision: approved }).supportCase;
  assert.equal(resolved.state, "RESOLVED");
});
