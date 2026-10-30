import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { staffCatalogPagination } from "@/modules/catalog/pagination";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";

type GrossProfitRow = {
  order_item_id: string;
  purchase_at: Date;
  retail_minor: string;
  refunded_minor: string;
  known_direct_cost_minor: string;
  cost_status: "CONFIRMED" | "PROVISIONAL" | "UNKNOWN";
  gross_profit_minor: string | null;
  current_page: number;
  total_pages: number;
  total_count: number | string;
};

export async function getFinanceGrossProfitReport(headers: Headers, requestedPage: unknown = 1) {
  const actor = await requireStaffAccess(headers, "costs.read");
  const safePage = staffCatalogPagination(requestedPage, 5_000_000).page;
  const generatedAt = new Date();
  const windowStart = new Date(generatedAt.getTime() - 90 * 24 * 60 * 60 * 1000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const result = await tx.execute(sql`select * from public.gphkm_finance_gross_profit_report(${safePage})`);
    const rows = (result as unknown as { rows?: GrossProfitRow[] }).rows ?? [];
    const first = rows[0];
    const pagination = first ? {
      page: first.current_page,
      totalPages: first.total_pages,
      total: Number(first.total_count),
      pageSize: 50,
    } : { page: 1, totalPages: 1, total: 0, pageSize: 50 };
    await appendAuditEvent(tx, {
      actorUserId: actor.userId,
      action: "FINANCE_GROSS_PROFIT_REPORT_VIEWED",
      targetType: "finance_gross_profit_report",
      targetId: "trailing_90_days",
      metadata: { page: pagination.page, totalCount: pagination.total, itemCount: rows.length, result: "ALLOWED" },
    });
    return {
      generatedAt: generatedAt.toISOString(),
      windowStart: windowStart.toISOString(),
      pagination,
      items: rows.map((row) => ({
        orderItemId: row.order_item_id,
        purchasedAt: row.purchase_at,
        retailMinor: String(row.retail_minor),
        refundedMinor: String(row.refunded_minor),
        knownDirectCostMinor: String(row.known_direct_cost_minor),
        costStatus: row.cost_status,
        grossProfitMinor: row.gross_profit_minor === null ? null : String(row.gross_profit_minor),
      })),
    };
  });
}
