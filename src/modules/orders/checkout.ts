export const MAX_ORDER_ITEMS = 25;
export const CONTENT_SHARING_NOTICE_VERSION = "gphkm-content-sharing-v1";
// Bump these when the corresponding checkout disclosures change.
export const PLACEMENT_DISCLOSURE_VERSION = "gphkm-placement-disclosure-v1";
export const WRITING_REFUND_DISCLOSURE_VERSION = "gphkm-writing-stages-v1";
export { CUSTOMER_CONTENT_POLICY_VERSION } from "./content-policy.ts";

export function customerOrderPagination(requestedPage: unknown, totalOrders: number, pageSize = 50) {
  const limit = Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), 100) : 50;
  const parsed = typeof requestedPage === "string" && /^[1-9][0-9]*$/.test(requestedPage)
    ? Number(requestedPage) : requestedPage;
  const totalPages = Math.max(1, Math.ceil(totalOrders / limit));
  const page = typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, totalPages) : 1;
  return { page, totalPages, totalOrders, limit, offset: (page - 1) * limit };
}

export type CheckoutItemInput = {
  listingId: string;
  /** Listing revision displayed to the customer; checkout rejects stale carts. */
  expectedRevision: number;
  targetUrl: string;
  anchorText: string;
  instructions?: string;
  articleText?: string;
  writingBrief?: string;
  useWriting?: boolean;
  shareWithPublicationPartner: boolean;
};

export type CheckoutInput = { items: CheckoutItemInput[]; idempotencyKey: string; acceptContentPolicy: boolean };
export type CheckoutValidationError = { field: string; code: string };

function safeText(value: unknown, max: number, allowNewlines: boolean): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    (allowNewlines || !/[\r\n\t]/.test(value));
}

function validDestinationUrl(value: unknown): value is string {
  if (!safeText(value, 2048, false)) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username && !parsed.password && parsed.hostname.length <= 253 &&
      !/[\u0000-\u0020]/.test(value);
  } catch { return false; }
}

