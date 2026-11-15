import type { StaffRole } from "./workflow";

const milestones = {
  ORDER_RECEIVED: "ORDER_RECEIVED",
  CONTENT_REVIEW: "CONTENT_REVIEW",
  PREPARING_YOUR_PLACEMENT: "PREPARING",
  PUBLICATION_IN_PROGRESS: "IN_PROGRESS",
  LINK_VERIFICATION: "LINK_VERIFICATION",
  COMPLETE_RESOLVED: "COMPLETE",
} as const;

export const customerOrderStages = [
  ["ORDER_RECEIVED", "Order received"],
  ["CONTENT_REVIEW", "Content review"],
  ["PREPARING", "Preparing your placement"],
  ["IN_PROGRESS", "Publication in progress"],
  ["LINK_VERIFICATION", "Link verification"],
  ["COMPLETE", "Complete"],
] as const;

export function customerStageSummary(status: string) {
  const index = customerOrderStages.findIndex(([value]) => value === status);
  const resolved = status === "RESOLVED";
  return {
    index,
    label: resolved ? "Resolved" : index >= 0 ? customerOrderStages[index][1] : "Status unavailable",
    stageNumber: index >= 0 ? index + 1 : null,
    totalStages: customerOrderStages.length,
    resolved,
  };
}

export const contentReviewReasonOptions = [
  { value: "CONTENT_ILLEGAL_ABUSIVE", label: "Potentially illegal or abusive content", description: "Pause while an Admin reviews a possible policy or safety issue." },
  { value: "CONTENT_PHISHING_MALWARE", label: "Possible phishing or malware", description: "Pause if the content or destination may be unsafe." },
  { value: "CONTENT_RIGHTS_UNCONFIRMED", label: "Content or link rights need confirmation", description: "Pause until the customer confirms they have the required rights." },
  { value: "CONTENT_LISTING_REQUIREMENT", label: "Listing requirements need correction", description: "Pause when the content does not meet this placement's requirements." },
  { value: "CONTENT_SENSITIVE_TOPIC", label: "Sensitive topic needs review", description: "Pause for a review against the listing terms." },
] as const;

const contentReviewReasonCodes = new Set<string>(contentReviewReasonOptions.map(({ value }) => value));

export function fulfillmentReasonCodeForTransition(from: string, to: string, holdReasonCode?: string): string {
  if (to === "ON_HOLD") {
    const reason = holdReasonCode || "PAUSED_FOR_REVIEW";
    if (reason === "PAUSED_FOR_REVIEW" || contentReviewReasonCodes.has(reason)) return reason;
    throw new Error("Choose a valid reason for pausing this placement");
  }
  if (from === "ON_HOLD") return "RESUMED_WORK";

  const reasons: Record<string, string> = {
    CONTENT_PREPARATION: "CONTENT_REVIEW",
    AWAITING_CUSTOMER_APPROVAL: "CUSTOMER_ACTION_NEEDED",
    READY_FOR_HANDOFF: "CONTENT_APPROVED",
    IN_FULFILLMENT: "FULFILLMENT_STARTED",
    PUBLICATION_PENDING: "PUBLICATION_UPDATE",
    EVIDENCE_REVIEW: "EVIDENCE_RECORDED",
  };
  const reason = reasons[to];
  if (!reason) throw new Error("Choose a valid next step");
  return reason;
}

export function fulfillmentTransitionGuidance(from: string, to: string): string {
  if (from === "ON_HOLD") return "Choose this to continue from the step saved when the placement was paused. The customer stage stays where it is until the work step changes it.";
  if (to === "CONTENT_PREPARATION") {
    return from === "AWAITING_CUSTOMER_APPROVAL"
      ? "Use this after the customer asks for a revision. The customer remains at Content review while the article is updated."
      : "Use this when an Admin begins reviewing the article and placement requirements. This moves the customer from Order received to Content review.";
  }
  if (to === "AWAITING_CUSTOMER_APPROVAL") return "Use this when a draft is ready for customer approval. They remain at Content review until the placement is ready to begin.";
  if (to === "READY_FOR_HANDOFF") return "Use this after content is approved and ready for placement. This moves the customer to Preparing. For a partner placement, prepare its packet next.";
  if (to === "IN_FULFILLMENT") return "This moves the customer from Preparing to Publication in Progress. For a supplier packet, use it only after provider delivery is confirmed or staff records the actual manual send.";
  if (to === "PUBLICATION_PENDING") return "Use this when placement work is finished and the live page is ready to verify. The customer moves to Link verification.";
  if (to === "EVIDENCE_REVIEW") return "Use this when you are ready to check the publication details. The customer remains at Link verification until a verified live URL is recorded.";
  return "Choose this only when the previous verification needs another review.";
}

