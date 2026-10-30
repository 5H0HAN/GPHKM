import { downloadSupplierPacketEvidence } from "@/server/fulfillment/packets";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ packetId: string; evidenceId: string }> }) {
  try {
    const { packetId, evidenceId } = await context.params;
    const result = await downloadSupplierPacketEvidence(request.headers, packetId, evidenceId);
    return new Response(Uint8Array.from(result.bytes).buffer, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Evidence unavailable", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
}
