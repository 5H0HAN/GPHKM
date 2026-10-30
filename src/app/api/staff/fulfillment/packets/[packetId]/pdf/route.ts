import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { exportSupplierPacketPdf } from "@/server/fulfillment/packets";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ packetId: string }> }) {
  try {
    const { packetId } = await context.params;
    const result = await exportSupplierPacketPdf(await headers(), packetId);
    if (result.heldForReview || !result.bytes) return NextResponse.json({ error: "Packet exceeds the 5 MiB cap and is held for staff review." }, { status: 409, headers: { "Cache-Control": "no-store" } });
    return new Response(Uint8Array.from(result.bytes).buffer, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return NextResponse.json({ error: "Packet export is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
