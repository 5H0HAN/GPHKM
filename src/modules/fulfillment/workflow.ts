import "server-only";
import { createHash } from "node:crypto";

export type StaffRole = "ADMIN" | "FINANCE" | "SUPER_ADMIN";

export function mayAccessSupplierPacket(input: {
  actorId: string;
  actorRole: StaffRole;
  assignments: Array<{ packetAdminId: string | null; currentAdminId: string | null }>;
}): boolean {
  return input.actorRole === "SUPER_ADMIN" || (input.actorRole === "ADMIN" && input.assignments.length > 0
    && input.assignments.every(({ packetAdminId, currentAdminId }) => packetAdminId === input.actorId && currentAdminId === input.actorId));
}

export type ItemState =
  | "CONFIRMED"
  | "CONTENT_PREPARATION"
  | "AWAITING_CUSTOMER_APPROVAL"
  | "READY_FOR_HANDOFF"
  | "HANDOFF_PENDING"
  | "IN_FULFILLMENT"
  | "PUBLICATION_PENDING"
  | "EVIDENCE_REVIEW"
  | "COMPLETED"
  | "ON_HOLD"
  | "CANCELLATION_REQUESTED"
  | "CANCELED_REFUNDED";

export type CustomerMilestone =
  | "ORDER_RECEIVED"
  | "CONTENT_REVIEW"
  | "PREPARING_YOUR_PLACEMENT"
  | "PUBLICATION_IN_PROGRESS"
  | "LINK_VERIFICATION"
  | "COMPLETE_RESOLVED";

export type PersistedHandoffState = Readonly<{
  /** Loaded by the server from the packet-attempt records in the same command transaction. */
  source: "PERSISTED";
  state: PacketAttemptState;
}>;

export function parseExplicitInstant(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00", fraction = "", zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const millis = Number(fraction.padEnd(3, "0"));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || year < 1 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3)), offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === "+" ? 1 : -1);
  }
  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  localAsUtc.setUTCHours(hour, minute, second, millis);
  return new Date(localAsUtc.getTime() - offsetMinutes * 60_000);
}

const transitions: Readonly<Record<ItemState, readonly ItemState[]>> = {
  CONFIRMED: ["CONTENT_PREPARATION", "CANCELLATION_REQUESTED", "ON_HOLD"],
  CONTENT_PREPARATION: ["AWAITING_CUSTOMER_APPROVAL", "READY_FOR_HANDOFF", "CANCELLATION_REQUESTED", "ON_HOLD"],
  AWAITING_CUSTOMER_APPROVAL: ["CONTENT_PREPARATION", "READY_FOR_HANDOFF", "CANCELLATION_REQUESTED", "ON_HOLD"],
  READY_FOR_HANDOFF: ["HANDOFF_PENDING", "IN_FULFILLMENT", "CANCELLATION_REQUESTED", "ON_HOLD"],
  HANDOFF_PENDING: ["IN_FULFILLMENT", "CANCELLATION_REQUESTED", "ON_HOLD"],
  IN_FULFILLMENT: ["PUBLICATION_PENDING", "ON_HOLD"],
  PUBLICATION_PENDING: ["EVIDENCE_REVIEW", "ON_HOLD"],
  EVIDENCE_REVIEW: ["COMPLETED", "PUBLICATION_PENDING", "ON_HOLD"],
  COMPLETED: [],
  ON_HOLD: ["CONFIRMED", "CONTENT_PREPARATION", "AWAITING_CUSTOMER_APPROVAL", "READY_FOR_HANDOFF", "HANDOFF_PENDING", "IN_FULFILLMENT", "PUBLICATION_PENDING", "EVIDENCE_REVIEW"],
  CANCELLATION_REQUESTED: ["CONFIRMED", "CONTENT_PREPARATION", "AWAITING_CUSTOMER_APPROVAL", "READY_FOR_HANDOFF", "CANCELED_REFUNDED"],
  CANCELED_REFUNDED: [],
};

