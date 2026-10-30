import { headers } from "next/headers";
import { getSupplierPerformanceReport } from "@/server/catalog/supplier-report";

export async function GET() {
  const report = await getSupplierPerformanceReport(await headers(), true);
  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gphkm-supplier-performance.json"',
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
