import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { organization, walletAccount } from "@/db/schema";
import { listing } from "@/db/catalog-schema";
import { customerOrder, customerOrderItem, customerOrderItemMilestone, orderItemFulfillment, orderItemWriting, publicationEvidence } from "@/db/order-schema";
import { CONTENT_SHARING_NOTICE_VERSION, CUSTOMER_CONTENT_POLICY_VERSION, PLACEMENT_DISCLOSURE_VERSION, WRITING_REFUND_DISCLOSURE_VERSION, customerOrderPagination, customerOrderProjection, validateCheckoutInput, type CheckoutInput } from "@/modules/orders/checkout";
import { isMarketplaceTrialActive } from "@/modules/wallet/marketplace-trial";
import { requireVerifiedCustomer, withOrganizationContext, withProtectedOrganizationContext } from "@/server/identity/customer-context";
import { appendAuditEvent } from "@/server/audit/append";

const MAX_NUMERIC_20 = 10n ** 20n - 1n;

function requestDigest(input: CheckoutInput): string {
  const normalized = input.items.map((item) => ({
    listingId: item.listingId,
    expectedRevision: item.expectedRevision,
    targetUrl: item.targetUrl.trim(),
    anchorText: item.anchorText.trim(),
    instructions: item.instructions?.trim() ?? "",
    articleText: item.useWriting ? null : item.articleText?.trim(),
    writingBrief: item.useWriting ? item.writingBrief?.trim() : null,
    useWriting: item.useWriting === true,
    placementDisclosureVersion: PLACEMENT_DISCLOSURE_VERSION,
    writingRefundDisclosureVersion: item.useWriting === true ? WRITING_REFUND_DISCLOSURE_VERSION : null,
    shareWithPublicationPartner: item.shareWithPublicationPartner,
  }));
  return createHash("sha256").update(JSON.stringify({
    items: normalized,
    contentSharingNoticeVersion: CONTENT_SHARING_NOTICE_VERSION,
    contentPolicyVersion: CUSTOMER_CONTENT_POLICY_VERSION,
    acceptContentPolicy: input.acceptContentPolicy,
  })).digest("hex");
}

function listingSnapshot(row: typeof listing.$inferSelect, useWriting: boolean) {
  const retailPrice = Number(row.retailPriceCents);
  const writingPrice = row.writingPriceCents === null ? null : Number(row.writingPriceCents);
  const writingFirst = row.writingFirstDraftCents === null ? null : Number(row.writingFirstDraftCents);
  const writingFinal = row.writingFinalDraftCents === null ? null : Number(row.writingFinalDraftCents);
  if (![retailPrice, writingPrice, writingFirst, writingFinal].every((value) => value === null || Number.isSafeInteger(value))) {
    throw new Error("Listing price is outside the allowed range");
  }
  return {
    listingId: row.id,
    revision: row.revision,
    title: row.title,
    description: row.description,
    countryCode: row.countryCode,
    primaryLanguage: row.primaryLanguage,
    categories: row.categories,
    retailPriceCents: retailPrice,
    linkType: row.linkType,
    linkValidity: row.linkValidity,
    turnaroundDays: row.turnaroundDays,
    allowsSportsAndGaming: row.allowsSportsAndGaming,
    allowsPharmacy: row.allowsPharmacy,
    allowsCrypto: row.allowsCrypto,
    allowsForeignLanguage: row.allowsForeignLanguage,
    sponsoredContentMarking: row.sponsoredContentMarking,
    writingEnabled: row.writingEnabled,
    writingPriceCents: writingPrice,
    writingTurnaroundDays: row.writingTurnaroundDays,
    writingFirstDraftCents: writingFirst,
    writingFinalDraftCents: writingFinal,
    buyerRequirements: row.buyerRequirements,
    placementDisclosureVersion: PLACEMENT_DISCLOSURE_VERSION,
    writingRefundDisclosureVersion: useWriting ? WRITING_REFUND_DISCLOSURE_VERSION : null,
  };
}

