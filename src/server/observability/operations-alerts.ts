import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItemCancellationRequest } from "@/db/cancellation-schema";
import { organizationClosureRequest } from "@/db/closure-schema";
import { orderItemFulfillment } from "@/db/order-schema";
import { supportCase } from "@/db/support-schema";
import { staffAttentionDismissal } from "@/db/operations-schema";
import { listSupplierPacketReconciliation } from "@/server/fulfillment/packets";
import { getStripeWalletReconciliation, listOpenStripeAttempts } from "@/server/wallet/topups";
import { getLatestFinanceReconciliation } from "@/server/wallet/finance-reconciliation";
import { hasStaffPermission, type StaffRole } from "@/server/identity/policy";
import { boundedQueueCount, normalizeOperationTimestamp, OPERATIONS_INBOX_PREVIEW_LIMIT, staffSupportAttentionStates, supportNextAction, type OperationsAlert, type OperationsWorkItem } from "@/modules/observability/operations-inbox";
import { listUnknownCustomerEmails } from "@/server/notifications/reconciliation";
import { operationsWorkItemVersion } from "@/server/observability/attention-version";

type StaffInboxActor = { userId: string; role: StaffRole };

async function getRoleScopedWork(actor: StaffInboxActor) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);

    const active = notInArray(orderItemFulfillment.state, ["COMPLETED", "CANCELED_REFUNDED"]);
    const visibleFulfillment = actor.role === "SUPER_ADMIN"
      ? active
      : and(active, or(eq(orderItemFulfillment.assignedAdminId, actor.userId), isNull(orderItemFulfillment.assignedAdminId)));
    const overdueScope = and(
      visibleFulfillment,
      lte(orderItemFulfillment.nextUpdateAt, new Date()),
      actor.role === "SUPER_ADMIN" ? isNotNull(orderItemFulfillment.assignedAdminId) : eq(orderItemFulfillment.assignedAdminId, actor.userId),
    );
    const unassignedScope = and(visibleFulfillment, isNull(orderItemFulfillment.assignedAdminId));

    const [overdueCount] = hasStaffPermission(actor.role, "fulfillment.manage")
      ? await tx.select({ count: sql<number>`count(*)::int` }).from(orderItemFulfillment).where(overdueScope)
      : [{ count: 0 }];
    const overdueRows = overdueCount.count > 0 ? await tx.select({
      itemId: orderItemFulfillment.orderItemId,
      title: orderItemFulfillment.listingTitle,
      nextUpdateAt: orderItemFulfillment.nextUpdateAt,
    }).from(orderItemFulfillment).where(overdueScope)
      .orderBy(asc(orderItemFulfillment.nextUpdateAt), asc(orderItemFulfillment.orderItemId))
      .limit(OPERATIONS_INBOX_PREVIEW_LIMIT) : [];

    const [unassignedCount] = hasStaffPermission(actor.role, "fulfillment.manage")
      ? await tx.select({ count: sql<number>`count(*)::int` }).from(orderItemFulfillment).where(unassignedScope)
      : [{ count: 0 }];
    const unassignedRows = unassignedCount.count > 0 ? await tx.select({
      itemId: orderItemFulfillment.orderItemId,
      title: orderItemFulfillment.listingTitle,
      nextUpdateAt: orderItemFulfillment.nextUpdateAt,
    }).from(orderItemFulfillment).where(unassignedScope)
      .orderBy(asc(orderItemFulfillment.nextUpdateAt), asc(orderItemFulfillment.orderItemId))
      .limit(OPERATIONS_INBOX_PREVIEW_LIMIT) : [];

    const supportStates = staffSupportAttentionStates(actor.role);
    const supportScope = inArray(supportCase.state, supportStates);
    const [supportCount] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(supportCase).where(supportScope);
    const supportRows = supportCount.count > 0 ? await tx.select({
      caseId: supportCase.id,
      state: supportCase.state,
      updatedAt: supportCase.updatedAt,
    }).from(supportCase).where(supportScope)
      .orderBy(desc(supportCase.updatedAt), desc(supportCase.id))
      .limit(OPERATIONS_INBOX_PREVIEW_LIMIT) : [];

    const cancellationRows = hasStaffPermission(actor.role, "refund.pre-handoff.approve")
      ? await tx.select({
        total: sql<number>`count(*) over()::int`,
        id: orderItemCancellationRequest.id,
        orderItemId: orderItemCancellationRequest.orderItemId,
        requestedAt: orderItemCancellationRequest.requestedAt,
      }).from(orderItemCancellationRequest).where(eq(orderItemCancellationRequest.state, "REQUESTED"))
        .orderBy(asc(orderItemCancellationRequest.requestedAt), asc(orderItemCancellationRequest.id))
        .limit(OPERATIONS_INBOX_PREVIEW_LIMIT)
      : [];

    const closureRows = hasStaffPermission(actor.role, "organization.closure.manage")
      ? await tx.select({
        total: sql<number>`count(*) over()::int`,
        id: organizationClosureRequest.id,
        state: organizationClosureRequest.state,
        updatedAt: organizationClosureRequest.updatedAt,
      }).from(organizationClosureRequest)
        .where(notInArray(organizationClosureRequest.state, ["CLOSED"]))
        .orderBy(asc(organizationClosureRequest.updatedAt), asc(organizationClosureRequest.id))
        .limit(OPERATIONS_INBOX_PREVIEW_LIMIT)
      : [];

    let supplierNoticeRows: Array<{ total: number; noticeId: string; caseId: string; itemId: string; state: string; createdAt: Date }> = [];
    if (actor.role === "SUPER_ADMIN") {
      const result = await tx.execute(sql`
        WITH latest_attempt AS (
          SELECT DISTINCT ON (attempt.notice_id)
            attempt.notice_id, attempt.id, attempt.state, attempt.created_at
          FROM public.supplier_item_notice_attempt AS attempt
          ORDER BY attempt.notice_id, attempt.created_at DESC, attempt.id DESC
        ), actionable AS (
          SELECT notice.id AS notice_id, notice.case_id, notice.order_item_id AS item_id,
            attempt.state, attempt.created_at
          FROM public.supplier_item_notice AS notice
          JOIN latest_attempt AS attempt ON attempt.notice_id = notice.id
          WHERE attempt.state IN ('SENDING','UNKNOWN','ACCEPTED','RECONCILED_FAILED','EXPORTED','MANUAL_SENT','SUPPLIER_CONTINUING','UNABLE_TO_CONFIRM')
            AND EXISTS (
              SELECT 1 FROM public.post_handoff_refund_request AS refund
              WHERE refund.case_id = notice.case_id
                AND refund.order_item_id = notice.order_item_id
                AND refund.state = 'APPROVED'
            )
        )
        SELECT count(*) OVER()::int AS total, notice_id, case_id, item_id, state, created_at
        FROM actionable
        ORDER BY created_at ASC, notice_id ASC
        LIMIT ${OPERATIONS_INBOX_PREVIEW_LIMIT}
      `);
      supplierNoticeRows = ((result as unknown as { rows?: Array<{ total: number; notice_id: string; case_id: string; item_id: string; state: string; created_at: Date | string }> }).rows ?? [])
        .map((row) => ({ total: row.total, noticeId: row.notice_id, caseId: row.case_id, itemId: row.item_id, state: row.state, createdAt: normalizeOperationTimestamp(row.created_at) }));
    }

    let stagedImportCount = 0;
    let stagedImportRows: Array<{ batchId: string; createdAt: Date; rowCount: number; revision: string }> = [];
    if (hasStaffPermission(actor.role, "supplier.manage")) {
      const result = await tx.execute(sql`
        WITH batch_counts AS (
          SELECT batch.id AS batch_id, batch.created_at, count(*)::int AS row_count
          FROM public.catalog_import_batch AS batch
          JOIN public.catalog_import_row AS import_row ON import_row.batch_id = batch.id
          WHERE import_row.status IN ('READY', 'NEEDS_REVIEW', 'DUPLICATE_REVIEW', 'INVALID')
          GROUP BY batch.id, batch.created_at
        ), totals AS (
          SELECT coalesce(sum(row_count), 0)::int AS total FROM batch_counts
        ), previews AS (
          SELECT batch_id, created_at, row_count
          FROM batch_counts
          ORDER BY created_at ASC, batch_id ASC
          LIMIT ${OPERATIONS_INBOX_PREVIEW_LIMIT}
        )
        SELECT totals.total, previews.batch_id, previews.created_at, previews.row_count, revisions.row_revision
        FROM totals LEFT JOIN previews ON true
        LEFT JOIN LATERAL (
          SELECT md5(string_agg(import_row.id || ':' || import_row.xmin::text, ',' ORDER BY import_row.id)) AS row_revision
          FROM public.catalog_import_row AS import_row
          WHERE import_row.batch_id = previews.batch_id
            AND import_row.status IN ('READY', 'NEEDS_REVIEW', 'DUPLICATE_REVIEW', 'INVALID')
        ) AS revisions ON true
        ORDER BY previews.created_at ASC NULLS LAST, previews.batch_id ASC NULLS LAST
      `);
      const rows = (result as unknown as { rows?: Array<{ total: number; batch_id: string | null; created_at: Date | string | null; row_count: number | null; row_revision: string | null }> }).rows ?? [];
      stagedImportCount = Number(rows[0]?.total ?? 0);
      stagedImportRows = rows.flatMap((row) => row.batch_id && row.created_at && row.row_count !== null && row.row_revision
        ? [{ batchId: row.batch_id, createdAt: normalizeOperationTimestamp(row.created_at), rowCount: Number(row.row_count), revision: row.row_revision }]
        : []);
    }

    let overpaidCount = 0;
    let overpaidRows: Array<{ total: number; costEventId: string; orderItemId: string; updatedAt: Date; transferredMinor: string }> = [];
    if (hasStaffPermission(actor.role, "costs.read")) {
      const result = await tx.execute(sql`
        WITH latest_placement_cost AS (
          SELECT DISTINCT ON (cost.order_item_id, cost.supplier_id)
            cost.id AS cost_event_id, cost.order_item_id, cost.supplier_id,
            cost.new_cost_minor AS confirmed_cost_minor, cost.created_at
          FROM public.supplier_order_item_cost_event AS cost
          WHERE cost.component = 'PLACEMENT' AND cost.supplier_id IS NOT NULL
          ORDER BY cost.order_item_id, cost.supplier_id, cost.created_at DESC, cost.id DESC
        ), allocated_transfers AS (
          SELECT allocation.order_item_id, transfer.supplier_id,
            sum(allocation.amount_minor) AS transferred_minor,
            max(transfer.created_at) AS latest_transfer_at
          FROM public.supplier_transfer_allocation AS allocation
          JOIN public.supplier_transfer_event AS transfer ON transfer.id = allocation.transfer_event_id
          GROUP BY allocation.order_item_id, transfer.supplier_id
        ), overpaid AS (
          SELECT cost.cost_event_id, cost.order_item_id, allocation.transferred_minor::text AS transferred_minor,
            greatest(cost.created_at, allocation.latest_transfer_at) AS updated_at
          FROM latest_placement_cost AS cost
          JOIN allocated_transfers AS allocation
            ON allocation.order_item_id = cost.order_item_id AND allocation.supplier_id = cost.supplier_id
          WHERE allocation.transferred_minor > cost.confirmed_cost_minor
        ), totals AS (
          SELECT count(*)::int AS total FROM overpaid
        ), previews AS (
          SELECT cost_event_id, order_item_id, updated_at, transferred_minor
          FROM overpaid
          ORDER BY updated_at ASC, order_item_id ASC, cost_event_id ASC
          LIMIT ${OPERATIONS_INBOX_PREVIEW_LIMIT}
        )
        SELECT totals.total, previews.cost_event_id, previews.order_item_id, previews.updated_at, previews.transferred_minor
        FROM totals LEFT JOIN previews ON true
        ORDER BY previews.updated_at ASC NULLS LAST, previews.order_item_id ASC NULLS LAST, previews.cost_event_id ASC NULLS LAST
      `);
      const rows = (result as unknown as { rows?: Array<{ total: number; cost_event_id: string | null; order_item_id: string | null; updated_at: Date | string | null; transferred_minor: string | null }> }).rows ?? [];
      overpaidCount = Number(rows[0]?.total ?? 0);
      overpaidRows = rows.flatMap((row) => row.cost_event_id && row.order_item_id && row.updated_at && row.transferred_minor
        ? [{ total: Number(row.total), costEventId: row.cost_event_id, orderItemId: row.order_item_id, updatedAt: normalizeOperationTimestamp(row.updated_at), transferredMinor: row.transferred_minor }]
        : []);
    }

    return {
      overdueCount: overdueCount.count, overdueRows,
      unassignedCount: unassignedCount.count, unassignedRows,
      supportCount: supportCount.count, supportRows,
      cancellationCount: cancellationRows[0]?.total ?? 0, cancellationRows,
      closureCount: closureRows[0]?.total ?? 0, closureRows,
      supplierNoticeCount: supplierNoticeRows[0]?.total ?? 0, supplierNoticeRows,
      stagedImportCount, stagedImportRows,
      overpaidCount, overpaidRows,
    };
  });
}

