import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { exportSupplierPacketEml } from "@/server/fulfillment/packets";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ packetId: string }> }) {
  try {
    const { packetId } = await context.params;
    const result = await exportSupplierPacketEml(await headers(), packetId, new URL(request.url).searchParams.get("pdf") === "1");
    if (result.heldForReview) return NextResponse.json({ error: "Packet exceeds the 5 MiB cap and is held for staff review." }, { status: 409, headers: { "Cache-Control": "no-store" } });
    return new Response(result.eml, { headers: { "Content-Type": "message/rfc822; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "Packet export is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
