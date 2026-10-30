import "server-only";
import type { StaffRole } from "./workflow.ts";

export type CaseState = "OPEN" | "INVESTIGATING" | "WAITING_ON_CUSTOMER" | "WAITING_ON_SUPPLIER" | "FINANCE_REVIEW" | "RESOLVED" | "CLOSED";
export type CustomerCaseStatus = "RECEIVED" | "IN_REVIEW" | "WAITING_ON_YOU" | "RESOLVED";

export type SupportCase = Readonly<{
  id: string;
  organizationId: string;
  openedByUserId: string;
  orderId: string;
  orderItemId: string;
  state: CaseState;
  customerSummary: string;
  assignedAdminId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CaseHistoryEvent = Readonly<{
  id: string;
  caseId: string;
  actorId: string;
  at: string;
  type: "OPENED" | "STATE_CHANGED" | "CUSTOMER_REPLY" | "INTERNAL_NOTE" | "REFUND_DECISION";
  from?: CaseState;
  to?: CaseState;
  body?: string;
  decision?: "APPROVED" | "DENIED";
  amountMinor?: number;
  walletCreditId?: string;
  reason?: string;
}>;

const transitions: Readonly<Record<CaseState, readonly CaseState[]>> = {
  OPEN: ["INVESTIGATING", "WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  INVESTIGATING: ["WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  WAITING_ON_CUSTOMER: ["INVESTIGATING", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  WAITING_ON_SUPPLIER: ["INVESTIGATING", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  FINANCE_REVIEW: ["INVESTIGATING", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

export function openSupportCase(input: {
  id: string;
  organizationId: string;
  openedByUserId: string;
  orderId: string;
  orderItemId: string;
  summary: string;
  at: string;
}): { supportCase: SupportCase; event: CaseHistoryEvent } {
  const summary = validateText(input.summary, "summary", 2_000);
  requireIdentity(input.id, input.organizationId, input.openedByUserId, input.orderId, input.orderItemId);
  requireTimestamp(input.at);
  const supportCase: SupportCase = Object.freeze({
    id: input.id,
    organizationId: input.organizationId,
    openedByUserId: input.openedByUserId,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    state: "OPEN",
    customerSummary: summary,
    createdAt: input.at,
    updatedAt: input.at,
  });
  return { supportCase, event: { id: `case-open:${input.id}`, caseId: input.id, actorId: input.openedByUserId, at: input.at, type: "OPENED", to: "OPEN", body: summary } };
}

export function customerCaseStatus(state: CaseState): CustomerCaseStatus {
  switch (state) {
    case "OPEN": return "RECEIVED";
    case "INVESTIGATING":
    case "WAITING_ON_SUPPLIER":
    case "FINANCE_REVIEW": return "IN_REVIEW";
    case "WAITING_ON_CUSTOMER": return "WAITING_ON_YOU";
    case "RESOLVED":
    case "CLOSED": return "RESOLVED";
  }
}

export function canViewCase(input: {
  caseRecord: SupportCase;
  actorType: "CUSTOMER" | "STAFF";
  userId: string;
  organizationId?: string;
  organizationRole?: "OWNER" | "MEMBER";
  isOwnOrder?: boolean;
  actorRole?: StaffRole;
  assignedAdminId?: string;
}): boolean {
  if (input.actorType === "CUSTOMER") {
    if (!input.organizationId || input.organizationId !== input.caseRecord.organizationId) return false;
    if (input.organizationRole === "OWNER") return true;
    return input.organizationRole === "MEMBER" && (input.userId === input.caseRecord.openedByUserId || input.isOwnOrder === true);
  }
  if (input.actorRole === "SUPER_ADMIN") return true;
  if (input.actorRole === "ADMIN") return input.assignedAdminId === input.userId;
  if (input.actorRole === "FINANCE") return input.caseRecord.state === "FINANCE_REVIEW";
  return false;
}

export function transitionSupportCase(input: {
  caseRecord: SupportCase;
  to: CaseState;
  actorId: string;
  actorRole: StaffRole;
  at: string;
  eventId: string;
  reason?: string;
  financialDecision?: CaseHistoryEvent;
}): { supportCase: SupportCase; event: CaseHistoryEvent } {
  requireIdentity(input.actorId, input.eventId);
  requireTimestamp(input.at);
  if (!transitions[input.caseRecord.state].includes(input.to)) throw new Error(`Invalid case transition: ${input.caseRecord.state} -> ${input.to}`);
  if (input.to === "FINANCE_REVIEW" && input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Only Admin or Super Admin may refer a case to Finance review");
  if (input.caseRecord.state === "FINANCE_REVIEW" && input.to !== "FINANCE_REVIEW" && input.actorRole !== "FINANCE" && input.actorRole !== "SUPER_ADMIN") {
    throw new Error("Only Finance or Super Admin may act on a financial review");
  }
  if (input.caseRecord.state === "FINANCE_REVIEW" && input.to !== "FINANCE_REVIEW" && (input.financialDecision?.caseId !== input.caseRecord.id || input.financialDecision.type !== "REFUND_DECISION" || input.financialDecision.actorId !== input.actorId)) {
    throw new Error("A recorded decision by the acting Finance reviewer is required before leaving review");
  }
  if ((input.to === "RESOLVED" || input.to === "CLOSED") && !input.reason?.trim()) throw new Error("Case resolution requires a recorded reason");
  const supportCase = Object.freeze({ ...input.caseRecord, state: input.to, updatedAt: input.at });
  const event: CaseHistoryEvent = Object.freeze({
    id: input.eventId,
    caseId: input.caseRecord.id,
    actorId: input.actorId,
    at: input.at,
    type: "STATE_CHANGED",
    from: input.caseRecord.state,
    to: input.to,
    ...(input.reason ? { reason: input.reason.trim() } : {}),
  });
  return { supportCase, event };
}

export function appendCaseReply(input: {
  supportCase: SupportCase;
  actorId: string;
  actorRole?: StaffRole;
  audience: "CUSTOMER" | "INTERNAL";
  customerOrganizationId?: string;
  customerOrganizationRole?: "OWNER" | "MEMBER";
  customerOwnsOrder?: boolean;
  body: string;
  at: string;
  eventId: string;
}): CaseHistoryEvent {
  requireIdentity(input.actorId, input.eventId);
  requireTimestamp(input.at);
  if (input.supportCase.state === "CLOSED") throw new Error("Closed cases cannot receive new replies");
  const body = validateText(input.body, "reply", 4_000);
  if (input.audience === "INTERNAL" && !input.actorRole) throw new Error("Only staff may add internal notes");
  if (input.audience === "CUSTOMER" && input.actorRole && input.actorRole !== "ADMIN" && input.actorRole !== "SUPER_ADMIN") throw new Error("Finance-only staff cannot send customer case replies");
  if (input.audience === "CUSTOMER" && !input.actorRole && !canViewCase({
    caseRecord: input.supportCase,
    actorType: "CUSTOMER",
    userId: input.actorId,
    organizationId: input.customerOrganizationId,
    organizationRole: input.customerOrganizationRole,
    isOwnOrder: input.customerOwnsOrder,
  })) throw new Error("Customer cannot reply to this organization case");
  return Object.freeze({
    id: input.eventId,
    caseId: input.supportCase.id,
    actorId: input.actorId,
    at: input.at,
    type: input.audience === "INTERNAL" ? "INTERNAL_NOTE" : "CUSTOMER_REPLY",
    body,
  });
}

export function decidePostHandoffRefund(input: {
  supportCase: SupportCase;
  actorId: string;
  actorRole: StaffRole;
  decision: "APPROVED" | "DENIED";
  amountMinor: number;
  itemPaidMinor: number;
  walletCreditId?: string;
  walletCreditMinor?: number;
  reason: string;
  at: string;
  eventId: string;
}): CaseHistoryEvent {
  requireIdentity(input.actorId, input.eventId);
  requireTimestamp(input.at);
  if (input.supportCase.state !== "FINANCE_REVIEW") throw new Error("Post-handoff refund decision requires Finance Review state");
  if (input.actorRole !== "FINANCE" && input.actorRole !== "SUPER_ADMIN") throw new Error("Only Finance or Super Admin may decide a post-handoff refund");
  if (!input.reason.trim() || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > input.itemPaidMinor) {
    throw new Error("Refund decision requires reason and an exact amount within the item charge");
  }
  if (input.decision === "APPROVED" && (!input.walletCreditId?.trim() || input.walletCreditMinor !== input.amountMinor)) throw new Error("Approved refund must reference a posted wallet credit for the exact approved amount");
  if (input.decision === "DENIED" && (input.walletCreditId || input.walletCreditMinor !== undefined)) throw new Error("Denied refund cannot reference a wallet credit");
  return Object.freeze({
    id: input.eventId,
    caseId: input.supportCase.id,
    actorId: input.actorId,
    at: input.at,
    type: "REFUND_DECISION",
    decision: input.decision,
    amountMinor: input.amountMinor,
    ...(input.walletCreditId ? { walletCreditId: input.walletCreditId } : {}),
    reason: input.reason.trim(),
  });
}

export function customerCaseProjection(input: { supportCase: SupportCase; events: readonly CaseHistoryEvent[] }) {
  return Object.freeze({
    id: input.supportCase.id,
    orderId: input.supportCase.orderId,
    orderItemId: input.supportCase.orderItemId,
    status: customerCaseStatus(input.supportCase.state),
    summary: input.supportCase.customerSummary,
    updatedAt: input.supportCase.updatedAt,
    messages: input.events.filter((event) => event.type === "CUSTOMER_REPLY" && event.body).map((event) => ({ id: event.id, at: event.at, body: event.body! })),
  });
}

export function staffCaseProjection(input: {
  supportCase: SupportCase;
  events: readonly CaseHistoryEvent[];
  userId: string;
  actorRole: StaffRole;
  assignedAdminId?: string;
}) {
  if (!canViewCase({ caseRecord: input.supportCase, actorType: "STAFF", userId: input.userId, actorRole: input.actorRole, assignedAdminId: input.assignedAdminId })) {
    throw new Error("Staff member cannot view this case");
  }
  const events = input.actorRole === "ADMIN"
    ? input.events.filter((event) => event.type !== "REFUND_DECISION")
    : input.events;
  return Object.freeze({
    id: input.supportCase.id,
    organizationId: input.supportCase.organizationId,
    orderId: input.supportCase.orderId,
    orderItemId: input.supportCase.orderItemId,
    state: input.supportCase.state,
    summary: input.supportCase.customerSummary,
    assignedAdminId: input.supportCase.assignedAdminId ?? null,
    updatedAt: input.supportCase.updatedAt,
    events: events.map((event) => ({
      id: event.id,
      at: event.at,
      type: event.type,
      ...(event.body ? { body: event.body } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.decision ? { decision: event.decision } : {}),
      ...(event.amountMinor !== undefined ? { amountMinor: event.amountMinor } : {}),
      ...(event.walletCreditId ? { walletCreditId: event.walletCreditId } : {}),
    })),
  });
}

function validateText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength || /\0/.test(normalized)) throw new Error(`${label} must be nonempty text up to ${maxLength} characters`);
  return normalized;
}

function requireIdentity(...values: string[]): void {
  if (values.some((value) => !value.trim() || value.length > 200 || /[\0\r\n]/.test(value))) throw new Error("Case identity values are invalid");
}

function requireTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Case timestamp is invalid");
}
