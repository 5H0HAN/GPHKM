import { createHash } from "node:crypto";

export type OrderContent = Readonly<{
  targetUrl: string;
  anchorText: string;
  articleText: string | null;
  instructions: string;
}>;

export type ContentChangePatch = Partial<OrderContent>;
export type ContentChangeStatus = "REQUESTED" | "APPROVED_AWAITING_CONSENT" | "CONSENTED" | "REJECTED";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateContentChangePatch(input: Record<string, unknown>, writingSelected: boolean, writingStopped = false): ContentChangePatch {
  const allowed = new Set(["targetUrl", "anchorText", "articleText", "instructions"]);
  if (writingSelected && !writingStopped && Object.hasOwn(input, "articleText")) throw new Error("Use the writing review to request article edits");
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Only text fields for this placement may be changed");
  const patch: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw !== "string") throw new Error("Content changes must be text");
    const value = raw.trim();
    const max = key === "targetUrl" ? 2048 : key === "anchorText" ? 200 : key === "articleText" ? 20000 : 4000;
    if (!value || value.length > max || CONTROL.test(value)) throw new Error(`${key} is invalid`);
    if (key === "targetUrl") {
      let url: URL;
      try { url = new URL(value); } catch { throw new Error("Target URL must be a valid HTTP or HTTPS URL"); }
      if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Target URL must be a public HTTP or HTTPS URL");
    }
    patch[key] = value;
  }
  if (!Object.keys(patch).length) throw new Error("Enter at least one change");
  return Object.freeze(patch) as ContentChangePatch;
}

export function mergeContentChange(base: OrderContent, patch: ContentChangePatch): OrderContent {
  const merged = { ...base, ...patch };
  return Object.freeze(merged);
}

export function hashOrderContent(content: OrderContent, binding?: { supplierId: string | null; recipientEmail: string }): string {
  const canonical = JSON.stringify({
    targetUrl: content.targetUrl,
    anchorText: content.anchorText,
    articleText: content.articleText,
    instructions: content.instructions,
    supplierId: binding?.supplierId ?? null,
    recipientEmail: binding?.recipientEmail ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function contentChangeStatus(events: readonly { eventType: string }[]): ContentChangeStatus | null {
  const last = events[0]?.eventType;
  if (last === "REQUESTED") return "REQUESTED";
  if (last === "APPROVED") return "APPROVED_AWAITING_CONSENT";
  if (last === "CONSENTED") return "CONSENTED";
  if (last === "REJECTED") return "REJECTED";
  return null;
}

export function mayRequestContentChange(input: { requesterId: string; ordererId: string; handedOffAt: Date | null; state: string }): boolean {
  return input.requesterId === input.ordererId && input.handedOffAt === null && !["IN_FULFILLMENT", "PUBLICATION_PENDING", "EVIDENCE_REVIEW", "COMPLETED", "CANCELED_REFUNDED", "CANCELLATION_REQUESTED"].includes(input.state);
}
