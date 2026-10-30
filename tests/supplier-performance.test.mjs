import assert from "node:assert/strict";
import test from "node:test";
import { sortSupplierPerformance, summarizeSupplierPerformance } from "../src/modules/catalog/supplier-performance.ts";

test("supplier performance sort is allowlisted, stable, and keeps unknown measures last", () => {
  const summary = (supplierId, netSalesMinor, medianPublicationHours) => ({
    supplierId, paidPlacements: 1, completed: 1, rejected: 0, rejectedTracked: true,
    refunded: supplierId === "a" ? 1 : 0, canceled: supplierId === "b" ? 2 : 0,
    cancelledOrRefunded: 0, netSalesMinor,
    medianPublicationHours, onTimeRate: null, onTimeSampleSize: 0,
  });
  const rows = [
    { id: "b", name: "Beta", performance: summary("b", "9007199254741000", 10) },
    { id: "a", name: "Alpha", performance: summary("a", "9007199254740993", 5) },
    { id: "c", name: "Gamma", performance: summary("c", null, null) },
  ];
  assert.deepEqual(sortSupplierPerformance(rows, "netSalesMinor", "desc").map((row) => row.id), ["b", "a", "c"]);
  assert.deepEqual(sortSupplierPerformance(rows, "canceled", "desc").map((row) => row.id), ["b", "a", "c"]);
  assert.deepEqual(sortSupplierPerformance(rows, "refunded", "desc").map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual(sortSupplierPerformance(rows, "medianPublicationHours", "desc").map((row) => row.id), ["b", "a", "c"]);
  assert.deepEqual(sortSupplierPerformance(rows, "untrusted", "asc").map((row) => row.id), ["a", "b", "c"]);
  assert.deepEqual(rows.map((row) => row.id), ["b", "a", "c"]);
});

test("supplier metrics preserve refund totals and on-time sample boundaries", () => {
  const start = new Date("2026-10-01T00:00:00.000Z");
  const rows = [
    { supplierId: "s1", itemId: "i1", listingId: "l1", listingTitle: "A", createdAt: start, placementMinor: 5000n, writingMinor: 0n, refundMinor: 0n, state: "COMPLETED", writingSelected: false, snapshot: { turnaroundDays: 2 }, verifiedAt: new Date("2026-10-02T00:00:00.000Z") },
    { supplierId: "s1", itemId: "i2", listingId: "l2", listingTitle: "B", createdAt: start, placementMinor: 7000n, writingMinor: 1000n, refundMinor: 1000n, state: "CANCELED_REFUNDED", writingSelected: true, snapshot: { turnaroundDays: 2, writingTurnaroundDays: 1 }, verifiedAt: null },
    { supplierId: "s1", itemId: "i3", listingId: "l3", listingTitle: "C", createdAt: start, placementMinor: 3000n, writingMinor: 0n, refundMinor: 0n, state: "COMPLETED", writingSelected: false, snapshot: {}, verifiedAt: new Date("2026-10-05T00:00:00.000Z") },
    { supplierId: "s2", itemId: "i4", listingId: "l4", listingTitle: "D", createdAt: start, placementMinor: 900n, writingMinor: 0n, refundMinor: 0n, state: "REJECTED", writingSelected: false, snapshot: { turnaroundDays: 1 }, verifiedAt: null, supplierFailureRecorded: true },
  ];
  const result = summarizeSupplierPerformance("s1", rows);
  assert.equal(result.paidPlacements, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.rejected, 0);
  assert.equal(result.rejectedTracked, true);
  assert.equal(result.refunded, 1);
  assert.equal(result.canceled, 1);
  assert.equal(result.cancelledOrRefunded, 1);
  assert.equal(result.netSalesMinor, "15000");
  assert.equal(result.medianPublicationHours, 60);
  assert.equal(result.onTimeSampleSize, 1);
  assert.equal(result.onTimeRate, 1);
  assert.equal(summarizeSupplierPerformance("s2", rows).paidPlacements, 1);
  assert.equal(summarizeSupplierPerformance("s2", rows).rejected, 1);
  assert.equal(summarizeSupplierPerformance("s1", rows.map((item) => ({ ...item, refundMinor: null }))).netSalesMinor, null);
});

test("supplier refund reporting is a Super Admin-only item aggregate", async () => {
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(new URL("../src/db/migrations/0024_supplier_refund_reporting.sql", import.meta.url), "utf8");
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(migration, /gphkm_is_active_staff\(actor_id, 'SUPER_ADMIN'\)/);
  assert.match(migration, /l\.kind = 'ITEM_REFUND'/);
  assert.doesNotMatch(migration, /customer_email|customer_name|article_text|payment_payload/i);
});

test("replacement routes retain one sales attribution and exclude inherited timing samples", () => {
  const completed = {
    supplierId: "replacement", itemId: "i5", listingId: "l5", listingTitle: "E",
    createdAt: new Date("2026-10-01T00:00:00.000Z"), placementMinor: 5000n, writingMinor: 0n,
    refundMinor: 0n, state: "COMPLETED", writingSelected: false,
    snapshot: { turnaroundDays: 2 }, verifiedAt: new Date("2026-10-02T00:00:00.000Z"), timingEligible: false,
  };
  const report = summarizeSupplierPerformance("replacement", [completed]);
  assert.equal(report.paidPlacements, 1);
  assert.equal(report.completed, 1);
  assert.equal(report.netSalesMinor, "5000");
  assert.equal(report.medianPublicationHours, null);
  assert.equal(report.onTimeSampleSize, 0);
});

test("supplier export keys placement corrections by item, supplier, and component", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/server/catalog/supplier-report.ts", import.meta.url), "utf8");
  assert.match(source, /supplierOrderItemCostEvent\.supplierId, supplierOrderItemCostEvent\.component/);
  assert.match(source, /latestCostByKey\.get\(`\$\{row\.itemId\}:\$\{route\.id\}:PLACEMENT`\)/);
  assert.match(source, /placementCostBySupplier/);
  assert.match(source, /costStatus/);
  assert.match(source, /timingEligible: item\.supplierId === item\.originalSupplierId/);
});