export async function createWalletFundedOrder(headers: Headers, organizationId: string, rawInput: unknown) {
  const errors = validateCheckoutInput(rawInput);
  if (errors.length) throw new Error("Invalid order details");
  const input = rawInput as CheckoutInput;
  const digest = requestDigest(input);
  const actor = await requireVerifiedCustomer(headers);

  return withProtectedOrganizationContext(headers, organizationId, async (tx) => {
    // Match the provider-event lock order so an open Stripe risk case cannot
    // race a wallet debit. The webhook never takes an order lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('gphkm:wallet-risk:' || ${organizationId}, 0))`);
    const [existing] = await tx.select().from(customerOrder).where(and(
      eq(customerOrder.organizationId, organizationId),
      eq(customerOrder.actorUserId, actor.userId),
      eq(customerOrder.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (existing) {
      if (existing.requestHash !== digest) throw new Error("Idempotency key was already used for different order details");
      if (existing.checkoutState !== "PAID") throw new Error("Order checkout requires reconciliation");
      return { orderId: existing.id, totalMinor: existing.totalMinor, replayed: true };
    }

    const now = new Date();
    const [org] = await tx.select({ createdAt: organization.createdAt }).from(organization)
      .where(eq(organization.id, organizationId)).limit(1);
    if (!org) throw new Error("Organization unavailable");
    const trialActive = isMarketplaceTrialActive(org.createdAt, now);
    const { rows: accessRows } = await tx.execute(sql`select public.gphkm_customer_has_marketplace_access(${organizationId}) as active`);
    const paidAccess = (accessRows[0] as { active: boolean } | undefined)?.active === true;
    if (!trialActive && !paidAccess) throw new Error("Marketplace access required");

    const listingIds = input.items.map((item) => item.listingId);
    const rows = await tx.select().from(listing).where(inArray(listing.id, listingIds))
      .for("share");
    if (rows.length !== input.items.length || rows.some((row) => row.status !== "LIVE")) throw new Error("One or more listings are unavailable");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const orderId = randomUUID();
    const prepared = input.items.map((item) => {
      const row = byId.get(item.listingId);
      if (!row) throw new Error("One or more listings are unavailable");
      if (row.revision !== item.expectedRevision) throw new Error("One or more listings changed. Refresh your cart and review the updated details.");
      const useWriting = item.useWriting === true;
      if (useWriting && !row.writingEnabled) throw new Error("Writing is not available for one or more listings");
      const placement = BigInt(row.retailPriceCents);
      const writing = useWriting ? BigInt(row.writingPriceCents ?? "-1") : 0n;
      const first = useWriting ? BigInt(row.writingFirstDraftCents ?? "-1") : 0n;
      const final = useWriting ? BigInt(row.writingFinalDraftCents ?? "-1") : 0n;
      if (placement <= 0n || writing < 0n || first < 0n || final < 0n || first + final !== writing) throw new Error("Listing price is unavailable");
      return { id: randomUUID(), input: item, row, useWriting, placement, writing, first, final };
    });
    const placementTotal = prepared.reduce((sum, item) => sum + item.placement, 0n);
    const writingTotal = prepared.reduce((sum, item) => sum + item.writing, 0n);
    const total = placementTotal + writingTotal;
    if (total <= 0n || total > MAX_NUMERIC_20 || placementTotal > MAX_NUMERIC_20 || writingTotal > MAX_NUMERIC_20) {
      throw new Error("Order total is outside the allowed range");
    }

    // Serialize wallet spends and hold changes for this organization before checking sufficiency.
    await tx.execute(sql`select organization_id from public.wallet_account where organization_id = ${organizationId} for update`);
    const [afterLock] = await tx.select().from(customerOrder).where(and(
      eq(customerOrder.organizationId, organizationId),
      eq(customerOrder.actorUserId, actor.userId),
      eq(customerOrder.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (afterLock) {
      if (afterLock.requestHash !== digest) throw new Error("Idempotency key was already used for different order details");
      if (afterLock.checkoutState !== "PAID") throw new Error("Order checkout requires reconciliation");
      return { orderId: afterLock.id, totalMinor: afterLock.totalMinor, replayed: true };
    }
    const [wallet] = await tx.select({ balanceMinor: walletAccount.balanceMinor }).from(walletAccount)
      .where(eq(walletAccount.organizationId, organizationId)).limit(1);
    if (!wallet) throw new Error("Wallet unavailable");
    const { rows: holdRows } = await tx.execute(sql`select public.gphkm_customer_wallet_held_total(${organizationId}) as amount_minor`);
    const heldMinor = (holdRows[0] as { amount_minor: string } | undefined)?.amount_minor ?? "0";
    const available = BigInt(wallet.balanceMinor) - BigInt(heldMinor);
    if (available < total) throw new Error("Insufficient available wallet balance");

    await tx.insert(customerOrder).values({
      id: orderId,
      organizationId,
      actorUserId: actor.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: digest,
      currency: "USD",
      placementTotalMinor: placementTotal.toString(),
      writingTotalMinor: writingTotal.toString(),
      totalMinor: total.toString(),
      contentSharingNoticeVersion: CONTENT_SHARING_NOTICE_VERSION,
      contentPolicyVersion: CUSTOMER_CONTENT_POLICY_VERSION,
      contentPolicyAcceptedAt: now,
    });
    await tx.insert(customerOrderItem).values(prepared.map(({ id, input: item, row, useWriting, placement, writing, first, final }) => ({
      id,
      orderId,
      listingId: row.id,
      listingRevision: row.revision,
      customerListingSnapshot: listingSnapshot(row, useWriting),
      placementPriceMinor: placement.toString(),
      writingSelected: useWriting,
      writingPriceMinor: writing.toString(),
      writingFirstStageMinor: first.toString(),
      writingFinalStageMinor: final.toString(),
      targetUrl: item.targetUrl.trim(),
      anchorText: item.anchorText.trim(),
      instructions: item.instructions?.trim() ?? "",
      articleText: useWriting ? null : item.articleText!.trim(),
      writingBrief: useWriting ? item.writingBrief!.trim() : null,
      supplierSharingConsented: true,
      consentNoticeVersion: CONTENT_SHARING_NOTICE_VERSION,
    })));
    const writingRows = prepared.filter((item) => item.useWriting).map((item) => ({ orderItemId: item.id }));
    if (writingRows.length) await tx.insert(orderItemWriting).values(writingRows);

    const result = await tx.execute(sql`select public.gphkm_finalize_order_checkout(${orderId}) as ledger_id`);
    const ledgerId = (result as unknown as { rows: Array<{ ledger_id: string }> }).rows[0]?.ledger_id;
    if (!ledgerId) throw new Error("Checkout requires reconciliation");
    await appendAuditEvent(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: "ORDER_CHECKOUT_COMPLETED",
      targetType: "CUSTOMER_ORDER",
      targetId: orderId,
      metadata: { itemCount: prepared.length, amountMinor: total.toString(), result: "PAID" },
    });
    return { orderId, totalMinor: total.toString(), currency: "USD" as const, replayed: false };
  });
}

export async function getMyOrders(headers: Headers, organizationId: string, limit = 50) {
  return (await getMyOrdersPage(headers, organizationId, 1, limit)).orders;
}

export async function getMyOrdersPage(headers: Headers, organizationId: string, requestedPage: unknown = 1, pageSize = 50) {
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    // A customer request must not inherit a staff RLS policy if the same user
    // also has staff authority. Members see only orders they submitted.
    const scope = [eq(customerOrder.organizationId, organizationId)];
    if (role === "MEMBER") scope.push(eq(customerOrder.actorUserId, actor.userId));
    const [count] = await tx.select({ total: sql<number>`count(*)::integer` }).from(customerOrder).where(and(...scope));
    const pagination = customerOrderPagination(requestedPage, count.total, pageSize);
    const rows = await tx.select().from(customerOrder)
      .where(and(...scope))
      .orderBy(desc(customerOrder.createdAt), desc(customerOrder.id)).limit(pagination.limit).offset(pagination.offset);
    const ids = rows.map((row) => row.id);
    if (!ids.length) return { ...pagination, orders: [] };
    const items = await tx.select().from(customerOrderItem)
      .where(inArray(customerOrderItem.orderId, ids))
      .orderBy(desc(customerOrderItem.createdAt));
    const itemIds = items.map((item) => item.id);
    const fulfillment = itemIds.length ? await tx.select({
      orderItemId: orderItemFulfillment.orderItemId,
      customerStatus: orderItemFulfillment.customerStatus,
      updatedAt: orderItemFulfillment.updatedAt,
      nextUpdateAt: orderItemFulfillment.nextUpdateAt,
    }).from(orderItemFulfillment).where(inArray(orderItemFulfillment.orderItemId, itemIds)) : [];
    const milestoneRows = itemIds.length ? await tx.select({
      orderItemId: customerOrderItemMilestone.orderItemId,
      status: customerOrderItemMilestone.status,
      nextUpdateAt: customerOrderItemMilestone.nextUpdateAt,
      occurredAt: customerOrderItemMilestone.occurredAt,
    }).from(customerOrderItemMilestone).where(inArray(customerOrderItemMilestone.orderItemId, itemIds))
      .orderBy(desc(customerOrderItemMilestone.occurredAt), desc(customerOrderItemMilestone.id)) : [];
    const evidence = itemIds.length ? await tx.select({
      orderItemId: publicationEvidence.orderItemId,
      liveUrl: publicationEvidence.liveUrl,
    }).from(publicationEvidence).where(inArray(publicationEvidence.orderItemId, itemIds)) : [];
    const ownOrderIds = new Set(rows.filter((order) => order.actorUserId === actor.userId).map((order) => order.id));
    const writingItemIds = items.filter((item) => ownOrderIds.has(item.orderId)).map((item) => item.id);
    const writingRows = writingItemIds.length ? await tx.select({
      orderItemId: orderItemWriting.orderItemId, state: orderItemWriting.state,
      firstDraftText: orderItemWriting.firstDraftText, revisionRequestText: orderItemWriting.revisionRequestText,
      finalDraftText: orderItemWriting.finalDraftText, approvedArticleText: orderItemWriting.approvedArticleText,
      writingRefundMinor: orderItemWriting.writingRefundMinor,
    }).from(orderItemWriting).where(inArray(orderItemWriting.orderItemId, writingItemIds)) : [];
    const fulfillmentByItem = new Map(fulfillment.map((row) => [row.orderItemId, row]));
    const milestonesByItem = new Map<string, Array<{ status: string; nextUpdateAt: string | null; occurredAt: string }>>();
    for (const row of milestoneRows) {
      const history = milestonesByItem.get(row.orderItemId) ?? [];
      history.push({ status: row.status, nextUpdateAt: row.nextUpdateAt?.toISOString() ?? null, occurredAt: row.occurredAt.toISOString() });
      milestonesByItem.set(row.orderItemId, history);
    }
    const writingByItem = new Map(writingRows.map((row) => [row.orderItemId, row]));
    const urlsByItem = new Map<string, string[]>();
    for (const row of evidence) urlsByItem.set(row.orderItemId, [...(urlsByItem.get(row.orderItemId) ?? []), row.liveUrl]);
    type CustomerOrderItem = (typeof items)[number] & {
      lastUpdatedAt?: string | null; nextUpdateAt?: string | null; publicationUrls: string[];
      milestoneHistory: Array<{ status: string; nextUpdateAt: string | null; occurredAt: string }>;
      writingWorkflow: null | { state: string; firstDraftText: string | null; revisionRequestText: string | null; finalDraftText: string | null; approvedArticleText: string | null; writingRefundMinor: string };
    };
    const byOrder = new Map<string, CustomerOrderItem[]>();
    for (const item of items) {
      const progress = fulfillmentByItem.get(item.id);
      const writing = writingByItem.get(item.id);
      const customerItem: CustomerOrderItem = {
        ...item,
        ...(progress ? {
          customerStatus: progress.customerStatus,
          lastUpdatedAt: progress.updatedAt.toISOString(),
          nextUpdateAt: progress.nextUpdateAt?.toISOString() ?? null,
        } : {}),
        publicationUrls: urlsByItem.get(item.id) ?? [],
        milestoneHistory: milestonesByItem.get(item.id) ?? [],
        writingWorkflow: writing ? {
          state: writing.state, firstDraftText: writing.firstDraftText, revisionRequestText: writing.revisionRequestText,
          finalDraftText: writing.finalDraftText, approvedArticleText: writing.approvedArticleText,
          writingRefundMinor: writing.writingRefundMinor,
        } : null,
      };
      byOrder.set(item.orderId, [...(byOrder.get(item.orderId) ?? []), customerItem]);
    }
    return { ...pagination, orders: rows.map((order) => customerOrderProjection({ ...order, items: byOrder.get(order.id) ?? [] }, actor.userId)) };
  });
}

export async function getMyOrderItemForSupport(headers: Headers, organizationId: string, itemId: string) {
  const actor = await requireVerifiedCustomer(headers);
  return withOrganizationContext(headers, organizationId, async (tx, role) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) return null;
    const scope = [eq(customerOrder.organizationId, organizationId), eq(customerOrder.checkoutState, "PAID"), eq(customerOrderItem.id, itemId)];
    if (role === "MEMBER") scope.push(eq(customerOrder.actorUserId, actor.userId));
    const [item] = await tx.select({ id: customerOrderItem.id, orderId: customerOrder.id,
      title: sql<unknown>`${customerOrderItem.customerListingSnapshot}->>'title'`,
    }).from(customerOrderItem).innerJoin(customerOrder, eq(customerOrder.id, customerOrderItem.orderId))
      .where(and(...scope)).limit(1);
    return item ? { id: item.id, label: `${typeof item.title === "string" ? item.title : "Placement"} · Order ${item.orderId.slice(0, 8)}` } : null;
  });
}