export type ItemEvent = Readonly<{
  id: string;
  itemId: string;
  actorId: string;
  at: string;
  from: ItemState;
  to: ItemState;
  reason: string;
  correctionCaseId?: string;
}>;

export type ItemSnapshot = Readonly<{
  id: string;
  organizationId: string;
  orderId: string;
  orderedByUserId: string;
  state: ItemState;
  updatedAt: string;
  purchasedAt: string;
  handedOffAt?: string;
  workStartedAt?: string;
  completedAt?: string;
  nextUpdateAt?: string;
  totalPaidMinor: number;
  currency: "USD";
  stateBeforeHold?: ItemState;
  stateBeforeCancellation?: ItemState;
  writingSelected?: boolean;
  writingApproved?: boolean;
}>;

export function transitionItem(input: {
  item: ItemSnapshot;
  to: ItemState;
  actorId: string;
  actorType: "CUSTOMER" | "STAFF";
  actorRole?: StaffRole;
  assignedAdminId?: string;
  actorOrganizationId?: string;
  customerCanAccessItem?: boolean;
  at: string;
  reason: string;
  eventId: string;
  correctionCaseId?: string;
  refundCreditId?: string;
  refundMinor?: number;
  eligibleRefundMinor?: number;
  persistedHandoff?: PersistedHandoffState;
}): { item: ItemSnapshot; event: ItemEvent } {
  const { item, to } = input;
  if (!input.actorId.trim() || !input.reason.trim() || !input.eventId.trim()) throw new Error("Transition requires actor, reason, and event reference");
  if (!Number.isFinite(Date.parse(input.at))) throw new Error("Transition timestamp is invalid");
  if (input.actorType === "CUSTOMER") {
    if (input.actorOrganizationId !== item.organizationId || input.customerCanAccessItem !== true) throw new Error("Customer lacks access to this organization order item");
    if (to !== "CANCELLATION_REQUESTED") throw new Error("Customers may only request cancellation; staff records workflow state");
  } else {
    if (input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Staff role cannot change fulfillment state");
    if (input.actorRole === "ADMIN" && input.assignedAdminId !== input.actorId) throw new Error("Admin must be assigned to the order item");
  }
  const correction = item.state === "COMPLETED" && to === "PUBLICATION_PENDING" && Boolean(input.correctionCaseId) && (input.actorRole === "ADMIN" || input.actorRole === "SUPER_ADMIN");
  if (!transitions[item.state].includes(to) && !correction) throw new Error(`Invalid item transition: ${item.state} -> ${to}`);
  if (item.writingSelected && item.writingApproved !== true && ["READY_FOR_HANDOFF", "HANDOFF_PENDING", "IN_FULFILLMENT"].includes(to)) {
    throw new Error("Customer must approve the GPHKM Writing draft or consent to a reviewed replacement article before placement work can proceed");
  }
  if (item.state === "ON_HOLD" && to !== item.stateBeforeHold) throw new Error("An item must resume to the state it had before hold");
  if (item.state === "CANCELLATION_REQUESTED" && to !== "CANCELED_REFUNDED" && to !== item.stateBeforeCancellation) throw new Error("A denied cancellation must return to its prior state");
  if (to === "CANCELLATION_REQUESTED" && item.state === "HANDOFF_PENDING" && !mayRequestOrdinaryCancellation(item, input.persistedHandoff)) throw new Error("Resolve the persisted handoff state before accepting ordinary cancellation");
  if (to === "CANCELED_REFUNDED") {
    if (!input.refundCreditId || !Number.isSafeInteger(input.refundMinor) || input.refundMinor! <= 0 || input.refundMinor! > item.totalPaidMinor || input.refundMinor !== input.eligibleRefundMinor) {
      throw new Error("Cancellation requires a linked wallet credit for the exact policy-eligible amount");
    }
  }
  if (to === "COMPLETED" && item.state !== "EVIDENCE_REVIEW") throw new Error("Publication evidence review is required");
  if (Date.parse(input.at) < Date.parse(item.purchasedAt)) throw new Error("Transition cannot precede purchase");
  const updated = {
    ...item,
    state: to,
    updatedAt: input.at,
    ...(to === "IN_FULFILLMENT" && item.state === "HANDOFF_PENDING" ? { handedOffAt: input.at } : {}),
    ...(to === "IN_FULFILLMENT" && item.state === "READY_FOR_HANDOFF" ? { workStartedAt: input.at } : {}),
    ...(to === "COMPLETED" ? { completedAt: input.at } : {}),
    ...(to === "ON_HOLD" ? { stateBeforeHold: item.state } : {}),
    ...(item.state === "ON_HOLD" ? { stateBeforeHold: undefined } : {}),
    ...(to === "CANCELLATION_REQUESTED" ? { stateBeforeCancellation: item.state } : {}),
    ...(item.state === "CANCELLATION_REQUESTED" ? { stateBeforeCancellation: undefined } : {}),
  } satisfies ItemSnapshot;
  return {
    item: updated,
    event: { id: input.eventId, itemId: item.id, actorId: input.actorId, at: input.at, from: item.state, to, reason: input.reason.trim(), ...(input.correctionCaseId ? { correctionCaseId: input.correctionCaseId } : {}) },
  };
}

export function customerMilestone(state: ItemState): CustomerMilestone {
  switch (state) {
    case "CONFIRMED": return "ORDER_RECEIVED";
    case "CONTENT_PREPARATION":
    case "AWAITING_CUSTOMER_APPROVAL": return "CONTENT_REVIEW";
    case "READY_FOR_HANDOFF":
    case "HANDOFF_PENDING": return "PREPARING_YOUR_PLACEMENT";
    case "IN_FULFILLMENT": return "PUBLICATION_IN_PROGRESS";
    case "PUBLICATION_PENDING":
    case "EVIDENCE_REVIEW": return "LINK_VERIFICATION";
    case "COMPLETED":
    case "CANCELED_REFUNDED": return "COMPLETE_RESOLVED";
    case "ON_HOLD":
    case "CANCELLATION_REQUESTED": return "PREPARING_YOUR_PLACEMENT";
  }
}

export function customerOrderItemProjection(item: ItemSnapshot) {
  return {
    id: item.id,
    state: customerMilestone(item.state),
    lastUpdatedAt: item.updatedAt,
    nextUpdateAt: item.nextUpdateAt ?? null,
  } as const;
}

export type PacketItemInput = Readonly<{
  orderItemId: string;
  organizationId: string;
  orderId: string;
  supplierId: string;
  assignedAdminId: string;
  reference: string;
  // Construct only from the reviewed, supplier-shareable listing projection.
  placementRequirements: string[];
  targetUrl: string;
  anchorText: string;
  article: string;
  instructions: string;
  approvedArticle: boolean;
  consent: Readonly<{
    disclosureVersion: string;
    contentHash: string;
    supplierId: string;
    recipient: string;
    acceptedAt: string;
  }>;
}>;

export type SupplierPacket = Readonly<{
  id: string;
  version: number;
  organizationId: string;
  orderId: string;
  supplierId: string;
  recipient: string;
  createdBy: string;
  createdAt: string;
  contentHash: string;
  items: ReadonlyArray<Readonly<{
    orderItemId: string;
    assignedAdminId: string;
    reference: string;
    placementRequirements: readonly string[];
    targetUrl: string;
    anchorText: string;
    article: string;
    instructions: string;
    consent: Readonly<{
      disclosureVersion: string;
      contentHash: string;
      supplierId: string;
      recipient: string;
      acceptedAt: string;
    }>;
  }>>;
}>;

export type SupplierDeliveryPacket = Readonly<{
  id: string;
  version: number;
  recipient: string;
  items: ReadonlyArray<Readonly<{
    reference: string;
    placementRequirements: readonly string[];
    targetUrl: string;
    anchorText: string;
    article: string;
    instructions: string;
  }>>;
}>;

export function supplierDeliveryProjection(packet: SupplierPacket): SupplierDeliveryPacket {
  return {
    id: packet.id,
    version: packet.version,
    recipient: packet.recipient,
    items: packet.items.map(({ reference, placementRequirements, targetUrl, anchorText, article, instructions }) => ({
      reference, placementRequirements: [...placementRequirements], targetUrl, anchorText, article, instructions,
    })),
  };
}

export function buildSupplierPacket(input: {
  packetId: string;
  version: number;
  createdBy: string;
  createdByRole: StaffRole;
  createdAt: string;
  recipient: string;
  items: readonly PacketItemInput[];
}): SupplierPacket {
  if (input.items.length === 0) throw new Error("A supplier packet must include at least one item");
  if (!/^pkt_[a-zA-Z0-9_-]{6,80}$/.test(input.packetId) || !safeId(input.createdBy) || !Number.isInteger(input.version) || input.version < 1 || !Number.isFinite(Date.parse(input.createdAt))) throw new Error("Packet identity is invalid");
  if (input.createdByRole !== "ADMIN" && input.createdByRole !== "SUPER_ADMIN") throw new Error("Staff role cannot prepare supplier packets");
  if (!isValidRecipient(input.recipient)) throw new Error("Supplier recipient is invalid");
  const first = input.items[0]!;
  for (const item of input.items) {
    if (![item.orderItemId, item.organizationId, item.orderId, item.supplierId, item.assignedAdminId].every(safeId)) throw new Error("Packet record identity is invalid");
    if (!/^GPH-[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/i.test(item.reference)) throw new Error("Supplier-facing reference must be an opaque GPHKM reference");
  }
  if (input.items.some((item) => item.organizationId !== first.organizationId || item.orderId !== first.orderId || item.supplierId !== first.supplierId)) {
    throw new Error("Packet items must belong to one organization, order, and supplier");
  }
  if (input.createdByRole === "ADMIN" && input.items.some((item) => item.assignedAdminId !== input.createdBy)) {
    throw new Error("Only the assigned Admin may access packet content");
  }
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.orderItemId)) throw new Error("Packet cannot repeat an order item");
    seen.add(item.orderItemId);
    if (!item.approvedArticle) throw new Error("Only customer-provided or approved final articles may be handed off");
    if (!item.consent.disclosureVersion.trim() || !Number.isFinite(Date.parse(item.consent.acceptedAt))) throw new Error("Content-sharing consent evidence is incomplete");
    if (item.consent.supplierId !== item.supplierId || normalizeEmail(item.consent.recipient) !== normalizeEmail(input.recipient)) {
      throw new Error("Content-sharing consent does not match supplier and recipient");
    }
    const exactContentHash = supplierShareContentHash(item);
    if (item.consent.contentHash !== exactContentHash) throw new Error("Content changed after consent; obtain fresh consent");
    for (const value of [item.reference, item.targetUrl, item.anchorText, item.article, item.instructions, ...item.placementRequirements]) {
      if (/\0/.test(value)) throw new Error("Packet text contains a forbidden control character");
    }
    if (!safeTargetUrl(item.targetUrl)) throw new Error("Target URL must be an absolute HTTP(S) URL without credentials");
  }
  const packetItems = input.items.map((item) => ({
    orderItemId: item.orderItemId,
    assignedAdminId: item.assignedAdminId,
    reference: item.reference,
    placementRequirements: [...item.placementRequirements],
    targetUrl: item.targetUrl,
    anchorText: item.anchorText,
    article: item.article,
    instructions: item.instructions,
    consent: { ...item.consent },
  }));
  const snapshot = {
    id: input.packetId,
    version: input.version,
    organizationId: first.organizationId,
    orderId: first.orderId,
    supplierId: first.supplierId,
    recipient: normalizeEmail(input.recipient),
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    items: packetItems,
  };
  const frozenItems = packetItems.map((item) => Object.freeze({ ...item, placementRequirements: Object.freeze([...item.placementRequirements]), consent: Object.freeze({ ...item.consent }) }));
  return Object.freeze({ ...snapshot, contentHash: hashCanonical(snapshot), items: Object.freeze(frozenItems) });
}

