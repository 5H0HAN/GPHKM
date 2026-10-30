import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { listing, listingCost, listingSourcing, supplier } from "@/db/catalog-schema";
import { orderItemFinancial, orderItemFulfillmentSupplier } from "@/db/order-schema";
import { supplierListingCostEvent, supplierOrderItemCostEvent, supplierPaymentRecord, supplierTransferAllocation, supplierTransferEvent, supplierTransferEvidence } from "@/db/supplier-finance-schema";
import { appendAuditEvent } from "@/server/audit/append";
import { requireStaffAccess } from "@/server/auth/staff";
import { deletePrivateFile, readPrivateFile, savePrivateFile } from "@/server/storage/private-files";
import { normalizeEvidenceReference, normalizeFinanceReason, normalizeTransferReference, parsePaymentDate, parseUsdMinor, validSupplierTransferEvidence } from "@/modules/supplier-finance/validation";
import { staffCatalogPagination } from "@/modules/catalog/pagination";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function withFinance<T>(headers: Headers, work: (tx: Tx, actor: { userId: string; role: string }) => Promise<T>, isolationLevel: "read committed" | "repeatable read" = "read committed") {
  const actor = await requireStaffAccess(headers, "costs.read");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return work(tx, actor);
  }, { isolationLevel });
}

