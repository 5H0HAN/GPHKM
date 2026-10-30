import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { listing, listingCost, listingMetricObservation, listingSourcing, listingUrl, supplier, supplierContact } from "@/db/catalog-schema";
import { customerOrder, customerOrderItem, orderItemFinancial, orderItemFulfillment, orderItemFulfillmentSupplier, publicationEvidence } from "@/db/order-schema";
import { supplierOrderItemCostEvent } from "@/db/supplier-finance-schema";
import { supplierFulfillmentOutcome } from "@/db/supplier-outcome-schema";
import { summarizeSupplierPerformance, type SupplierPerformanceItem } from "@/modules/catalog/supplier-performance";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { hasStaffPermission } from "@/server/identity/policy";

const REPORT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export async function getSupplierPerformanceReport(headers: Headers, exportRequested = false) {
  const actor = await requireStaffAccess(headers, "supplier-report.export");
  const canReadCosts = hasStaffPermission(actor.role, "costs.read");
  const now = new Date();
  const since = new Date(now.getTime() - REPORT_WINDOW_MS);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    const suppliers = await tx.select({
      id: supplier.id, name: supplier.name, status: supplier.status,
    }).from(supplier).orderBy(supplier.name);
    const contacts = exportRequested ? await tx.select({
      supplierId: supplierContact.supplierId, name: supplierContact.name, email: supplierContact.email,
      roleLabel: supplierContact.roleLabel, isPrimary: supplierContact.isPrimary,
    }).from(supplierContact).orderBy(supplierContact.supplierId) : [];
    const latestEvidence = tx.select({
      orderItemId: publicationEvidence.orderItemId,
      verifiedAt: sql<Date>`max(${publicationEvidence.verifiedAt})`.as("verified_at"),
    }).from(publicationEvidence).groupBy(publicationEvidence.orderItemId).as("latest_evidence");
    const itemRows = await tx.select({
      supplierId: orderItemFulfillmentSupplier.supplierId,
      itemId: customerOrderItem.id,
      listingId: customerOrderItem.listingId,
      listingTitle: orderItemFulfillment.listingTitle,
      createdAt: customerOrder.createdAt,
      placementMinor: customerOrderItem.placementPriceMinor,
      writingMinor: customerOrderItem.writingPriceMinor,
      writingSelected: customerOrderItem.writingSelected,
      snapshot: customerOrderItem.customerListingSnapshot,
      state: orderItemFulfillment.state,
      verifiedAt: latestEvidence.verifiedAt,
      originalSupplierId: sql<string | null>`coalesce(${orderItemFinancial.supplierId}, ${orderItemFinancial.fulfillmentSupplierId})`,
    }).from(orderItemFulfillmentSupplier)
      .innerJoin(customerOrderItem, eq(customerOrderItem.id, orderItemFulfillmentSupplier.orderItemId))
      .innerJoin(orderItemFinancial, eq(orderItemFinancial.orderItemId, customerOrderItem.id))
      .innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .innerJoin(supplier, eq(supplier.id, orderItemFulfillmentSupplier.supplierId))
      .innerJoin(orderItemFulfillment, eq(orderItemFulfillment.orderItemId, customerOrderItem.id))
      .leftJoin(latestEvidence, eq(latestEvidence.orderItemId, customerOrderItem.id))
      .where(and(eq(customerOrder.checkoutState, "PAID"), gte(customerOrder.createdAt, since)))
      .orderBy(customerOrder.createdAt);
    const outcomes = await tx.select({ supplierId: supplierFulfillmentOutcome.supplierId,
      itemId: supplierFulfillmentOutcome.orderItemId })
      .from(supplierFulfillmentOutcome).where(gte(supplierFulfillmentOutcome.createdAt, since));
    const rejectedItems = new Set(outcomes.map((row) => `${row.supplierId}:${row.itemId}`));
    const rejectedCounts = new Map<string, Set<string>>();
    for (const row of outcomes) rejectedCounts.set(row.supplierId, (rejectedCounts.get(row.supplierId) ?? new Set()).add(row.itemId));
    const normalizedItems: SupplierPerformanceItem[] = itemRows.flatMap((item) => item.supplierId ? [{
      supplierId: item.supplierId, itemId: item.itemId, listingId: item.listingId,
      listingTitle: item.listingTitle, createdAt: item.createdAt,
      placementMinor: BigInt(item.placementMinor), writingMinor: BigInt(item.writingMinor), refundMinor: 0n,
      state: item.state, writingSelected: item.writingSelected,
      snapshot: item.snapshot, verifiedAt: item.verifiedAt,
      supplierFailureRecorded: rejectedItems.has(`${item.supplierId}:${item.itemId}`),
      timingEligible: item.supplierId === item.originalSupplierId,
    }] : []);
    const refundResult = await tx.execute(sql`select order_item_id, refunded_minor::text from public.gphkm_supplier_item_refund_totals()`);
    const refundRows = (refundResult as unknown as { rows?: Array<{ order_item_id: string; refunded_minor: string }> }).rows ?? [];
    const refundByItem = new Map(refundRows.map((row) => [row.order_item_id, BigInt(row.refunded_minor)]));
    for (const item of normalizedItems) item.refundMinor = refundByItem.get(item.itemId) ?? 0n;
    const performance = suppliers.map((row) => ({
      ...summarizeSupplierPerformance(row.id, normalizedItems),
      rejected: rejectedCounts.get(row.id)?.size ?? 0,
    }));
    if (!exportRequested) return { generatedAt: now.toISOString(), windowStart: since.toISOString(), suppliers: suppliers.map((row) => ({
      ...row, performance: performance.find((item) => item.supplierId === row.id)!,
    })) };

    const inventoryFields = {
      listingId: listing.id, title: listing.title, status: listing.status, categories: listing.categories,
      countryCode: listing.countryCode, primaryLanguage: listing.primaryLanguage, linkType: listing.linkType,
      linkValidity: listing.linkValidity, turnaroundDays: listing.turnaroundDays, retailPriceCents: listing.retailPriceCents,
      websiteUrl: listingUrl.websiteUrl, supplierId: listingSourcing.supplierId,
      fulfillmentSupplierId: listingSourcing.fulfillmentSupplierId, commercialSource: listingSourcing.commercialSource,
    };
    const inventory = canReadCosts
      ? await tx.select({ ...inventoryFields, sourceCostCents: listingCost.sourceCostCents })
        .from(listingSourcing).innerJoin(listing, eq(listing.id, listingSourcing.listingId))
        .leftJoin(listingUrl, eq(listingUrl.listingId, listing.id)).leftJoin(listingCost, eq(listingCost.listingId, listing.id))
        .where(sql`${listingSourcing.supplierId} is not null or ${listingSourcing.fulfillmentSupplierId} is not null`)
        .orderBy(listing.title)
      : await tx.select(inventoryFields).from(listingSourcing).innerJoin(listing, eq(listing.id, listingSourcing.listingId))
        .leftJoin(listingUrl, eq(listingUrl.listingId, listing.id))
        .where(sql`${listingSourcing.supplierId} is not null or ${listingSourcing.fulfillmentSupplierId} is not null`)
        .orderBy(listing.title);
    const observations = await tx.select({
      listingId: listingMetricObservation.listingId, provider: listingMetricObservation.provider,
      metricScope: listingMetricObservation.metricScope, value: listingMetricObservation.value,
      status: listingMetricObservation.status, observedOn: listingMetricObservation.observedOn,
      refreshedAt: listingMetricObservation.refreshedAt, source: listingMetricObservation.source,
      redistributionApproved: listingMetricObservation.redistributionApproved,
      attributionText: listingMetricObservation.attributionText,
    }).from(listingMetricObservation).orderBy(listingMetricObservation.listingId, listingMetricObservation.refreshedAt);
    const financials = canReadCosts ? await tx.select({
      itemId: orderItemFinancial.orderItemId, supplierId: orderItemFinancial.supplierId,
      fulfillmentSupplierId: orderItemFinancial.fulfillmentSupplierId, sourceCostMinor: orderItemFinancial.sourceCostMinor,
      writingDirectCostMinor: orderItemFinancial.writingDirectCostMinor,
    }).from(orderItemFinancial) : [];
    const latestCostEvents = canReadCosts ? await tx.selectDistinctOn([
      supplierOrderItemCostEvent.orderItemId, supplierOrderItemCostEvent.supplierId, supplierOrderItemCostEvent.component,
    ], {
      itemId: supplierOrderItemCostEvent.orderItemId, supplierId: supplierOrderItemCostEvent.supplierId,
      component: supplierOrderItemCostEvent.component, amountMinor: supplierOrderItemCostEvent.newCostMinor,
      createdAt: supplierOrderItemCostEvent.createdAt, id: supplierOrderItemCostEvent.id,
    }).from(supplierOrderItemCostEvent).orderBy(
      supplierOrderItemCostEvent.orderItemId, supplierOrderItemCostEvent.supplierId,
      supplierOrderItemCostEvent.component, desc(supplierOrderItemCostEvent.createdAt), desc(supplierOrderItemCostEvent.id),
    ) : [];
    const latestCostByKey = new Map(latestCostEvents.map((row) => [`${row.itemId}:${row.supplierId ?? "internal"}:${row.component}`, row.amountMinor]));
    const writingRequiredByItem = new Map(normalizedItems.map((item) => [item.itemId, item.writingSelected]));
    const suppliersByItem = new Map<string, Array<{ id: string; name: string | null }>>();
    if (canReadCosts && financials.length) {
      const itemIds = sql.join(financials.map((row) => sql`${row.itemId}`), sql`, `);
      const routeResult = await tx.execute(sql`
        SELECT requested.order_item_id AS "orderItemId", eligible.supplier_id AS "supplierId",
               public.gphkm_finance_supplier_name(eligible.supplier_id) AS "supplierName"
          FROM unnest(ARRAY[${itemIds}]::text[]) AS requested(order_item_id)
          CROSS JOIN LATERAL public.gphkm_finance_item_suppliers(requested.order_item_id) eligible
         ORDER BY requested.order_item_id, eligible.supplier_id
      `);
      const routes = (routeResult as unknown as { rows?: Array<{ orderItemId: string; supplierId: string; supplierName: string | null }> }).rows ?? [];
      for (const route of routes) suppliersByItem.set(route.orderItemId, [...(suppliersByItem.get(route.orderItemId) ?? []), { id: route.supplierId, name: route.supplierName }]);
    }
    const financialByItem = new Map(financials.map((row) => {
      const originalSupplierId = row.supplierId ?? row.fulfillmentSupplierId;
      const routeSuppliers = suppliersByItem.get(row.itemId) ?? (originalSupplierId ? [{ id: originalSupplierId, name: null }] : []);
      const placementCosts = routeSuppliers.length ? routeSuppliers.map((route) => {
        const eventAmount = latestCostByKey.get(`${row.itemId}:${route.id}:PLACEMENT`);
        const isOriginal = route.id === originalSupplierId;
        return {
          supplierId: route.id, supplierName: route.name,
          amountMinor: eventAmount ?? (isOriginal ? row.sourceCostMinor : null),
          status: eventAmount !== undefined ? "CONFIRMED" : isOriginal && row.sourceCostMinor !== null ? "PROVISIONAL" : "UNKNOWN",
        };
      }) : [{
        supplierId: null, supplierName: "GPHKM internal",
        amountMinor: latestCostByKey.get(`${row.itemId}:internal:PLACEMENT`) ?? row.sourceCostMinor,
        status: latestCostByKey.has(`${row.itemId}:internal:PLACEMENT`) ? "CONFIRMED" : row.sourceCostMinor !== null ? "PROVISIONAL" : "UNKNOWN",
      }];
      const writingEvent = latestCostByKey.get(`${row.itemId}:internal:WRITING`);
      const writingDirectCostMinor = writingEvent ?? row.writingDirectCostMinor;
      const writingCostStatus = writingEvent !== undefined ? "CONFIRMED" : writingDirectCostMinor !== null ? "PROVISIONAL" : "UNKNOWN";
      const placementCostKnownMinor = placementCosts.reduce((sum, cost) => sum + (cost.amountMinor === null ? 0n : BigInt(cost.amountMinor)), 0n);
      const placementComplete = placementCosts.every((cost) => cost.status === "CONFIRMED");
      const writingRequired = writingRequiredByItem.get(row.itemId) ?? false;
      const costStatus = !placementComplete || (writingRequired && writingCostStatus !== "CONFIRMED")
        ? placementCosts.some((cost) => cost.amountMinor !== null) || writingDirectCostMinor !== null ? "PROVISIONAL" : "UNKNOWN"
        : "CONFIRMED";
      return [row.itemId, {
        placementCosts, placementCostKnownMinor: placementCostKnownMinor.toString(),
        writingDirectCostMinor: writingDirectCostMinor === null ? null : String(writingDirectCostMinor),
        writingCostStatus, costStatus,
      }] as const;
    }));
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "SUPPLIER_PERFORMANCE_EXPORTED", targetType: "supplier_performance_export",
      targetId: randomUUID(), metadata: { itemCount: normalizedItems.length, result: "JSON" },
    });
    return {
      generatedAt: now.toISOString(), windowStart: since.toISOString(),
      suppliers: suppliers.map((row) => ({
        ...row,
        contacts: contacts.filter((contact) => contact.supplierId === row.id),
        performance: performance.find((item) => item.supplierId === row.id)!,
      })),
      inventory: inventory.map((row) => ({
        ...row,
        ...(canReadCosts && "sourceCostCents" in row ? { sourceCostCents: row.sourceCostCents === null ? null : String(row.sourceCostCents) } : {}),
      })),
      metricHistory: observations.map((row) => ({
        ...row, value: row.value === null ? null : String(row.value), observedOn: row.observedOn?.toISOString() ?? null,
        refreshedAt: row.refreshedAt.toISOString(),
      })),
      orderItemPerformance: normalizedItems.map((item) => ({
        itemId: item.itemId, listingId: item.listingId, supplierId: item.supplierId,
        listingTitle: item.listingTitle, placedAt: item.createdAt.toISOString(), state: item.state,
        placementMinor: item.placementMinor.toString(), writingMinor: item.writingMinor.toString(),
        refundMinor: item.refundMinor?.toString() ?? null, verifiedAt: item.verifiedAt?.toISOString() ?? null,
        supplierFailureRecorded: item.supplierFailureRecorded ?? false,
        ...(canReadCosts ? {
          ...(() => {
            const costs = financialByItem.get(item.itemId);
            const costStatus = costs?.costStatus ?? "UNKNOWN";
            const grossProfitMinor = costStatus === "CONFIRMED" && item.refundMinor !== null
              ? (item.placementMinor + item.writingMinor - item.refundMinor - BigInt(costs!.placementCostKnownMinor) - BigInt(costs!.writingDirectCostMinor ?? "0")).toString()
              : null;
            return {
              placementCostBySupplier: costs?.placementCosts ?? [],
              placementCostKnownMinor: costs?.placementCostKnownMinor ?? "0",
              writingDirectCostMinor: costs?.writingDirectCostMinor ?? null,
              writingCostStatus: costs?.writingCostStatus ?? "UNKNOWN",
              costStatus,
              grossProfitMinor,
              grossProfitStatus: grossProfitMinor === null ? costStatus : "CONFIRMED",
            };
          })(),
        } : {}),
      })),
      rejectedCount: [...rejectedCounts.values()].reduce((total, items) => total + items.size, 0),
      limitations: [],
    };
  });
}
