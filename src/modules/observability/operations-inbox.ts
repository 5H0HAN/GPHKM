export type StaffRole = "ADMIN" | "FINANCE" | "SUPER_ADMIN";

export type OperationsWorkItem = {
  key: string;
  title: string;
  detail: string;
  action: string;
  href: string;
  updatedAt: string | null;
  dateLabel?: string;
  version?: string;
  done?: boolean;
  revision?: string;
};

export type OperationsAlert = {
  key: string;
  title: string;
  description: string;
  noun: string;
  count: number;
  saturated: boolean;
  href: string;
  action: string;
  items: OperationsWorkItem[];
};

export const OPERATIONS_INBOX_REFRESH_MS = 60_000;
export const OPERATIONS_INBOX_PREVIEW_LIMIT = 4;

export function normalizeOperationTimestamp(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid database timestamp");
  return date;
}

export function staffSupportAttentionStates(role: StaffRole): string[] {
  if (role === "FINANCE") return ["FINANCE_REVIEW"];
  if (role === "SUPER_ADMIN") return ["OPEN", "INVESTIGATING", "WAITING_ON_SUPPLIER", "FINANCE_REVIEW"];
  return ["OPEN", "INVESTIGATING", "WAITING_ON_SUPPLIER"];
}

export function supportNextAction(state: string): string {
  if (state === "OPEN") return "Review new case";
  if (state === "WAITING_ON_SUPPLIER") return "Check supplier response";
  if (state === "FINANCE_REVIEW") return "Review financial decision";
  return "Continue case review";
}

export function operationsCountLabel(count: number, noun: string, saturated = false): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const countText = saturated ? `${safeCount}+` : String(safeCount);
  return `${countText} ${noun}${safeCount === 1 && !saturated ? "" : "s"}`;
}

export function hasActionableOperations(alerts: readonly OperationsAlert[]): boolean {
  return alerts.some((alert) => Number.isFinite(alert.count) && alert.count > 0);
}

export function boundedQueueCount(count: number, limit: number): { count: number; saturated: boolean } {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return { count: safeCount, saturated: safeCount >= limit };
}

export function shouldRefreshOperationsInbox(
  visible: boolean,
  requestInFlight: boolean,
  now = Date.now(),
  lastRequestAt = Number.NEGATIVE_INFINITY,
  force = false,
): boolean {
  return visible && !requestInFlight && (force || now - lastRequestAt >= OPERATIONS_INBOX_REFRESH_MS);
}

export function canApplyOperationsRefresh(startedRevision: number, currentRevision: number): boolean {
  return startedRevision === currentRevision;
}