export function renderSupplierEmail(packet: SupplierPacket, maxEmlBytes: number, pdfAttachment?: Uint8Array): { subject: string; text: string; eml: string } {
  if (!Number.isSafeInteger(maxEmlBytes) || maxEmlBytes < 1) throw new Error("Configured EML size limit is invalid");
  const delivery = supplierDeliveryProjection(packet);
  const lines = [
    `GPHKM publication instructions (${delivery.id} v${delivery.version})`,
    "",
    ...delivery.items.flatMap((item, index) => [
      `Placement ${index + 1} — ${item.reference}`,
      ...item.placementRequirements.map((requirement) => `Requirement: ${requirement}`),
      `Target URL: ${item.targetUrl}`,
      `Anchor text: ${item.anchorText}`,
      "Article:",
      item.article,
      ...(item.instructions ? ["Additional instructions:", item.instructions] : []),
      "",
    ]),
    `Packet reference: ${delivery.id}`,
  ];
  const subject = `GPHKM publication instructions ${delivery.id}`;
  const text = lines.join("\r\n");
  const body = Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const boundary = `gphkm_${delivery.id.replace(/[^A-Za-z0-9_-]/g, "_")}_${delivery.version}`;
  const parts = [
    `To: ${delivery.recipient}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    ...(pdfAttachment ? [`Content-Type: multipart/mixed; boundary=\"${boundary}\"`, "", `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body, `--${boundary}`, 'Content-Type: application/pdf; name="publication-instructions.pdf"', 'Content-Disposition: attachment; filename="publication-instructions.pdf"', "Content-Transfer-Encoding: base64", "", Buffer.from(pdfAttachment).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "", `--${boundary}--`, ""] : ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body, ""]),
  ];
  const eml = parts.join("\r\n");
  if (Buffer.byteLength(eml, "utf8") > maxEmlBytes) throw new Error("EML exceeds the configured packet size limit");
  return { subject, text, eml };
}