export async function getSupplierFinanceData(headers: Headers, requestedPages: { listings?: unknown; orderItems?: unknown; transfers?: unknown } = {}) {
  return withFinance(headers, async (tx, actor) => {
    const [listingCount] = await tx.select({ total: sql<number>`count(*)::int` }).from(listing).innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id));
    const [transferCount] = await tx.select({ total: sql<number>`count(*)::int` }).from(supplierTransferEvent);
    const listingPagination = staffCatalogPagination(requestedPages.listings, listingCount?.total ?? 0);
    const transferPagination = staffCatalogPagination(requestedPages.transfers, transferCount?.total ?? 0);
    const listingRows = await tx.select({
      id: listing.id, title: listing.title, supplierId: listingSourcing.supplierId,
      supplierName: sql<string | null>`public.gphkm_finance_supplier_name(${listingSourcing.supplierId})`, currentCostMinor: listingCost.sourceCostCents,
    }).from(listing).innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .leftJoin(listingCost, eq(listingCost.listingId, listing.id))
      .orderBy(listing.title, listing.id).limit(listingPagination.limit).offset(listingPagination.offset);
    const listingHistory = await tx.select({
      id: supplierListingCostEvent.id, listingId: supplierListingCostEvent.listingId,
      supplierId: supplierListingCostEvent.supplierId,
      title: listing.title, supplierName: sql<string | null>`public.gphkm_finance_supplier_name(${supplierListingCostEvent.supplierId})`,
      previousCostMinor: supplierListingCostEvent.previousCostMinor, newCostMinor: supplierListingCostEvent.newCostMinor,
      reason: supplierListingCostEvent.reason, createdAt: supplierListingCostEvent.createdAt,
    }).from(supplierListingCostEvent).innerJoin(listing, eq(listing.id, supplierListingCostEvent.listingId))
      .orderBy(desc(supplierListingCostEvent.createdAt)).limit(60);
    const [orderItemCount] = await tx.select({ total: sql<number>`count(*)::int` }).from(orderItemFinancial);
    const orderItemPagination = staffCatalogPagination(requestedPages.orderItems, orderItemCount?.total ?? 0);
    const orderItemRows = await tx.select({
      id: orderItemFinancial.orderItemId,
      supplierId: orderItemFinancial.supplierId,
      fulfillmentSupplierId: orderItemFinancial.fulfillmentSupplierId,
      listingTitle: sql<string>`'Order item'`,
      supplierName: sql<string | null>`coalesce(public.gphkm_finance_supplier_name(${orderItemFinancial.supplierId}), public.gphkm_finance_supplier_name(${orderItemFinancial.fulfillmentSupplierId}))`,
      sourceCostMinor: orderItemFinancial.sourceCostMinor,
      writingCostMinor: orderItemFinancial.writingDirectCostMinor,
      writingSelected: sql<boolean>`public.gphkm_finance_writing_cost_allowed(${orderItemFinancial.orderItemId})`,
    }).from(orderItemFinancial)
      .orderBy(desc(orderItemFinancial.createdAt), desc(orderItemFinancial.orderItemId)).limit(orderItemPagination.limit).offset(orderItemPagination.offset);
    const supplierOptionsByItem = new Map<string, Array<{ id: string; name: string }>>();
    if (orderItemRows.length) {
      const itemIds = sql.join(orderItemRows.map((item) => sql`${item.id}`), sql`, `);
      const optionResult = await tx.execute(sql`
        SELECT requested.order_item_id AS "orderItemId", eligible.supplier_id AS "supplierId",
               public.gphkm_finance_supplier_name(eligible.supplier_id) AS "supplierName"
          FROM unnest(ARRAY[${itemIds}]::text[]) AS requested(order_item_id)
          CROSS JOIN LATERAL public.gphkm_finance_item_suppliers(requested.order_item_id) eligible
         ORDER BY requested.order_item_id, eligible.supplier_id
      `);
      const options = (optionResult as unknown as { rows?: Array<{ orderItemId: string; supplierId: string; supplierName: string | null }> }).rows ?? [];
      for (const option of options) {
        if (!option.supplierName) continue;
        const rows = supplierOptionsByItem.get(option.orderItemId) ?? [];
        rows.push({ id: option.supplierId, name: option.supplierName });
        supplierOptionsByItem.set(option.orderItemId, rows);
      }
    }
    const orderItems = orderItemRows.map((item) => ({ ...item, supplierOptions: supplierOptionsByItem.get(item.id) ?? [] }));
    const actualCostHistory = await tx.select({
      id: supplierOrderItemCostEvent.id, orderItemId: supplierOrderItemCostEvent.orderItemId,
      supplierId: supplierOrderItemCostEvent.supplierId,
      listingTitle: sql<string>`'Order item'`,
      supplierName: sql<string | null>`public.gphkm_finance_supplier_name(${supplierOrderItemCostEvent.supplierId})`, component: supplierOrderItemCostEvent.component,
      previousCostMinor: supplierOrderItemCostEvent.previousCostMinor, newCostMinor: supplierOrderItemCostEvent.newCostMinor,
      reason: supplierOrderItemCostEvent.reason, createdAt: supplierOrderItemCostEvent.createdAt,
    }).from(supplierOrderItemCostEvent)
      .orderBy(desc(supplierOrderItemCostEvent.createdAt)).limit(60);
    const legacyPayments = await tx.select({
      id: supplierPaymentRecord.id, supplierId: supplierPaymentRecord.supplierId,
      supplierName: sql<string>`public.gphkm_finance_supplier_name(${supplierPaymentRecord.supplierId})`, orderItemId: supplierPaymentRecord.orderItemId,
      amountMinor: supplierPaymentRecord.amountMinor, paymentDate: supplierPaymentRecord.paymentDate,
      status: supplierPaymentRecord.status, evidenceReference: supplierPaymentRecord.evidenceReference,
      reason: supplierPaymentRecord.reason, createdAt: supplierPaymentRecord.createdAt,
    }).from(supplierPaymentRecord)
      .orderBy(desc(supplierPaymentRecord.createdAt)).limit(60);
    const transfers = await tx.select({
      id: supplierTransferEvent.id, supplierId: supplierTransferEvent.supplierId,
      supplierName: sql<string>`public.gphkm_finance_supplier_name(${supplierTransferEvent.supplierId})`,
      amountMinor: supplierTransferEvent.amountMinor,
      transferDate: supplierTransferEvent.transferDate, transferReference: supplierTransferEvent.transferReference,
      evidenceReference: supplierTransferEvent.evidenceReference, reason: supplierTransferEvent.reason,
      createdAt: supplierTransferEvent.createdAt,
    }).from(supplierTransferEvent).orderBy(desc(supplierTransferEvent.createdAt), desc(supplierTransferEvent.id))
      .limit(transferPagination.limit).offset(transferPagination.offset);
    const allocations = transfers.length === 0 ? [] : await tx.select({
      transferEventId: supplierTransferAllocation.transferEventId,
      orderItemId: supplierTransferAllocation.orderItemId,
      listingTitle: sql<string>`'Order item'`,
      amountMinor: supplierTransferAllocation.amountMinor,
      supplierId: supplierTransferEvent.supplierId,
    }).from(supplierTransferAllocation)
      .innerJoin(supplierTransferEvent, eq(supplierTransferEvent.id, supplierTransferAllocation.transferEventId))
      .where(inArray(supplierTransferAllocation.transferEventId, transfers.map((transfer) => transfer.id)))
      .orderBy(desc(supplierTransferAllocation.createdAt));
    const transferEvidence = transfers.length === 0 ? [] : await tx.select({
      id: supplierTransferEvidence.id, transferEventId: supplierTransferEvidence.transferEventId,
      fileKind: supplierTransferEvidence.fileKind, createdAt: supplierTransferEvidence.createdAt,
    }).from(supplierTransferEvidence)
      .where(inArray(supplierTransferEvidence.transferEventId, transfers.map((transfer) => transfer.id)));
    const evidenceByTransfer = new Map(transferEvidence.map((evidence) => [evidence.transferEventId, evidence]));
    // Cost correction history is append-only and can grow for the lifetime of
    // the project. Reconciliation needs only the latest value per item,
    // supplier, and component; the full history is shown separately with its
    // intentional recent-history cap above.
    const allActualCosts = await tx.selectDistinctOn([
      supplierOrderItemCostEvent.orderItemId,
      supplierOrderItemCostEvent.supplierId,
      supplierOrderItemCostEvent.component,
    ], {
      orderItemId: supplierOrderItemCostEvent.orderItemId, supplierId: supplierOrderItemCostEvent.supplierId,
      supplierName: sql<string | null>`public.gphkm_finance_supplier_name(${supplierOrderItemCostEvent.supplierId})`,
      component: supplierOrderItemCostEvent.component, amountMinor: supplierOrderItemCostEvent.newCostMinor,
      createdAt: supplierOrderItemCostEvent.createdAt, id: supplierOrderItemCostEvent.id,
    }).from(supplierOrderItemCostEvent)
      .where(eq(supplierOrderItemCostEvent.component, "PLACEMENT"))
      .orderBy(
        supplierOrderItemCostEvent.orderItemId,
        supplierOrderItemCostEvent.supplierId,
        supplierOrderItemCostEvent.component,
        desc(supplierOrderItemCostEvent.createdAt),
        desc(supplierOrderItemCostEvent.id),
      );
    const currentCosts = new Map<string, bigint>();
    const supplierNamesByItem = new Map<string, string | null>();
    for (const cost of allActualCosts) {
      if (!cost.supplierId) continue;
      const key = `${cost.orderItemId}:${cost.supplierId}:${cost.component}`;
      supplierNamesByItem.set(`${cost.orderItemId}:${cost.supplierId}`, cost.supplierName);
      if (!currentCosts.has(key)) currentCosts.set(key, BigInt(cost.amountMinor));
    }
    const totals = new Map<string, bigint>();
    for (const [key, amount] of currentCosts) {
      const lastSeparator = key.lastIndexOf(":");
      const itemSupplierKey = key.slice(0, lastSeparator);
      totals.set(itemSupplierKey, (totals.get(itemSupplierKey) ?? 0n) + amount);
    }
    const transferTotals = await tx.select({
      orderItemId: supplierTransferAllocation.orderItemId, supplierId: supplierTransferEvent.supplierId,
      amountMinor: sql<string>`sum(${supplierTransferAllocation.amountMinor})`,
    }).from(supplierTransferAllocation)
      .innerJoin(supplierTransferEvent, eq(supplierTransferEvent.id, supplierTransferAllocation.transferEventId))
      .groupBy(supplierTransferAllocation.orderItemId, supplierTransferEvent.supplierId);
    const paidTotals = new Map<string, bigint>(transferTotals.map((row) => [`${row.orderItemId}:${row.supplierId}`, BigInt(row.amountMinor)]));
    const payableCoverage = [...totals.entries()].map(([key, cost]) => {
      const separator = key.indexOf(":");
      const orderItemId = key.slice(0, separator);
      const supplierId = key.slice(separator + 1);
      const paid = paidTotals.get(key) ?? 0n;
      const status = paid > cost ? "OVERPAID" : paid === cost ? "PAID" : paid === 0n ? "UNPAID" : "PARTIALLY_PAID";
      return { orderItemId, supplierId, supplierName: supplierNamesByItem.get(`${orderItemId}:${supplierId}`) ?? "Supplier", confirmedCostMinor: cost.toString(), transferredMinor: paid.toString(), status };
    });
    const allocationsByTransfer = new Map<string, typeof allocations>();
    for (const allocation of allocations) {
      const rows = allocationsByTransfer.get(allocation.transferEventId) ?? [];
      rows.push(allocation);
      allocationsByTransfer.set(allocation.transferEventId, rows);
    }
    const coverageByItem = new Map(payableCoverage.map((row) => [`${row.orderItemId}:${row.supplierId}`, row]));
    const transferReconciliation = transfers.map((transfer) => ({
      ...transfer,
      evidence: evidenceByTransfer.get(transfer.id) ?? null,
      allocations: (allocationsByTransfer.get(transfer.id) ?? []).map((allocation) => ({
        ...allocation,
        coverage: coverageByItem.get(`${allocation.orderItemId}:${transfer.supplierId}`)?.status ?? "PROVISIONAL",
      })),
    }));
    const accessedSupplierIds = [...new Set([
      ...listingRows.map((row) => row.supplierId), ...listingHistory.map((row) => row.supplierId),
      ...orderItems.flatMap((row) => [row.supplierId, row.fulfillmentSupplierId]), ...actualCostHistory.map((row) => row.supplierId),
      ...legacyPayments.map((row) => row.supplierId), ...transfers.map((row) => row.supplierId), ...allocations.map((row) => row.supplierId),
    ].filter((id): id is string => Boolean(id)))];
    await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "SUPPLIER_FINANCE_VIEWED", targetType: "supplier_finance", targetId: "dashboard",
      metadata: { listingCount: listingRows.length, listingPage: listingPagination.page, listingTotal: listingPagination.total,
        orderItemCount: orderItems.length, orderItemPage: orderItemPagination.page, orderItemTotal: orderItemPagination.total,
        transferCount: transfers.length, transferPage: transferPagination.page, transferTotal: transferPagination.total,
        historyCount: listingHistory.length + actualCostHistory.length + transfers.length + legacyPayments.length },
    });
    for (const supplierId of accessedSupplierIds) await appendAuditEvent(tx, {
      actorUserId: actor.userId, action: "SUPPLIER_IDENTITY_ACCESSED", targetType: "supplier", targetId: supplierId,
      reasonCode: "FINANCE_DASHBOARD_VIEW",
    });
    return { listings: listingRows, listingPagination, listingHistory, orderItems, orderItemPagination, actualCostHistory, payments: transferReconciliation, transferPagination, payableCoverage, legacyPayments };
  }, "repeatable read");
}