export function validateCheckoutInput(input: unknown): CheckoutValidationError[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ field: "", code: "OBJECT_REQUIRED" }];
  const value = input as Record<string, unknown>;
  const errors: CheckoutValidationError[] = [];
  if (value.acceptContentPolicy !== true) errors.push({ field: "acceptContentPolicy", code: "CONTENT_POLICY_ACCEPTANCE_REQUIRED" });
  if (typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(value.idempotencyKey)) {
    errors.push({ field: "idempotencyKey", code: "INVALID_IDEMPOTENCY_KEY" });
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_ORDER_ITEMS) {
    errors.push({ field: "items", code: "INVALID_ITEM_COUNT" });
    return errors;
  }
  const ids = new Set<string>();
  value.items.forEach((raw, index) => {
    const field = `items.${index}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push({ field, code: "OBJECT_REQUIRED" }); return; }
    const item = raw as Record<string, unknown>;
    if (typeof item.listingId !== "string" || item.listingId.length < 1 || item.listingId.length > 128) {
      errors.push({ field: `${field}.listingId`, code: "INVALID_LISTING_ID" });
    } else if (ids.has(item.listingId)) errors.push({ field: `${field}.listingId`, code: "DUPLICATE_LISTING" });
    else ids.add(item.listingId);
    if (!Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 1) {
      errors.push({ field: `${field}.expectedRevision`, code: "INVALID_LISTING_REVISION" });
    }
    if (!validDestinationUrl(item.targetUrl)) errors.push({ field: `${field}.targetUrl`, code: "INVALID_TARGET_URL" });
    if (!safeText(item.anchorText, 200, false)) errors.push({ field: `${field}.anchorText`, code: "INVALID_ANCHOR_TEXT" });
    if (item.instructions !== undefined && (typeof item.instructions !== "string" || item.instructions.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.instructions))) errors.push({ field: `${field}.instructions`, code: "INVALID_INSTRUCTIONS" });
    if (item.shareWithPublicationPartner !== true) errors.push({ field: `${field}.shareWithPublicationPartner`, code: "CONSENT_REQUIRED" });
    const writing = item.useWriting === true;
    if (writing) {
      if (!safeText(item.writingBrief, 4000, true)) errors.push({ field: `${field}.writingBrief`, code: "INVALID_WRITING_BRIEF" });
      if (item.articleText !== undefined) errors.push({ field: `${field}.articleText`, code: "ARTICLE_AND_WRITING_BRIEF_EXCLUSIVE" });
    } else if (!safeText(item.articleText, 20000, true)) {
      errors.push({ field: `${field}.articleText`, code: "INVALID_ARTICLE" });
    } else if (item.writingBrief !== undefined) errors.push({ field: `${field}.writingBrief`, code: "WRITING_REQUIRES_ADDON" });
    if (item.useWriting !== undefined && typeof item.useWriting !== "boolean") errors.push({ field: `${field}.useWriting`, code: "BOOLEAN_REQUIRED" });
    const unknownKeys = Object.keys(item).filter((key) => !["listingId", "expectedRevision", "targetUrl", "anchorText", "instructions", "articleText", "writingBrief", "useWriting", "shareWithPublicationPartner"].includes(key));
    if (unknownKeys.length) errors.push({ field, code: "UNKNOWN_FIELDS" });
  });
  const unknownKeys = Object.keys(value).filter((key) => !["items", "idempotencyKey", "acceptContentPolicy"].includes(key));
  if (unknownKeys.length) errors.push({ field: "", code: "UNKNOWN_FIELDS" });
  return errors;
}

export function customerOrderProjection(order: {
  actorUserId?: string;
  id: string; customerStatus: string; currency: string; placementTotalMinor: string; writingTotalMinor: string;
  totalMinor: string; createdAt: Date; items: Array<{
    id: string; listingId: string; customerListingSnapshot: Record<string, unknown>; placementPriceMinor: string;
    writingSelected: boolean; writingPriceMinor: string; targetUrl: string; anchorText: string;
    articleText: string | null; writingBrief: string | null; customerStatus: string;
    instructions?: string;
    lastUpdatedAt?: string | null; nextUpdateAt?: string | null; publicationUrls?: string[];
    milestoneHistory?: Array<{ status: string; nextUpdateAt: string | null; occurredAt: string }>;
    writingWorkflow?: null | {
      state: string; firstDraftText: string | null; revisionRequestText: string | null;
      finalDraftText: string | null; approvedArticleText: string | null; writingRefundMinor: string;
    };
  }>;
}, viewerUserId?: string) {
  const listingFields = [
    "listingId", "revision", "title", "description", "countryCode", "primaryLanguage", "categories",
    "retailPriceCents", "linkType", "linkValidity", "turnaroundDays", "allowsSportsAndGaming",
    "allowsPharmacy", "allowsCrypto", "allowsForeignLanguage", "sponsoredContentMarking", "writingEnabled",
    "writingPriceCents", "writingTurnaroundDays", "writingFirstDraftCents", "writingFinalDraftCents", "buyerRequirements",
    "placementDisclosureVersion", "writingRefundDisclosureVersion",
  ];
  const progress = ["ORDER_RECEIVED", "CONTENT_REVIEW", "PREPARING", "IN_PROGRESS", "LINK_VERIFICATION", "COMPLETE", "RESOLVED"];
  const allTerminal = order.items.length > 0 && order.items.every((item) => item.customerStatus === "COMPLETE" || item.customerStatus === "RESOLVED");
  const status = allTerminal
    ? order.items.some((item) => item.customerStatus === "RESOLVED") ? "RESOLVED" : "COMPLETE"
    : order.items.filter((item) => item.customerStatus !== "COMPLETE" && item.customerStatus !== "RESOLVED")
      .map((item) => item.customerStatus).sort((a, b) => progress.indexOf(b) - progress.indexOf(a))[0] ?? order.customerStatus;
  return {
    id: order.id,
    status,
    currency: order.currency,
    placementTotalMinor: order.placementTotalMinor,
    writingTotalMinor: order.writingTotalMinor,
    totalMinor: order.totalMinor,
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      listingId: item.listingId,
      listing: Object.fromEntries(listingFields.filter((key) => key in item.customerListingSnapshot)
        .map((key) => [key, item.customerListingSnapshot[key]])),
      placementPriceMinor: item.placementPriceMinor,
      writingSelected: item.writingSelected,
      writingPriceMinor: item.writingPriceMinor,
      targetUrl: item.targetUrl,
      anchorText: item.anchorText,
      instructions: item.instructions ?? "",
      articleText: item.articleText,
      writingBrief: item.writingBrief,
      ...(viewerUserId && order.actorUserId === viewerUserId && item.writingSelected && item.writingWorkflow ? { writingWorkflow: item.writingWorkflow } : {}),
      status: item.customerStatus,
      lastUpdatedAt: item.lastUpdatedAt ?? null,
      nextUpdateAt: item.nextUpdateAt ?? null,
      publicationUrls: item.publicationUrls ?? [],
      googleIndexingStatus: (item.publicationUrls?.length ?? 0) > 0 ? "UNKNOWN" as const : null,
      milestoneHistory: (item.milestoneHistory ?? []).map((milestone) => ({
        status: milestone.status,
        nextUpdateAt: milestone.nextUpdateAt,
        occurredAt: milestone.occurredAt,
      })),
    })),
  };
}