export type PacketAttemptState = "READY" | "SENDING" | "ACCEPTED" | "DELIVERED" | "DELIVERY_ISSUE" | "UNKNOWN" | "MANUAL_EXPORTED" | "MANUAL_SENT" | "RECONCILED_FAILED";

export function assertPacketActionable(input: { superseded: boolean; holdReason: string | null }, allowSizeReview = false): void {
  if (input.superseded) throw new Error("Packet version has been superseded");
  if (input.holdReason && !(allowSizeReview && input.holdReason === "PACKET_SIZE_REVIEW")) {
    throw new Error("Packet is held for staff review");
  }
}

export function assertCompletePacketReplacement(priorItemIds: readonly string[], selectedItemIds: ReadonlySet<string>): void {
  if (priorItemIds.some((itemId) => !selectedItemIds.has(itemId))) {
    throw new Error("Select every item in the existing packet before preparing a replacement version");
  }
}

export function mayStartManualPacketHandoff(items: readonly { state: string; handedOffAt: Date | null; workStartedAt: Date | null }[], hasResendReason: boolean): boolean {
  if (!items.length) return false;
  const firstHandoff = items.every((item) => item.state === "HANDOFF_PENDING" && !item.handedOffAt && !item.workStartedAt);
  const deliberateResend = hasResendReason && items.every((item) => item.state === "IN_FULFILLMENT" && item.handedOffAt !== null);
  return firstHandoff || deliberateResend;
}

