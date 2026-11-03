import { createHash } from "node:crypto";
import type { OperationsWorkItem } from "@/modules/observability/operations-inbox";

export function operationsWorkItemVersion(item: Pick<OperationsWorkItem, "key" | "title" | "detail" | "action" | "href" | "updatedAt" | "dateLabel" | "revision">): string {
  const state = [item.key, item.title, item.detail, item.action, item.href, item.updatedAt, item.dateLabel ?? null, item.revision ?? null];
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
