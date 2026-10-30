export type SupplierPerformanceItem = {
  supplierId: string;
  itemId: string;
  listingId: string;
  createdAt: Date;
  listingTitle: string;
  placementMinor: bigint;
  writingMinor: bigint;
  refundMinor: bigint | null;
  state: string | null;
  writingSelected: boolean;
  snapshot: Record<string, unknown>;
  verifiedAt: Date | null;
  supplierFailureRecorded?: boolean;
  timingEligible?: boolean;
};

export type SupplierPerformanceSummary = {
  supplierId: string;
  paidPlacements: number;
  completed: number;
  rejected: number;
  rejectedTracked: true;
  refunded: number;
  canceled: number;
  cancelledOrRefunded: number;
  netSalesMinor: string | null;
  medianPublicationHours: number | null;
  onTimeRate: number | null;
  onTimeSampleSize: number;
};

export const SUPPLIER_PERFORMANCE_SORTS = [
  "name", "paidPlacements", "completed", "rejected", "canceled", "refunded",
  "netSalesMinor", "medianPublicationHours", "onTimeRate",
] as const;

export type SupplierPerformanceSort = typeof SUPPLIER_PERFORMANCE_SORTS[number];
export type SupplierPerformanceDirection = "asc" | "desc";

export function sortSupplierPerformance<T extends { id: string; name: string; performance: SupplierPerformanceSummary }>(
  rows: readonly T[], sort: string | undefined, direction: string | undefined,
): T[] {
  const key: SupplierPerformanceSort = SUPPLIER_PERFORMANCE_SORTS.includes(sort as SupplierPerformanceSort)
    ? sort as SupplierPerformanceSort : "name";
  const order: SupplierPerformanceDirection = direction === "desc" ? "desc" : "asc";
  const compare = (left: T, right: T) => {
    let result: number;
    if (key === "name") result = left.name.localeCompare(right.name);
    else {
      const a = left.performance[key];
      const b = right.performance[key];
      if (a === null || b === null) return a === b ? left.name.localeCompare(right.name) || left.id.localeCompare(right.id) : a === null ? 1 : -1;
      result = key === "netSalesMinor"
        ? (BigInt(a as string) < BigInt(b as string) ? -1 : BigInt(a as string) > BigInt(b as string) ? 1 : 0)
        : Number(a) - Number(b);
    }
    if (result && order === "desc") result = -result;
    return result || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  };
  return [...rows].sort(compare);
}

export function summarizeSupplierPerformance(supplierId: string, items: readonly SupplierPerformanceItem[]): SupplierPerformanceSummary {
  const rows = items.filter((item) => item.supplierId === supplierId);
  let netSales = 0n;
  let netSalesKnown = true;
  const publicationHours: number[] = [];
  let onTimeSampleSize = 0;
  let onTimeCount = 0;
  for (const item of rows) {
    if (item.refundMinor === null) netSalesKnown = false;
    else netSales += item.placementMinor + item.writingMinor - item.refundMinor;
    if (item.timingEligible === false || item.state !== "COMPLETED" || !item.verifiedAt || item.verifiedAt < item.createdAt) continue;
    const elapsedHours = (item.verifiedAt.getTime() - item.createdAt.getTime()) / 3_600_000;
    publicationHours.push(elapsedHours);
    const placementDays = item.snapshot.turnaroundDays;
    const writingDays = item.writingSelected ? item.snapshot.writingTurnaroundDays : 0;
    if (typeof placementDays !== "number" || !Number.isInteger(placementDays) ||
        typeof writingDays !== "number" || !Number.isInteger(writingDays) ||
        placementDays < 1 || placementDays > 365 || writingDays < 0 || writingDays > 365) continue;
    onTimeSampleSize++;
    if (elapsedHours <= (Number(placementDays) + Number(writingDays)) * 24) onTimeCount++;
  }
  publicationHours.sort((a, b) => a - b);
  const middle = Math.floor(publicationHours.length / 2);
  const medianPublicationHours = publicationHours.length === 0 ? null : publicationHours.length % 2
    ? publicationHours[middle]!
    : (publicationHours[middle - 1]! + publicationHours[middle]!) / 2;
  return {
    supplierId,
    paidPlacements: rows.length,
    completed: rows.filter((item) => item.state === "COMPLETED").length,
    rejected: rows.filter((item) => item.supplierFailureRecorded).length,
    rejectedTracked: true,
    refunded: rows.filter((item) => item.refundMinor !== null && item.refundMinor > 0n).length,
    canceled: rows.filter((item) => item.state === "CANCELED_REFUNDED").length,
    cancelledOrRefunded: rows.filter((item) => item.state === "CANCELED_REFUNDED" || (item.refundMinor !== null && item.refundMinor > 0n)).length,
    netSalesMinor: netSalesKnown ? netSales.toString() : null,
    medianPublicationHours,
    onTimeRate: onTimeSampleSize ? onTimeCount / onTimeSampleSize : null,
    onTimeSampleSize,
  };
}
