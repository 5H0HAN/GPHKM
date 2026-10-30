import type { StaffRole } from "./workflow";

const milestones = {
  ORDER_RECEIVED: "ORDER_RECEIVED",
  CONTENT_REVIEW: "CONTENT_REVIEW",
  PREPARING_YOUR_PLACEMENT: "PREPARING",
  PUBLICATION_IN_PROGRESS: "IN_PROGRESS",
  LINK_VERIFICATION: "LINK_VERIFICATION",
  COMPLETE_RESOLVED: "COMPLETE",
} as const;

export const contentReviewReasonOptions = [
  { value: "CONTENT_ILLEGAL_ABUSIVE", label: "Potentially illegal or abusive content" },
  { value: "CONTENT_PHISHING_MALWARE", label: "Phishing or malware concern" },
  { value: "CONTENT_RIGHTS_UNCONFIRMED", label: "Content or link rights need confirmation" },
  { value: "CONTENT_LISTING_REQUIREMENT", label: "Listing requirement needs correction" },
  { value: "CONTENT_SENSITIVE_TOPIC", label: "Sensitive topic needs review" },
] as const;

export function mayReadFulfillmentContent(input: { role: StaffRole; userId: string; assignedAdminId: string | null }): boolean {
  return input.role === "SUPER_ADMIN" || (input.role === "ADMIN" && input.assignedAdminId === input.userId);
}

export function mayAssignFulfillment(role: StaffRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function customerStatusForMilestone(milestone: keyof typeof milestones, state: string): string {
  if (state === "CANCELED_REFUNDED") return "RESOLVED";
  if (state === "COMPLETED") return "COMPLETE";
  return milestones[milestone];
}

export function validatePublicationUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("Enter a valid live publication URL");
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid live publication URL"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
    throw new Error("Enter a valid live publication URL");
  }
  return url.toString();
}

export function validateNextUpdate(value: unknown, now = new Date()): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a next-update date");
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getTime() <= now.getTime() || date.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1000) {
    throw new Error("Next-update time must be in the next year");
  }
  return date;
}

export function isFulfillmentOverdue(nextUpdateAt: Date | null, state: string, now = new Date()): boolean {
  return nextUpdateAt !== null
    && nextUpdateAt.getTime() <= now.getTime()
    && state !== "COMPLETED"
    && state !== "CANCELED_REFUNDED";
}

export function customerSafeFulfillmentProjection(input: {
  id: string;
  customerStatus: string;
  updatedAt: Date;
  nextUpdateAt: Date | null;
}) {
  return {
    id: input.id,
    status: input.customerStatus,
    lastUpdatedAt: input.updatedAt.toISOString(),
    nextUpdateAt: input.nextUpdateAt?.toISOString() ?? null,
  } as const;
}

export function fulfillmentFollowUpUpdate(input: {
  role: StaffRole; userId: string; assignedAdminId: string | null;
  state: string; nextUpdateAt: string; reasonCode: string;
}, now = new Date()) {
  if (!mayReadFulfillmentContent(input)) throw new Error("Item unavailable");
  if (input.state === "COMPLETED" || input.state === "CANCELED_REFUNDED") throw new Error("Completed items do not need a follow-up");
  if (input.reasonCode !== "PUBLICATION_UPDATE") throw new Error("Invalid follow-up reason");
  return { nextUpdateAt: validateNextUpdate(input.nextUpdateAt, now), updatedAt: now };
}

const transitions: Record<string, { value: string; label: string }[]> = {
  CONFIRMED: [{ value: "CONTENT_PREPARATION", label: "Start content review" }, { value: "ON_HOLD", label: "Place on hold" }],
  CONTENT_PREPARATION: [{ value: "AWAITING_CUSTOMER_APPROVAL", label: "Request customer approval" }, { value: "READY_FOR_HANDOFF", label: "Mark ready for placement" }, { value: "ON_HOLD", label: "Place on hold" }],
  AWAITING_CUSTOMER_APPROVAL: [{ value: "CONTENT_PREPARATION", label: "Resume content review" }, { value: "READY_FOR_HANDOFF", label: "Mark ready for placement" }, { value: "ON_HOLD", label: "Place on hold" }],
  READY_FOR_HANDOFF: [{ value: "HANDOFF_PENDING", label: "Prepare placement" }, { value: "IN_FULFILLMENT", label: "Start placement work" }, { value: "ON_HOLD", label: "Place on hold" }],
  HANDOFF_PENDING: [{ value: "IN_FULFILLMENT", label: "Start placement work" }, { value: "ON_HOLD", label: "Place on hold" }],
  IN_FULFILLMENT: [{ value: "PUBLICATION_PENDING", label: "Start link verification" }, { value: "ON_HOLD", label: "Place on hold" }],
  PUBLICATION_PENDING: [{ value: "EVIDENCE_REVIEW", label: "Review evidence" }, { value: "ON_HOLD", label: "Place on hold" }],
  EVIDENCE_REVIEW: [{ value: "PUBLICATION_PENDING", label: "Continue link verification" }, { value: "ON_HOLD", label: "Place on hold" }],
  ON_HOLD: [{ value: "CONFIRMED", label: "Resume order received" }, { value: "CONTENT_PREPARATION", label: "Resume content review" }, { value: "AWAITING_CUSTOMER_APPROVAL", label: "Resume customer approval" }, { value: "READY_FOR_HANDOFF", label: "Resume placement preparation" }, { value: "HANDOFF_PENDING", label: "Resume placement preparation" }, { value: "IN_FULFILLMENT", label: "Resume placement work" }, { value: "PUBLICATION_PENDING", label: "Resume link verification" }, { value: "EVIDENCE_REVIEW", label: "Resume evidence review" }],
};

export function fulfillmentTransitionChoices(state: string, stateBeforeHold: string | null, hasSupplier: boolean, writingApproved = true) {
  return (transitions[state] ?? []).filter((choice) =>
    (state !== "ON_HOLD" || choice.value === stateBeforeHold)
    && (writingApproved || !["READY_FOR_HANDOFF", "HANDOFF_PENDING", "IN_FULFILLMENT"].includes(choice.value))
    && (choice.value !== "IN_FULFILLMENT" || !hasSupplier || state === "ON_HOLD"));
}
