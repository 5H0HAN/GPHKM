import "server-only";
import { sql } from "drizzle-orm";
import { staffTransaction } from "@/server/catalog/admin";
import { deletePrivateFile } from "@/server/storage/private-files";

type DiscardResult = {
  batchId: string;
  rowCount: number;
  costRowCount: number;
  applyEventCount: number;
  sourceObjectKey: string | null;
};

export async function discardStagedImportBatch(headers: Headers, batchId: string, reason: string) {
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(batchId) || cleanReason.length < 5 || cleanReason.length > 1_000) {
    throw new Error("Import discard details invalid");
  }

  const discarded = await staffTransaction(headers, "supplier.manage", async (tx, _userId, role) => {
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") throw new Error("Forbidden");
    const { rows } = await tx.execute(sql`
      select public.gphkm_discard_catalog_import_batch(${batchId}, ${cleanReason}) as result
    `);
    const result = rows[0]?.result as DiscardResult | undefined;
    if (!result || result.batchId !== batchId || typeof result.sourceObjectKey !== "string" && result.sourceObjectKey !== null) {
      throw new Error("Import discard failed");
    }
    return result;
  });

  let sourceFileDeleted = discarded.sourceObjectKey === null;
  if (discarded.sourceObjectKey !== null) {
    try {
      await deletePrivateFile(discarded.sourceObjectKey);
      sourceFileDeleted = true;
    } catch {
      // The DB record is already gone. Log the failed cleanup without exposing
      // the storage key or source contents; the retained object is unreachable
      // through application routes and needs operational cleanup.
      console.error(JSON.stringify({
        level: "error",
        event: "catalog_import_source_cleanup_failed",
        batchId: discarded.batchId,
      }));
    }
  }

  return {
    batchId: discarded.batchId,
    rowCount: Number(discarded.rowCount),
    costRowCount: Number(discarded.costRowCount),
    applyEventCount: Number(discarded.applyEventCount),
    sourceFileDeleted,
  };
}
