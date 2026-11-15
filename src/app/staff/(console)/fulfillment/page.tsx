import { randomUUID } from "node:crypto";
import Link from "next/link";
import { headers } from "next/headers";
import { listFulfillmentQueue } from "@/server/fulfillment/admin";
import styles from "./fulfillment.module.css";
import { assignFulfillmentAction } from "./actions";
import { customerStageSummary, fulfillmentStateLabel, isFulfillmentOverdue } from "@/modules/fulfillment/console";
import { RedirectingForm } from "./redirecting-form";
import { logSafeFailure } from "@/server/observability/safe-log";

export default async function FulfillmentPage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; view?: string | string[]; updated?: string; "assignment-failed"?: string; "invalid-item"?: string }> }) {
  const params = await searchParams;
  let queue: Awaited<ReturnType<typeof listFulfillmentQueue>>;
  try { queue = await listFulfillmentQueue(await headers(), params.page, params.view); }
  catch (error) {
    if (error instanceof Error && error.message === "Forbidden") return <>
      <header className={styles.header}><div><p className={styles.eyebrow}>ORDER OPERATIONS</p><h1>Fulfillment unavailable</h1><p className={styles.lede}>Your staff account does not have permission to view this queue.</p></div><Link className={styles.open} href="/staff">Back to overview</Link></header>
    </>;
    const requestId = randomUUID();
    logSafeFailure("fulfillment_queue_load_failed", error, requestId, { reasonCode: "FULFILLMENT_QUEUE" });
    return <>
      <header className={styles.header}><div><p className={styles.eyebrow}>ORDER OPERATIONS</p><h1>Fulfillment could not be loaded</h1><p className={styles.lede}>The queue status is temporarily unavailable.</p></div><Link className={styles.open} href="/staff/fulfillment">Reload queue</Link></header>
      <section className={styles.empty}>
        <p role="alert">Your previous action may already have completed. Reload the queue and check its current state before trying another action.</p>
        <p>If the problem continues, share reference {requestId} with your system administrator.</p>
      </section>
    </>;
  }
  const { rows, assignees, pagination, view, overdueCount, asOf, actorRole, actorUserId } = queue;
  const pageHref = (page: number) => `/staff/fulfillment?page=${page}${view === "all" ? "&view=all" : ""}`;
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>ORDER OPERATIONS</p><h1>Fulfillment</h1><p className={styles.lede}>Assign each placement, keep the customer’s next update current, and record the verified publication link.</p></div>
      <div className={styles.headerCounts}><Link className={styles.open} href="/staff/fulfillment/packets/reconciliation">Handoff reconciliation</Link><span className={styles.count}>{pagination.total} {view === "all" ? "total" : "active"} {pagination.total === 1 ? "item" : "items"}</span>{overdueCount > 0 && <span className={styles.overdueCount} role="status">{overdueCount} active overdue update{overdueCount === 1 ? "" : "s"}</span>}</div>
    </header>
    {params.updated === "1" && <p className={styles.success} role="status">Assignment saved. The queue below shows the latest assignment.</p>}
    {params["assignment-failed"] === "1" && <p className={styles.error} role="alert">We couldn’t confirm the assignment update. Review the current assignment below before trying again.</p>}
    {params["invalid-item"] === "1" && <p className={styles.error} role="alert">The item identifier was invalid. Nothing was changed.</p>}
    <nav className={styles.viewFilter} aria-label="Fulfillment view">
      <Link className={styles.open} href="/staff/fulfillment" aria-current={view === "active" ? "page" : undefined}>Active items</Link>
      <Link className={styles.open} href="/staff/fulfillment?view=all" aria-current={view === "all" ? "page" : undefined}>All items</Link>
    </nav>
    {!rows.length ? <section className={styles.empty}><h2>No orders in the queue</h2><p>Paid order items will appear here after checkout.</p></section> :
      <section className={styles.queue} aria-label="Fulfillment work queue">
        {rows.map((row) => {
          const canOpen = actorRole === "SUPER_ADMIN" || row.assignedAdminId === actorUserId;
          const customerStage = customerStageSummary(row.customerStatus);
          return <article className={styles.row} key={row.orderItemId}>
            <div className={styles.rowMain}>
              <div className={styles.titleLine}>
                <h2>{row.listingTitle}</h2>
                <div className={styles.statusLine}>
                  <span className={styles.status}>{fulfillmentStateLabel(row.state)}</span>
                  <span className={row.assignedAdminId ? styles.assignmentState : styles.assignmentNeeded}>{row.assignedAdminId ? `Assigned to ${row.assignedAdminName ?? "Admin"}` : "Needs assignment"}</span>
                </div>
              </div>
              <p className={styles.meta}>Order {row.orderId.slice(0, 8)} · Item {row.orderItemId.slice(0, 8)}</p>
              <p className={styles.update}>Customer stage: {customerStage.stageNumber ? `Stage ${customerStage.stageNumber} of ${customerStage.totalStages} · ` : ""}{customerStage.label} · Updated {row.updatedAt.toLocaleDateString()}</p>
              <p className={isFulfillmentOverdue(row.nextUpdateAt, row.state, asOf) ? styles.overdue : styles.update}>
                Next customer update: {row.nextUpdateAt?.toLocaleDateString() ?? "Not set"}
                {isFulfillmentOverdue(row.nextUpdateAt, row.state, asOf) ? " · OVERDUE" : ""}
              </p>
            </div>
            <div className={styles.controls}>
              <RedirectingForm action={assignFulfillmentAction} className={styles.assignForm}>
                <input type="hidden" name="itemId" value={row.orderItemId} />
                <input type="hidden" name="page" value={pagination.page} />
                <input type="hidden" name="view" value={view} />
                <label htmlFor={`assign-${row.orderItemId}`}>Assigned staff</label>
                <div className={styles.assignLine}>
                  <select id={`assign-${row.orderItemId}`} name="assignedAdminId" defaultValue={row.assignedAdminId ?? ""}>
                    <option value="">Unassigned</option>
                    {actorRole === "SUPER_ADMIN" ? <option value={actorUserId}>Super Admin (you)</option> : null}
                    {row.assignedAdminId && row.assignedAdminId !== actorUserId && !assignees.some((person) => person.id === row.assignedAdminId)
                      ? <option value={row.assignedAdminId}>Current assignee: {row.assignedAdminName ?? "Staff"}</option> : null}
                    {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                  <button type="submit">Save assignment</button>
                </div>
              </RedirectingForm>
              {canOpen ? <Link className={styles.open} href={`/staff/fulfillment/${row.orderItemId}`}>Open item</Link> : <span className={styles.restricted}>Assigned to {row.assignedAdminName ?? "another Admin"}</span>}
              {canOpen && row.state === "READY_FOR_HANDOFF" && row.fulfillmentSupplierId ? <Link className={styles.open} href={`/staff/fulfillment/packets/new?orderId=${encodeURIComponent(row.orderId)}`}>Prepare supplier packet</Link> : null}
            </div>
          </article>;
        })}
      </section>}
    {pagination.pageCount > 1 ? <nav className={styles.pagination} aria-label="Fulfillment queue pages">
      {pagination.page > 1 ? <Link className={styles.open} href={pageHref(pagination.page - 1)}>Previous</Link> : null}
      <span>Page {pagination.page} of {pagination.pageCount}</span>
      {pagination.page < pagination.pageCount ? <Link className={styles.open} href={pageHref(pagination.page + 1)}>Next</Link> : null}
    </nav> : null}
  </>;
}