export async function searchSupplierTransferItems(headers: Headers, supplierId: string, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(query) || !/^[0-9a-f-]{36}$/i.test(supplierId)) return [];
  return withFinance(headers, async (tx, actor) => {
    const [supplierLookup] = await tx.select({ validSupplier: sql<boolean>`public.gphkm_finance_supplier_name(${supplier.id}) is not null` })
      .from(supplier).where(eq(supplier.id, supplierId)).limit(1);
    if (!supplierLookup?.validSupplier) return [];
    const rows = await tx.select({ id: orderItemFinancial.orderItemId, title: sql<string>`'Order item'` })
      .from(orderItemFinancial)
      .where(and(
        sql`public.gphkm_finance_item_supplier_allowed(${orderItemFinancial.orderItemId}, ${supplierId})`,
        ilike(orderItemFinancial.orderItemId, `${query}%`),
      ))
      .orderBy(desc(orderItemFinancial.createdAt), desc(orderItemFinancial.orderItemId)).limit(25);
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_IDENTITY_ACCESSED", targetType: "supplier", targetId: supplierId, reasonCode: "TRANSFER_ITEM_SEARCH" });
    return rows;
  });
}

export async function changeListingSourceCost(headers: Headers, input: { listingId: string; amount: string; reason: string }) {
  const amount = input.amount === "" ? null : parseUsdMinor(input.amount, true);
  const reason = normalizeFinanceReason(input.reason);
  if (!/^[0-9a-f-]{36}$/i.test(input.listingId) || (input.amount !== "" && amount === null) || !reason) throw new Error("Invalid cost correction");
  return withFinance(headers, async (tx, actor) => {
    const [target] = await tx.select({ id: listing.id, sourceCostMinor: listingCost.sourceCostCents, supplierId: listingSourcing.supplierId })
      .from(listing).innerJoin(listingSourcing, eq(listingSourcing.listingId, listing.id))
      .leftJoin(listingCost, eq(listingCost.listingId, listing.id)).where(eq(listing.id, input.listingId)).for("update").limit(1);
    if (!target) throw new Error("Listing unavailable");
    const previous = target.sourceCostMinor;
    if (previous === amount) throw new Error("Cost is unchanged");
    const eventId = randomUUID();
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_LISTING_COST_CORRECTED", targetType: "supplier_listing_cost_event", targetId: eventId, reasonCode: "COST_CORRECTION", metadata: { amountMinor: amount, result: "RECORDED" } });
    await tx.insert(supplierListingCostEvent).values({
      id: eventId, listingId: target.id, supplierId: target.supplierId,
      previousCostMinor: previous, newCostMinor: amount, reason, actorUserId: actor.userId,
    });
    await tx.execute(sql`select set_config('app.supplier_cost_event_id', ${eventId}, true)`);
    if (previous === null) await tx.insert(listingCost).values({ listingId: target.id, sourceCostCents: amount });
    else await tx.update(listingCost).set({ sourceCostCents: amount, updatedAt: new Date() }).where(eq(listingCost.listingId, target.id));
    return { id: eventId };
  });
}

