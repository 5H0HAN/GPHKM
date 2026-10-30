import { downloadStagedImportSource } from "@/server/catalog/imports";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    const origin = request.headers.get("origin");
    const staffOrigin = process.env.STAFF_APP_URL;
    if (origin && (!staffOrigin || new URL(origin).origin !== new URL(staffOrigin).origin)) {
      return new Response("Forbidden", { status: 403 });
    }
    const { batchId } = await context.params;
    const result = await downloadStagedImportSource(request.headers, batchId);
    const filename = result.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
    return new Response(Uint8Array.from(result.bytes).buffer, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response("Import source unavailable", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
}
