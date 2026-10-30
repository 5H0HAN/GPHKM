import { recordManualSupplierHandoff } from "@/server/fulfillment/packets";
import { requireStaffAccess } from "@/server/auth/staff";

export const dynamic = "force-dynamic";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;

function redirectToPacket(packetId: string, result: "manual" | "error") {
  const staffUrl = process.env.STAFF_APP_URL;
  if (!staffUrl) return new Response("Staff origin is not configured", { status: 500 });
  const target = new URL(`/staff/fulfillment/packets/${encodeURIComponent(packetId)}?${result === "manual" ? "manual=1" : "error=manual"}`, staffUrl);
  return Response.redirect(target, 303);
}

export async function POST(request: Request, context: { params: Promise<{ packetId: string }> }) {
  const { packetId } = await context.params;
  try {
    await requireStaffAccess(request.headers, "fulfillment.manage");
    const origin = request.headers.get("origin");
    const staffOrigin = process.env.STAFF_APP_URL;
    if (!origin || !staffOrigin || new URL(origin).origin !== new URL(staffOrigin).origin) return new Response("Forbidden", { status: 403 });
    const length = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_REQUEST_BYTES) return redirectToPacket(packetId, "error");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) return new Response("Unsupported media type", { status: 415 });
    const form = await request.formData();
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const file = form.get("evidence");
    let evidence: { kind: "EML" | "PDF"; bytes: Buffer } | undefined;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return redirectToPacket(packetId, "error");
      const extension = file.name.toLowerCase().split(".").at(-1);
      if (extension !== "eml" && extension !== "pdf") return redirectToPacket(packetId, "error");
      evidence = { kind: extension === "eml" ? "EML" : "PDF", bytes: Buffer.from(await file.arrayBuffer()) };
    }
    if (field("confirmAllItems") !== "on") return redirectToPacket(packetId, "error");
    await recordManualSupplierHandoff(request.headers, {
      packetId, attemptId: field("attemptId"), recipient: field("recipient"), sentAt: field("sentAt"),
      messageReference: field("messageReference"), evidence,
    });
    return redirectToPacket(packetId, "manual");
  } catch {
    return redirectToPacket(packetId, "error");
  }
}