export async function recordActualOrderCost(headers: Headers, input: { orderItemId: string; component: "PLACEMENT" | "WRITING"; supplierId: string | null; amount: string; reason: string }) {
  const amount = parseUsdMinor(input.amount, true);
  const reason = normalizeFinanceReason(input.reason);
  if (!/^[0-9a-f-]{36}$/i.test(input.orderItemId) || !["PLACEMENT", "WRITING"].includes(input.component) ||
      (input.supplierId !== null && !/^[0-9a-f-]{36}$/i.test(input.supplierId)) || !amount || !reason) throw new Error("Invalid actual cost");
  return withFinance(headers, async (tx, actor) => {
    const [financial] = await tx.select({ sourceCostMinor: orderItemFinancial.sourceCostMinor, writingCostMinor: orderItemFinancial.writingDirectCostMinor, supplierId: orderItemFinancial.supplierId, fulfillmentSupplierId: orderItemFinancial.fulfillmentSupplierId })
      .from(orderItemFinancial).where(eq(orderItemFinancial.orderItemId, input.orderItemId)).for("update").limit(1);
    if (!financial) throw new Error("Order item unavailable");
    if (input.component === "WRITING") {
      const eligibility = await tx.execute(sql`select public.gphkm_finance_writing_cost_allowed(${input.orderItemId}) as allowed`);
      const allowed = (eligibility as unknown as { rows?: Array<{ allowed: boolean }> }).rows?.[0]?.allowed === true;
      if (!allowed) throw new Error("Writing cost is unavailable for an item without purchased writing");
    }
    // Lock the private route row so concurrent accepted replacements and cost attribution serialize.
    await tx.select({ supplierId: orderItemFulfillmentSupplier.supplierId }).from(orderItemFulfillmentSupplier)
      .where(eq(orderItemFulfillmentSupplier.orderItemId, input.orderItemId)).for("update").limit(1);
    const supplierId = input.component === "WRITING" ? null : input.supplierId;
    const eligibleResult = await tx.execute(sql`select supplier_id from public.gphkm_finance_item_suppliers(${input.orderItemId})`);
    const eligibleSupplierIds = ((eligibleResult as unknown as { rows?: Array<{ supplier_id: string }> }).rows ?? []).map((row) => row.supplier_id);
    if (input.component === "PLACEMENT" && (supplierId ? !eligibleSupplierIds.includes(supplierId) : eligibleSupplierIds.length > 0)) {
      throw new Error("Select an authorized supplier for the placement cost");
    }
    const [latest] = await tx.select({ newCostMinor: supplierOrderItemCostEvent.newCostMinor })
      .from(supplierOrderItemCostEvent).where(and(
        eq(supplierOrderItemCostEvent.orderItemId, input.orderItemId),
        eq(supplierOrderItemCostEvent.component, input.component),
        supplierId === null ? isNull(supplierOrderItemCostEvent.supplierId) : eq(supplierOrderItemCostEvent.supplierId, supplierId),
      ))
      .orderBy(desc(supplierOrderItemCostEvent.createdAt)).limit(1);
    const originalSupplierId = financial.supplierId ?? financial.fulfillmentSupplierId;
    const previous = latest?.newCostMinor ?? (input.component === "PLACEMENT"
      ? supplierId === originalSupplierId ? financial.sourceCostMinor : null
      : financial.writingCostMinor);
    if (latest?.newCostMinor === amount) throw new Error("Cost is unchanged");
    const eventId = randomUUID();
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_ORDER_COST_CORRECTED", targetType: "supplier_order_item_cost_event", targetId: eventId, reasonCode: "ACTUAL_COST_CORRECTION", metadata: { amountMinor: amount, result: input.component } });
    await tx.insert(supplierOrderItemCostEvent).values({
      id: eventId, orderItemId: input.orderItemId, supplierId,
      component: input.component, previousCostMinor: previous === amount ? null : previous, newCostMinor: amount, reason, actorUserId: actor.userId,
    });
    return { id: eventId };
  });
}