export function fulfillmentStateLabel(state: string): string {
  const labels: Record<string, string> = {
    CONFIRMED: "Order received",
    CONTENT_PREPARATION: "Reviewing content",
    AWAITING_CUSTOMER_APPROVAL: "Waiting for customer approval",
    READY_FOR_HANDOFF: "Ready to prepare placement",
    HANDOFF_PENDING: "Waiting for supplier delivery",
    IN_FULFILLMENT: "Placement work underway",
    PUBLICATION_PENDING: "Ready to verify the live page",
    EVIDENCE_REVIEW: "Checking publication evidence",
    ON_HOLD: "Paused for review",
    CANCELLATION_REQUESTED: "Cancellation request under review",
    CANCELED_REFUNDED: "Canceled and refunded",
    COMPLETED: "Complete",
  };
  return labels[state] ?? "Status unavailable";
}

export function minimumNextUpdateDate(now = new Date()): string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayAtValidationTime = new Date(today.getTime() + 12 * 60 * 60 * 1000);
  if (todayAtValidationTime.getTime() <= now.getTime()) today.setUTCDate(today.getUTCDate() + 1);
  return today.toISOString().slice(0, 10);
}

export function maximumNextUpdateDate(now = new Date()): string {
  const latest = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
  if (latest.getUTCHours() < 12) latest.setUTCDate(latest.getUTCDate() - 1);
  return latest.toISOString().slice(0, 10);
}

export function nextUpdateDateInputValue(current: Date | null, minimum: string, maximum: string): string {
  const currentValue = current?.toISOString().slice(0, 10);
  return currentValue && currentValue >= minimum && currentValue <= maximum ? currentValue : minimum;
}

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

export function customerStatusForFulfillmentTransition(
  milestone: keyof typeof milestones,
  state: string,
  currentCustomerStatus: string,
): string {
  if (state === "ON_HOLD") return currentCustomerStatus;
  return customerStatusForMilestone(milestone, state);
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
  READY_FOR_HANDOFF: [{ value: "IN_FULFILLMENT", label: "Start placement work" }, { value: "ON_HOLD", label: "Place on hold" }],
  HANDOFF_PENDING: [{ value: "IN_FULFILLMENT", label: "Start placement work" }, { value: "ON_HOLD", label: "Place on hold" }],
  IN_FULFILLMENT: [{ value: "PUBLICATION_PENDING", label: "Start link verification" }, { value: "ON_HOLD", label: "Place on hold" }],
  PUBLICATION_PENDING: [{ value: "EVIDENCE_REVIEW", label: "Review evidence" }, { value: "ON_HOLD", label: "Place on hold" }],
  EVIDENCE_REVIEW: [{ value: "PUBLICATION_PENDING", label: "Continue link verification" }, { value: "ON_HOLD", label: "Place on hold" }],
  ON_HOLD: [{ value: "CONFIRMED", label: "Resume order received" }, { value: "CONTENT_PREPARATION", label: "Resume content review" }, { value: "AWAITING_CUSTOMER_APPROVAL", label: "Resume customer approval" }, { value: "READY_FOR_HANDOFF", label: "Resume placement preparation" }, { value: "HANDOFF_PENDING", label: "Resume placement preparation" }, { value: "IN_FULFILLMENT", label: "Resume placement work" }, { value: "PUBLICATION_PENDING", label: "Resume link verification" }, { value: "EVIDENCE_REVIEW", label: "Resume evidence review" }],
};

export function fulfillmentTransitionChoices(state: string, stateBeforeHold: string | null, hasSupplier: boolean, writingApproved = true, supplierHandoffConfirmed = false) {
  return (transitions[state] ?? []).filter((choice) =>
    (state !== "ON_HOLD" || choice.value === stateBeforeHold)
    && (writingApproved || !["READY_FOR_HANDOFF", "HANDOFF_PENDING", "IN_FULFILLMENT"].includes(choice.value))
    && (choice.value !== "IN_FULFILLMENT" || !hasSupplier || state === "ON_HOLD" || (state === "HANDOFF_PENDING" && supplierHandoffConfirmed)));
}