const PROVIDER_ATTEMPT_TRANSITIONS: Partial<Record<PacketAttemptState, readonly PacketAttemptState[]>> = {
  SENDING: ["ACCEPTED", "DELIVERED", "UNKNOWN", "DELIVERY_ISSUE", "RECONCILED_FAILED"],
  UNKNOWN: ["ACCEPTED", "DELIVERED", "DELIVERY_ISSUE", "RECONCILED_FAILED"],
  ACCEPTED: ["DELIVERED", "DELIVERY_ISSUE"],
  DELIVERY_ISSUE: ["DELIVERED"],
};

export function monotonicProviderAttemptState(current: PacketAttemptState, reported: PacketAttemptState): PacketAttemptState {
  return current === reported || PROVIDER_ATTEMPT_TRANSITIONS[current]?.includes(reported) ? reported : current;
}

export type PacketAttempt = Readonly<{
  id: string;
  packetId: string;
  packetVersion: number;
  actorId: string;
  recipient: string;
  state: PacketAttemptState;
  createdAt: string;
  acceptedAt?: string;
  deliveredAt?: string;
  providerReference?: string;
  sentAt?: string;
  unknownAt?: string;
  resolvedAt?: string;
}>;

export function mayStartSend(input: { packet: SupplierPacket; attempts: readonly PacketAttempt[]; actorRole: StaffRole; actorId: string; revalidatedPacketHash: string; currentRecipient: string; deliberateResend?: boolean; resendReason?: string }): void {
  if (input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Staff role cannot send supplier packets");
  if (input.actorRole === "ADMIN" && input.packet.items.some((item) => item.assignedAdminId !== input.actorId)) throw new Error("Admin is not assigned to every packet item");
  if (input.revalidatedPacketHash !== input.packet.contentHash || normalizeEmail(input.currentRecipient) !== input.packet.recipient) throw new Error("Packet changed after preview; create a new packet version");
  const latest = [...input.attempts].filter((attempt) => attempt.packetId === input.packet.id && attempt.packetVersion === input.packet.version && attempt.state !== "MANUAL_EXPORTED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest?.state === "UNKNOWN" || latest?.state === "SENDING") throw new Error("Resolve the current send outcome before another send");
  if (latest && (!input.deliberateResend || !input.resendReason?.trim())) throw new Error("A prior send exists; an audited deliberate resend reason is required");
}

export function markUnknownAttempt(attempt: PacketAttempt, at: string): PacketAttempt {
  if (attempt.state !== "SENDING") throw new Error("Only a pending send can enter unknown outcome");
  return { ...attempt, state: "UNKNOWN", unknownAt: at };
}

export function startPacketAttempt(input: { packet: SupplierPacket; id: string; actorId: string; actorRole: StaffRole; attempts: readonly PacketAttempt[]; revalidatedPacketHash: string; currentRecipient: string; at: string; deliberateResend?: boolean; resendReason?: string }): PacketAttempt {
  mayStartSend(input);
  requireEventFields(input.id, input.actorId, input.at);
  return Object.freeze({ id: input.id, packetId: input.packet.id, packetVersion: input.packet.version, actorId: input.actorId, recipient: input.packet.recipient, state: "SENDING", createdAt: input.at });
}

export function markProviderAccepted(input: { attempt: PacketAttempt; providerReference: string; acceptedAt: string }): PacketAttempt {
  requireEventFields(input.providerReference, input.acceptedAt);
  if (input.attempt.state === "ACCEPTED" && input.attempt.providerReference === input.providerReference && input.attempt.acceptedAt === input.acceptedAt) return input.attempt;
  if (input.attempt.state === "ACCEPTED") throw new Error("Conflicting provider acceptance evidence requires reconciliation");
  if (input.attempt.state !== "SENDING" && input.attempt.state !== "UNKNOWN") throw new Error("Only a pending or unknown attempt may be marked provider-accepted");
  return Object.freeze({ ...input.attempt, state: "ACCEPTED", acceptedAt: input.acceptedAt, providerReference: input.providerReference, ...(input.attempt.state === "UNKNOWN" ? { resolvedAt: input.acceptedAt } : {}) });
}

export function markProviderDelivered(input: { attempt: PacketAttempt; deliveredAt: string; providerReference: string }): PacketAttempt {
  requireEventFields(input.deliveredAt, input.providerReference);
  if (input.attempt.state === "DELIVERED" && input.attempt.providerReference === input.providerReference && input.attempt.deliveredAt === input.deliveredAt) return input.attempt;
  if (input.attempt.state === "DELIVERED") throw new Error("Conflicting delivery evidence requires reconciliation");
  if (input.attempt.providerReference && input.attempt.providerReference !== input.providerReference) throw new Error("Provider reference mismatch requires reconciliation");
  if (input.attempt.state !== "ACCEPTED" && input.attempt.state !== "SENDING" && input.attempt.state !== "UNKNOWN") throw new Error("Delivery confirmation requires a pending or accepted attempt");
  return Object.freeze({ ...input.attempt, state: "DELIVERED", deliveredAt: input.deliveredAt, providerReference: input.providerReference, ...(input.attempt.state === "UNKNOWN" ? { resolvedAt: input.deliveredAt } : {}) });
}

export function resolveUnknownAttempt(input: { attempt: PacketAttempt; outcome: "ACCEPTED" | "DELIVERY_ISSUE" | "RECONCILED_FAILED"; actorId: string; actorRole: StaffRole; at: string; reason: string; providerReference?: string; providerAcceptedAt?: string }): PacketAttempt {
  if (input.attempt.state !== "UNKNOWN" || !input.actorId.trim() || !input.reason.trim() || (input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN")) throw new Error("Unknown outcome reconciliation requires an authorized recorded decision");
  if ((input.outcome === "ACCEPTED" || input.outcome === "DELIVERY_ISSUE")
    && (!input.providerReference?.trim() || !input.providerAcceptedAt || !Number.isFinite(Date.parse(input.providerAcceptedAt)))) {
    throw new Error("Provider acceptance evidence requires a message reference and acceptance time");
  }
  return Object.freeze({ ...input.attempt, state: input.outcome, resolvedAt: input.at, ...(input.providerReference ? { providerReference: input.providerReference } : {}), ...(input.providerAcceptedAt ? { acceptedAt: input.providerAcceptedAt } : {}) });
}

export function deliveryFollowUpAt(attempt: PacketAttempt): string | null {
  if (attempt.state !== "ACCEPTED" || !attempt.acceptedAt) return null;
  return new Date(Date.parse(attempt.acceptedAt) + 72 * 60 * 60 * 1000).toISOString();
}

export function acknowledgementFollowUpAt(deliveredAt: string | undefined, manualSentAt: string | undefined): string | null {
  const start = deliveredAt ?? manualSentAt;
  if (!start || !Number.isFinite(Date.parse(start))) return null;
  return new Date(Date.parse(start) + 72 * 60 * 60 * 1000).toISOString();
}

export function mayRequestOrdinaryCancellation(item: ItemSnapshot, persistedHandoff?: PersistedHandoffState): boolean {
  if (item.state === "CANCELED_REFUNDED" || item.state === "COMPLETED" || item.state === "CANCELLATION_REQUESTED") return false;
  if (item.state === "HANDOFF_PENDING") {
    if (persistedHandoff?.source !== "PERSISTED") return false;
    if (!["READY", "MANUAL_EXPORTED", "RECONCILED_FAILED"].includes(persistedHandoff.state)) return false;
  }
  return !item.handedOffAt && !item.workStartedAt;
}

export type ManualHandoffRecord = Readonly<{
  packetId: string;
  packetVersion: number;
  actorId: string;
  recipient: string;
  sentAt: string;
  messageReference: string;
  evidence?: Readonly<{ format: "eml" | "pdf"; sizeBytes: number; objectKey: string }>;
}>;

export function recordManualHandoff(input: {
  packet: SupplierPacket;
  actorId: string;
  actorRole: StaffRole;
  sentAt: string;
  actualRecipient: string;
  messageReference: string;
  evidence?: ManualHandoffRecord["evidence"];
  maxEvidenceBytes: number;
}): ManualHandoffRecord {
  if (input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Staff role cannot attest supplier handoff");
  if (input.actorRole === "ADMIN" && input.packet.items.some((item) => item.assignedAdminId !== input.actorId)) throw new Error("Admin is not assigned to every packet item");
  if (!input.actorId.trim() || !Number.isFinite(Date.parse(input.sentAt)) || !input.messageReference.trim()) throw new Error("Manual handoff requires actor, sent time, and message reference");
  if (Date.parse(input.sentAt) < Date.parse(input.packet.createdAt)) throw new Error("Manual handoff time cannot precede packet creation");
  if (!isValidRecipient(input.actualRecipient)) throw new Error("Actual recipient is invalid");
  const actualRecipient = normalizeEmail(input.actualRecipient);
  if (actualRecipient !== input.packet.recipient) throw new Error("Recipient differs from the consent-bound packet; create a new version with fresh consent");
  if (input.evidence && (!Number.isSafeInteger(input.evidence.sizeBytes) || input.evidence.sizeBytes < 1 || input.evidence.sizeBytes > input.maxEvidenceBytes || !input.evidence.objectKey.trim())) {
    throw new Error("Manual evidence is invalid or exceeds the configured size limit");
  }
  if (input.evidence && !["eml", "pdf"].includes(input.evidence.format)) throw new Error("Manual evidence format is not allowed");
  return Object.freeze({
    packetId: input.packet.id,
    packetVersion: input.packet.version,
    actorId: input.actorId,
    recipient: actualRecipient,
    sentAt: input.sentAt,
    messageReference: input.messageReference.trim(),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
}

export function manualSentAttempt(input: { packet: SupplierPacket; handoff: ManualHandoffRecord; id: string }): PacketAttempt {
  requireEventFields(input.id, input.handoff.actorId, input.handoff.sentAt);
  if (input.handoff.packetId !== input.packet.id || input.handoff.packetVersion !== input.packet.version || input.handoff.recipient !== input.packet.recipient) throw new Error("Manual handoff evidence does not match the packet snapshot");
  return Object.freeze({ id: input.id, packetId: input.packet.id, packetVersion: input.packet.version, actorId: input.handoff.actorId, recipient: input.handoff.recipient, state: "MANUAL_SENT", createdAt: input.handoff.sentAt, sentAt: input.handoff.sentAt, providerReference: input.handoff.messageReference });
}

export function recordManualExportAttempt(input: { packet: SupplierPacket; id: string; actorId: string; actorRole: StaffRole; at: string }): PacketAttempt {
  if (input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Staff role cannot export supplier packets");
  if (input.actorRole === "ADMIN" && input.packet.items.some((item) => item.assignedAdminId !== input.actorId)) throw new Error("Admin is not assigned to every packet item");
  requireEventFields(input.id, input.actorId, input.at);
  return Object.freeze({ id: input.id, packetId: input.packet.id, packetVersion: input.packet.version, actorId: input.actorId, recipient: input.packet.recipient, state: "MANUAL_EXPORTED", createdAt: input.at });
}

export function isValidRecipient(value: string): boolean {
  if (/[\r\n\0]/.test(value) || value.length > 254) return false;
  const normalized = value.trim();
  return normalized === value && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function safeTargetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
}

function encodeHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Mail header contains forbidden control characters");
  return value.replace(/[^\x20-\x7e]/g, "?");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function supplierShareContentHash(item: Pick<PacketItemInput, "placementRequirements" | "targetUrl" | "anchorText" | "article" | "instructions">): string {
  return hashCanonical({ placementRequirements: item.placementRequirements, targetUrl: item.targetUrl, anchorText: item.anchorText, article: item.article, instructions: item.instructions });
}

function requireEventFields(...values: string[]): void {
  if (values.some((value) => !value.trim() || /[\r\n\0]/.test(value))) throw new Error("Event identity or timestamp is invalid");
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