export async function recordSupplierTransfer(headers: Headers, input: { supplierId: string; allocations: Array<{ orderItemId: string; amount: string }>; amount: string; date: string; transferReference: string; evidenceReference: string; reason: string; idempotencyKey: string; evidence: { kind: "EML" | "PDF"; bytes: Buffer } }) {
  const amount = parseUsdMinor(input.amount);
  if (!Array.isArray(input.allocations)) throw new Error("Invalid supplier transfer allocations");
  const normalizedAllocations = input.allocations.map((allocation) => ({ orderItemId: allocation.orderItemId, amountMinor: parseUsdMinor(allocation.amount) }));
  const uniqueOrderItemIds = new Set(normalizedAllocations.map((allocation) => allocation.orderItemId));
  const allocationTotal = normalizedAllocations.reduce((sum, allocation) => sum + BigInt(allocation.amountMinor ?? "0"), 0n);
  const transferDate = parsePaymentDate(input.date);
  const transferReference = normalizeTransferReference(input.transferReference);
  const evidenceReference = normalizeEvidenceReference(input.evidenceReference);
  const reason = normalizeFinanceReason(input.reason);
  const evidence = input.evidence;
  if (!evidence || !Buffer.isBuffer(evidence.bytes) || !validSupplierTransferEvidence(evidence.kind, evidence.bytes)) {
    throw new Error("Supplier transfer evidence must be a PDF or EML up to 5 MiB");
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.supplierId) || !amount || normalizedAllocations.length < 1 || normalizedAllocations.length > 100 ||
      normalizedAllocations.some((allocation) => !/^[0-9a-f-]{36}$/i.test(allocation.orderItemId) || !allocation.amountMinor) ||
      uniqueOrderItemIds.size !== normalizedAllocations.length || allocationTotal !== BigInt(amount) ||
      !transferDate || transferDate.getTime() > Date.now() || !transferReference || !evidenceReference || !reason || !/^[0-9a-f-]{36}$/i.test(input.idempotencyKey)) throw new Error("Invalid supplier transfer record");
  await requireStaffAccess(headers, "costs.read");
  const storageKey = await savePrivateFile(evidence.bytes);
  let transactionCallbackReturned = false;
  try {
    const result = await withFinance(headers, async (tx, actor) => {
    const canonicalAllocations = normalizedAllocations.map((allocation) => ({ orderItemId: allocation.orderItemId, amountMinor: allocation.amountMinor! })).sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
    const evidenceSha256 = createHash("sha256").update(evidence.bytes).digest("hex");
    const request = { supplierId: input.supplierId, allocations: canonicalAllocations, amount, date: transferDate.toISOString(), transferReference: transferReference.toLowerCase(), evidenceReference, evidenceKind: evidence.kind, evidenceSha256, reason };
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.userId}:${input.idempotencyKey}`}, 0))`);
    const [prior] = await tx.select({ id: supplierTransferEvent.id, requestHash: supplierTransferEvent.requestHash })
      .from(supplierTransferEvent).where(and(eq(supplierTransferEvent.actorUserId, actor.userId), eq(supplierTransferEvent.idempotencyKey, input.idempotencyKey))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("Supplier transfer idempotency key was reused for different details");
      transactionCallbackReturned = true;
      return { id: prior.id, replayed: true };
    }
    const requestedIds = sql.join(canonicalAllocations.map((allocation) => sql`${allocation.orderItemId}`), sql`, `);
    const targetResult = await tx.execute(sql`
      SELECT requested.order_item_id AS "orderItemId"
        FROM unnest(ARRAY[${requestedIds}]::text[]) AS requested(order_item_id)
       WHERE public.gphkm_finance_item_supplier_allowed(requested.order_item_id, ${input.supplierId})
    `);
    const targets = (targetResult as unknown as { rows?: Array<{ orderItemId: string }> }).rows ?? [];
    const [supplierLookup] = await tx.select({ validSupplier: sql<boolean>`public.gphkm_finance_supplier_name(${supplier.id}) is not null` })
      .from(supplier).where(eq(supplier.id, input.supplierId)).limit(1);
    const validSupplier = supplierLookup?.validSupplier ?? false;
    if (!validSupplier || targets.length !== canonicalAllocations.length) throw new Error("Supplier order item unavailable");
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_IDENTITY_ACCESSED", targetType: "supplier", targetId: input.supplierId, reasonCode: "PAYMENT_RECORD" });
    const id = randomUUID();
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_TRANSFER_RECORDED", targetType: "supplier_transfer_event", targetId: id, reasonCode: "MANUAL_TRANSFER", metadata: { amountMinor: amount, result: "RECORDED" } });
    const evidenceId = randomUUID();
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_TRANSFER_EVIDENCE_ATTACHED", targetType: "SUPPLIER_TRANSFER_EVIDENCE", targetId: evidenceId, metadata: { transferId: id, fileKind: evidence.kind, bytes: evidence.bytes.byteLength, sha256: evidenceSha256 } });
    await tx.insert(supplierTransferEvent).values({ id, idempotencyKey: input.idempotencyKey, requestHash, supplierId: input.supplierId, amountMinor: amount, transferDate, transferReference, evidenceReference, reason, actorUserId: actor.userId });
    for (const allocation of canonicalAllocations) {
      const allocationId = randomUUID();
      await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_TRANSFER_ALLOCATED", targetType: "supplier_transfer_allocation", targetId: allocationId, reasonCode: "MANUAL_TRANSFER_ALLOCATION", metadata: { transferId: id, orderItemId: allocation.orderItemId, amountMinor: allocation.amountMinor } });
      await tx.insert(supplierTransferAllocation).values({ id: allocationId, transferEventId: id, orderItemId: allocation.orderItemId, amountMinor: allocation.amountMinor, actorUserId: actor.userId });
    }
    await tx.insert(supplierTransferEvidence).values({ id: evidenceId, transferEventId: id, storageKey, fileKind: evidence.kind, fileName: `supplier-transfer-${id}.${evidence.kind.toLowerCase()}`, byteSize: evidence.bytes.byteLength, contentSha256: evidenceSha256, uploadedByUserId: actor.userId });
    transactionCallbackReturned = true;
    return { id, replayed: false };
    });
    if (result.replayed) await deletePrivateFile(storageKey).catch(() => undefined);
    return result;
  } catch (error) {
    // Once the callback has returned, a connection failure may mean COMMIT
    // succeeded but its acknowledgement was lost. Keep the file for review.
    if (!transactionCallbackReturned) await deletePrivateFile(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function downloadSupplierTransferEvidence(headers: Headers, evidenceId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(evidenceId)) throw new Error("Evidence unavailable");
  const row = await withFinance(headers, async (tx) => {
    const [evidence] = await tx.select().from(supplierTransferEvidence).where(eq(supplierTransferEvidence.id, evidenceId)).limit(1);
    if (!evidence) throw new Error("Evidence unavailable");
    return evidence;
  });
  const bytes = await readPrivateFile(row.storageKey, 5 * 1024 * 1024);
  if (bytes.byteLength !== row.byteSize || createHash("sha256").update(bytes).digest("hex") !== row.contentSha256) throw new Error("Evidence integrity check failed");
  await withFinance(headers, async (tx, actor) => {
    const [current] = await tx.select({ storageKey: supplierTransferEvidence.storageKey }).from(supplierTransferEvidence)
      .where(eq(supplierTransferEvidence.id, evidenceId)).limit(1);
    if (current?.storageKey !== row.storageKey) throw new Error("Evidence unavailable");
    await appendAuditEvent(tx, { actorUserId: actor.userId, action: "SUPPLIER_TRANSFER_EVIDENCE_DOWNLOADED", targetType: "SUPPLIER_TRANSFER_EVIDENCE", targetId: evidenceId, metadata: { fileKind: row.fileKind, result: "ALLOWED" } });
  });
  return { bytes, filename: row.fileName };
}
