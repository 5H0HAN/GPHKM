import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { exportSupplierItemNotice } from "@/server/fulfillment/supplier-notices";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ noticeId: string }> }) {
  try {
    const { noticeId } = await context.params;
    const result = await exportSupplierItemNotice(await headers(), noticeId);
    return new Response(result.eml, { headers: { "Content-Type": "message/rfc822; charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"`, "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "Notice export is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
