import { recordManualSupplierHandoff } from "@/server/fulfillment/packets";
import { requireStaffAccess } from "@/server/auth/staff";

export const dynamic = "force-dynamic";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;

type ManualResult = "manual" | "manual-time" | "manual-recipient" | "manual-reference" | "manual-evidence" | "manual-size" | "manual-confirm" | "manual-state";

function redirectToPacket(packetId: string, result: ManualResult) {
  const staffUrl = process.env.STAFF_APP_URL;
  if (!staffUrl) return new Response("Staff origin is not configured", { status: 500 });
  const query = result === "manual" ? "manual=1#supplier-acknowledgement" : `error=${result}`;
  const target = new URL(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?${query}`, staffUrl);
  return Response.redirect(target, 303);
}

function manualFailureResult(error: unknown): ManualResult {
  if (!(error instanceof Error)) return "manual";
  switch (error.message) {
    case "Enter the actual sent time with its timezone after beginning the handoff": return "manual-time";
    case "Actual recipient is invalid":
    case "Recipient differs from the consent-bound packet; create a new version with fresh consent": return "manual-recipient";
    case "Manual handoff evidence is invalid": return "manual-reference";
    case "Evidence must be a PDF or EML up to 5 MiB": return "manual-evidence";
    case "Packet is no longer eligible for handoff":
    case "Packet items are no longer eligible for handoff":
    case "Pending manual handoff reservation unavailable":
    case "Content-sharing consent does not match supplier and recipient":
    case "Content changed after consent; obtain fresh consent": return "manual-state";
    default: return "manual";
  }
}

export async function POST(request: Request, context: { params: Promise<{ packetId: string }> }) {
  const { packetId } = await context.params;
  try {
    await requireStaffAccess(request.headers, "fulfillment.manage");
    const origin = request.headers.get("origin");
    const staffOrigin = process.env.STAFF_APP_URL;
    if (!origin || !staffOrigin || new URL(origin).origin !== new URL(staffOrigin).origin) return new Response("Forbidden", { status: 403 });
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1) return redirectToPacket(packetId, "manual");
    if (length > MAX_REQUEST_BYTES) return redirectToPacket(packetId, "manual-size");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) return new Response("Unsupported media type", { status: 415 });
    const form = await request.formData();
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const file = form.get("evidence");
    let evidence: { kind: "EML" | "PDF"; bytes: Buffer } | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return redirectToPacket(packetId, "manual-evidence");
      const extension = file.name.toLowerCase().split(".").at(-1);
      if (extension !== "eml" && extension !== "pdf") return redirectToPacket(packetId, "manual-evidence");
      evidence = { kind: extension === "eml" ? "EML" : "PDF", bytes: Buffer.from(await file.arrayBuffer()) };
    }
    if (field("confirmAllItems") !== "on") return redirectToPacket(packetId, "manual-confirm");
    await recordManualSupplierHandoff(request.headers, {
      packetId, attemptId: field("attemptId"), recipient: field("recipient"), sentAt: field("sentAt"),
      messageReference: field("messageReference"), evidence,
    });
    return redirectToPacket(packetId, "manual");
  } catch (error) {
    return redirectToPacket(packetId, manualFailureResult(error));
  }
}
