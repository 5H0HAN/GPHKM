import { downloadSupplierTransferEvidence } from "@/server/catalog/supplier-finance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ evidenceId: string }> }) {
  try {
    const { evidenceId } = await context.params;
    const result = await downloadSupplierTransferEvidence(request.headers, evidenceId);
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
