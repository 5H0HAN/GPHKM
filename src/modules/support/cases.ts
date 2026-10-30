export const SUPPORT_STATES = ["OPEN", "INVESTIGATING", "WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW", "RESOLVED", "CLOSED"] as const;
export type SupportState = typeof SUPPORT_STATES[number];
export type SupportAudience = "CUSTOMER" | "INTERNAL" | "FINANCE";
export type FinanceOutcome = "DENIED" | "MORE_INFORMATION_REQUIRED";

const transitions: Record<SupportState, readonly SupportState[]> = {
  OPEN: ["INVESTIGATING", "WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  INVESTIGATING: ["WAITING_ON_CUSTOMER", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  WAITING_ON_CUSTOMER: ["INVESTIGATING", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  WAITING_ON_SUPPLIER: ["INVESTIGATING", "FINANCE_REVIEW", "RESOLVED", "CLOSED"],
  FINANCE_REVIEW: [], // Only the dedicated recorded Finance decision can leave review.
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

export function supportText(value: unknown, maximum = 4000): string {
  if (typeof value !== "string") throw new Error("Enter a text message");
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new Error(`Enter nonempty text up to ${maximum} characters`);
  }
  return text;
}

export function supportState(value: string): SupportState {
  if (!SUPPORT_STATES.includes(value as SupportState)) throw new Error("Invalid case state");
  return value as SupportState;
}

export function allowedSupportTransitions(state: SupportState): readonly SupportState[] { return transitions[state]; }

export function assertSupportTransition(from: SupportState, to: SupportState, role: string): void {
  if (role !== "ADMIN" && role !== "SUPER_ADMIN") throw new Error("Forbidden");
  if (!transitions[from].includes(to)) throw new Error("Case transition is not allowed");
}

export function financeOutcome(value: string): FinanceOutcome {
  if (value !== "DENIED" && value !== "MORE_INFORMATION_REQUIRED") throw new Error("Refund execution is not available in this workflow");
  return value;
}

export function customerSupportStatus(state: string) {
  if (state === "OPEN") return "Received";
  if (state === "WAITING_ON_CUSTOMER") return "Waiting on you";
  if (state === "RESOLVED" || state === "CLOSED") return "Resolved";
  return "In review";
}

export function customerSupportProjection(row: { id: string; orderId: string; orderItemId: string; summary: string; state: string; createdAt: Date; updatedAt: Date }, events: readonly { id: string; audience: string; kind: string; actorKind: string; body: string; createdAt: Date }[] = []) {
  return {
    id: row.id, orderId: row.orderId, orderItemId: row.orderItemId, summary: row.summary,
    status: customerSupportStatus(row.state), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    messages: events.filter((event) => event.audience === "CUSTOMER" && event.kind === "REPLY").map((event) => ({
      id: event.id, from: event.actorKind === "CUSTOMER" ? "Customer" : "GPHKM", body: event.body, at: event.createdAt.toISOString(),
    })),
  };
}