function countAlert(input: Omit<OperationsAlert, "items"> & { items?: OperationsWorkItem[] }): OperationsAlert | null {
  return input.count > 0 ? { ...input, items: input.items ?? [] } : null;
}

export async function getStaffOperationsAlerts(headers: Headers, actor: StaffInboxActor) {
  const alerts: OperationsAlert[] = [];
  const work: Promise<void>[] = [];
  const scopedWork = getRoleScopedWork(actor);

  if (hasStaffPermission(actor.role, "fulfillment.manage")) {
    work.push((async () => {
      const data = await listSupplierPacketReconciliation(headers);
      const count = data.attemptsPagination.total + data.unmatchedEventsPagination.total
        + data.unpacketItemsPagination.total + data.heldPacketsPagination.total;
      const packetItems: OperationsWorkItem[] = [
        ...data.attempts.slice(0, 2).map((row) => ({
          key: `packet-attempt:${row.attemptId}`,
          title: `Order ${row.orderReference}`,
          detail: row.reason.replaceAll("_", " ").toLowerCase(),
          action: "Open packet",
          href: `/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`,
          updatedAt: (row.deliveredAt ?? row.acceptedAt ?? row.createdAt).toISOString(),
        })),
        ...data.heldPackets.slice(0, 2).map((row) => ({
          key: `held-packet:${row.packetId}`,
          title: `Order ${row.orderReference}`,
          detail: "Packet held for staff review",
          action: "Review packet",
          href: `/staff/fulfillment/packets/${encodeURIComponent(row.packetId)}`,
          updatedAt: row.updatedAt?.toISOString() ?? null,
        })),
        ...data.unpacketItems.slice(0, 2).map((row) => ({
          key: `unpacket-item:${row.itemId}`,
          title: `Order ${row.orderReference}`,
          detail: "Ready for handoff without a packet",
          action: "Review item",
          href: `/staff/fulfillment/${encodeURIComponent(row.itemId)}`,
          updatedAt: row.updatedAt.toISOString(),
        })),
        ...data.unmatchedEvents.filter((row) => row.packetId).slice(0, 2).map((row) => ({
          key: `unmatched-event:${row.eventId}`,
          title: `Order ${row.orderId?.slice(0, 8).toUpperCase() ?? "Unmatched event"}`,
          detail: `${row.eventType.replaceAll(".", " ")} needs reconciliation`,
          action: "Review packet",
          href: `/staff/fulfillment/packets/${encodeURIComponent(row.packetId!)}`,
          updatedAt: row.receivedAt.toISOString(), dateLabel: "Received",
        })),
      ].slice(0, OPERATIONS_INBOX_PREVIEW_LIMIT);
      const alert = countAlert({
        key: "supplier-handoffs", title: "Supplier handoffs", description: "Counts cover actionable records across the queues. Preview items are limited; open the queue to review all records.", noun: "review", count,
        saturated: false,
        href: "/staff/fulfillment/packets/reconciliation", action: "Open handoff queue", items: packetItems,
      });
      if (alert) alerts.push(alert);
    })());

    work.push(scopedWork.then((data) => {
      const alert = countAlert({
        key: "overdue-orders", title: "Customer updates due", description: "Review an assigned placement and record the next customer update in its fulfillment history.", noun: "placement", count: data.overdueCount,
        saturated: false, href: "/staff/fulfillment", action: "Open fulfillment",
        items: data.overdueRows.map((row) => ({
          key: `overdue:${row.itemId}`, title: row.title,
          detail: "The next customer update is overdue.",
          action: "Review item", href: `/staff/fulfillment/${encodeURIComponent(row.itemId)}`,
          updatedAt: row.nextUpdateAt?.toISOString() ?? null, dateLabel: "Was due",
        })),
      });
      if (alert) alerts.push(alert);
      const unassigned = countAlert({
        key: "unassigned-orders", title: "Placements awaiting assignment", description: "Assign an Admin before private order details can be opened. Assignment is recorded through the fulfillment workflow.", noun: "placement", count: data.unassignedCount,
        saturated: false, href: "/staff/fulfillment", action: "Assign placements",
        items: data.unassignedRows.map((row) => ({
          key: `unassigned:${row.itemId}`, title: row.title,
          detail: `Item ${row.itemId.slice(0, 8).toUpperCase()} · Assignment needed`,
          action: "Open assignment queue", href: "/staff/fulfillment", updatedAt: row.nextUpdateAt?.toISOString() ?? null,
          dateLabel: "Next update scheduled",
        })),
      });
      if (unassigned) alerts.push(unassigned);
      const supportDescription = actor.role === "FINANCE"
        ? "Only cases awaiting a Finance decision are shown. Record the decision in the audited Support workflow."
        : actor.role === "ADMIN"
          ? "Cases on orders with items assigned to you and standalone cases appear here when they need staff review or supplier follow-up. Resolve them in Support; cases waiting on customers remain in the case queue."
          : "Review assigned staff cases, supplier follow-ups, and Finance decisions. Resolve each case through its audited workflow.";
      const support = countAlert({
        key: "support-cases", title: actor.role === "FINANCE" ? "Support cases awaiting Finance" : "Support cases to review",
        description: supportDescription, noun: "case", count: data.supportCount, saturated: false,
        href: "/staff/support", action: actor.role === "FINANCE" ? "Open Finance review" : "Open Support",
        items: data.supportRows.map((row) => ({
          key: `support:${row.caseId}`, title: `Case ${row.caseId.slice(0, 8).toUpperCase()}`,
          detail: row.state === "FINANCE_REVIEW" ? "Finance review required" : row.state === "OPEN" ? "New customer request" : row.state === "WAITING_ON_SUPPLIER" ? "Supplier response follow-up" : "Investigation in progress",
          action: supportNextAction(row.state), href: `/staff/support/${encodeURIComponent(row.caseId)}`,
          updatedAt: row.updatedAt.toISOString(),
        })),
      });
      if (support) alerts.push(support);

      if (hasStaffPermission(actor.role, "refund.pre-handoff.approve")) {
        const cancellations = countAlert({
          key: "cancellation-requests", title: "Cancellation requests",
          description: "Review assigned pre-handoff requests and record an audited decision.",
          noun: "request", count: data.cancellationCount, saturated: false,
          href: "/staff/support", action: "Review cancellation queue",
          items: data.cancellationRows.map((row) => ({
            key: `cancellation:${row.id}`, title: `Order item ${row.orderItemId.slice(0, 8).toUpperCase()}`,
            detail: "Pre-handoff cancellation decision needed", action: "Open review queue",
            href: "/staff/support", updatedAt: row.requestedAt.toISOString(), dateLabel: "Requested",
          })),
        });
        if (cancellations) alerts.push(cancellations);
      }

      if (hasStaffPermission(actor.role, "organization.closure.manage")) {
        const closures = countAlert({
          key: "organization-closures", title: "Organization closure requests",
          description: "Review open closure requests and their current blockers in Support.",
          noun: "request", count: data.closureCount, saturated: false,
          href: "/staff/support", action: "Open closure queue",
          items: data.closureRows.map((row) => ({
          key: `closure:${row.id}`, title: `Closure request ${row.id.slice(0, 8).toUpperCase()}`,
            detail: row.state.replaceAll("_", " ").toLowerCase(), action: "Review request",
            href: `/staff/support/closures/${encodeURIComponent(row.id)}`,
            updatedAt: row.updatedAt.toISOString(),
          })),
        });
        if (closures) alerts.push(closures);
      }

      if (actor.role === "SUPER_ADMIN") {
        const notices = countAlert({
          key: "supplier-notices", title: "Supplier notices needing reconciliation",
          description: "Review supplier outcomes for approved post-handoff refunds.",
          noun: "notice", count: data.supplierNoticeCount, saturated: false,
          href: "/staff/support/notices/reconciliation", action: "Review notice queue",
          items: data.supplierNoticeRows.map((row) => ({
            key: `supplier-notice:${row.noticeId}`, title: `Supplier notice · ${row.state.replaceAll("_", " ").toLowerCase()}`,
            detail: `Case ${row.caseId.slice(0, 8).toUpperCase()} · item ${row.itemId.slice(0, 8).toUpperCase()}`,
            action: "Review case", href: `/staff/support/${encodeURIComponent(row.caseId)}`,
            updatedAt: row.createdAt.toISOString(),
          })),
        });
        if (notices) alerts.push(notices);
      }
    }));
  } else {
    work.push(scopedWork.then((data) => {
      const support = countAlert({
        key: "support-cases", title: "Support cases awaiting Finance", description: "Only cases awaiting a Finance decision are shown. Record the decision in the audited Support workflow.",
        noun: "case", count: data.supportCount, saturated: false, href: "/staff/support", action: "Open Finance review",
        items: data.supportRows.map((row) => ({
          key: `support:${row.caseId}`, title: `Case ${row.caseId.slice(0, 8).toUpperCase()}`,
          detail: row.state === "WAITING_ON_SUPPLIER" ? "Supplier response follow-up" : "Finance review required", action: supportNextAction(row.state),
          href: `/staff/support/${encodeURIComponent(row.caseId)}`, updatedAt: row.updatedAt.toISOString(),
        })),
      });
      if (support) alerts.push(support);
    }));
  }

  work.push(scopedWork.then((data) => {
    if (hasStaffPermission(actor.role, "supplier.manage")) {
      const imports = countAlert({
        key: "staged-import-rows", title: "Supplier import rows to review",
        description: "Review or apply staged rows from supplier imports. Counts cover every batch; previews show batch totals only.",
        noun: "row", count: data.stagedImportCount, saturated: false,
        href: "/staff/suppliers/imports", action: "Open supplier imports",
        items: data.stagedImportRows.map((row) => ({
          key: `staged-import:${row.batchId}`,
          title: `Import batch ${row.batchId.slice(0, 8).toUpperCase()}`,
          detail: `${row.rowCount} staged row${row.rowCount === 1 ? "" : "s"} need review or application`,
          action: "Review batch", href: `/staff/suppliers/imports/${encodeURIComponent(row.batchId)}`,
          updatedAt: row.createdAt.toISOString(), dateLabel: "Staged", revision: row.revision,
        })),
      });
      if (imports) alerts.push(imports);
    }

    if (hasStaffPermission(actor.role, "costs.read")) {
      const overpayments = countAlert({
        key: "supplier-overpayments", title: "Supplier overpayments",
        description: "Review transfers that exceed the latest confirmed placement cost. Counts are exact; previews omit supplier identity and transfer details.",
        noun: "coverage item", count: data.overpaidCount, saturated: false,
        href: "/staff/suppliers/finance#payable-coverage", action: "Review supplier finance",
        items: data.overpaidRows.map((row) => ({
          key: `overpaid:${row.costEventId}`,
          title: `Order item ${row.orderItemId.slice(0, 8).toUpperCase()}`,
          detail: "Recorded transfer exceeds confirmed placement cost",
          action: "Review coverage", href: "/staff/suppliers/finance#payable-coverage",
          updatedAt: row.updatedAt.toISOString(), dateLabel: "Coverage updated",
          revision: row.transferredMinor,
        })),
      });
      if (overpayments) alerts.push(overpayments);
    }
  }));

  if (hasStaffPermission(actor.role, "wallet.reconcile")) {
    work.push((async () => {
      const events = await getStripeWalletReconciliation(headers);
      const alert = countAlert({
        key: "payment-events", title: "Payment events", description: "Review provider events, active holds, and unmatched funding facts.", noun: "event", count: events.length,
        saturated: events.length >= 200, href: "/staff/reconciliation", action: "Open reconciliation", items: [],
      });
      if (alert) alerts.push(alert);
    })());
    work.push((async () => {
      const attempts = await listOpenStripeAttempts(headers);
      const alert = countAlert({
        key: "open-payment-attempts", title: "Wallet funding attempts", description: "Confirm provider outcomes for attempts that remain open.", noun: "attempt", count: attempts.length,
        saturated: attempts.length >= 100, href: "/staff/reconciliation", action: "Review attempts", items: [],
      });
      if (alert) alerts.push(alert);
    })());
    work.push((async () => {
      const snapshot = await getLatestFinanceReconciliation(headers);
      const unresolved = snapshot?.findings.filter((finding) => finding.outcome === null || finding.outcome === "FOLLOW_UP_REQUIRED").length ?? 0;
      const alert = countAlert({
        key: "wallet-findings", title: "Wallet reconciliation findings", description: "Review findings that need a Finance decision or follow-up evidence.", noun: "finding", count: unresolved,
        saturated: unresolved >= 500, href: "/staff/reconciliation", action: "Review findings", items: [],
      });
      if (alert) alerts.push(alert);
    })());
  }

  if (actor.role === "SUPER_ADMIN") {
    work.push((async () => {
      const unknownEmails = await listUnknownCustomerEmails(headers);
      const { count, saturated } = boundedQueueCount(unknownEmails.length, 100);
      const alert = countAlert({
        key: "customer-email-outcomes", title: "Customer email outcomes",
        description: "Review ambiguous customer email delivery before taking any follow-up action.",
        noun: "outcome", count, saturated,
        href: "/staff/reconciliation", action: "Open email reconciliation",
        items: unknownEmails.slice(0, OPERATIONS_INBOX_PREVIEW_LIMIT).map((row) => ({
          key: `customer-email:${row.outbox_id}`,
          title: `Customer notice · ${row.notification_kind.replaceAll("_", " ").toLowerCase()}`,
          detail: `${row.attempts} delivery attempt${row.attempts === 1 ? "" : "s"} need an outcome review`,
          action: "Review outcome", href: "/staff/reconciliation",
          updatedAt: row.created_at.toISOString(), dateLabel: "Created",
        })),
      });
      if (alert) alerts.push(alert);
    })());
  }
  await Promise.all(work);
  const orderedAlerts = alerts.sort((a, b) => a.key.localeCompare(b.key));
  const itemKeys = [...new Set(orderedAlerts.flatMap((alert) => alert.items.map((item) => item.key)))];
  const dismissals = itemKeys.length ? await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actor.userId}, true)`);
    return tx.select({ taskKey: staffAttentionDismissal.taskKey, taskVersion: staffAttentionDismissal.taskVersion })
      .from(staffAttentionDismissal)
      .where(and(eq(staffAttentionDismissal.staffUserId, actor.userId), inArray(staffAttentionDismissal.taskKey, itemKeys)));
  }) : [];
  const doneVersions = new Map(dismissals.map((row) => [row.taskKey, row.taskVersion]));
  return orderedAlerts.map((alert) => ({
    ...alert,
    items: alert.items.map((item) => {
      const version = operationsWorkItemVersion(item);
      const displayItem = { ...item };
      delete displayItem.revision;
      return { ...displayItem, version, done: doneVersions.get(item.key) === version };
    }),
  }));
}
