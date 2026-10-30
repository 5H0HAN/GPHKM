import Link from "next/link";
import { headers } from "next/headers";
import { listFulfillmentQueue } from "@/server/fulfillment/admin";
import styles from "./fulfillment.module.css";
import { assignFulfillmentAction } from "./actions";
import { isFulfillmentOverdue } from "@/modules/fulfillment/console";

const stateLabels: Record<string, string> = {
  CONFIRMED: "Order received", CONTENT_PREPARATION: "Content review", AWAITING_CUSTOMER_APPROVAL: "Waiting on customer",
  READY_FOR_HANDOFF: "Ready for placement", HANDOFF_PENDING: "Preparing placement", IN_FULFILLMENT: "Placement in progress",
  PUBLICATION_PENDING: "Link verification", EVIDENCE_REVIEW: "Link verification", COMPLETED: "Complete", ON_HOLD: "On hold",
  CANCELLATION_REQUESTED: "Cancellation review", CANCELED_REFUNDED: "Resolved",
};

export default async function FulfillmentPage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; view?: string | string[] }> }) {
  const params = await searchParams;
  const { rows, assignees, pagination, view, overdueCount, asOf, actorRole, actorUserId } = await listFulfillmentQueue(await headers(), params.page, params.view);
  const pageHref = (page: number) => `/staff/fulfillment?page=${page}${view === "all" ? "&view=all" : ""}`;
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>ORDER OPERATIONS</p><h1>Fulfillment</h1><p className={styles.lede}>Assign each placement, keep the customer’s next update current, and record the verified publication link.</p></div>
      <div className={styles.headerCounts}><span className={styles.count}>{pagination.total} {view === "all" ? "total" : "active"} items</span>{overdueCount > 0 && <span className={styles.overdueCount} role="status">{overdueCount} active overdue update{overdueCount === 1 ? "" : "s"}</span>}</div>
    </header>
    <nav className={styles.viewFilter} aria-label="Fulfillment view">
      <Link className={styles.open} href="/staff/fulfillment" aria-current={view === "active" ? "page" : undefined}>Active items</Link>
      <Link className={styles.open} href="/staff/fulfillment?view=all" aria-current={view === "all" ? "page" : undefined}>All items</Link>
    </nav>
    {!rows.length ? <section className={styles.empty}><h2>No orders in the queue</h2><p>Paid order items will appear here after checkout.</p></section> :
      <section className={styles.queue} aria-label="Fulfillment work queue">
        {rows.map((row) => {
          const canOpen = actorRole === "SUPER_ADMIN" || row.assignedAdminId === actorUserId;
          return <article className={styles.row} key={row.orderItemId}>
            <div className={styles.rowMain}>
              <div className={styles.titleLine}><h2>{row.listingTitle}</h2><span className={styles.status}>{stateLabels[row.state] ?? row.state}</span></div>
              <p className={styles.meta}>Order {row.orderId.slice(0, 8)} · Item {row.orderItemId.slice(0, 8)}</p>
              <p className={styles.update}>Customer status: {row.customerStatus.replaceAll("_", " ").toLowerCase()} · Updated {row.updatedAt.toLocaleDateString()}</p>
              <p className={isFulfillmentOverdue(row.nextUpdateAt, row.state, asOf) ? styles.overdue : styles.update}>
                Next customer update: {row.nextUpdateAt?.toLocaleDateString() ?? "Not set"}
                {isFulfillmentOverdue(row.nextUpdateAt, row.state, asOf) ? " · OVERDUE" : ""}
              </p>
            </div>
            <div className={styles.controls}>
              <form action={assignFulfillmentAction} className={styles.assignForm}>
                <input type="hidden" name="itemId" value={row.orderItemId} />
                <label htmlFor={`assign-${row.orderItemId}`}>Assigned Admin</label>
                <div className={styles.assignLine}>
                  <select id={`assign-${row.orderItemId}`} name="assignedAdminId" defaultValue={row.assignedAdminId ?? ""}>
                    <option value="">Unassigned</option>
                    {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                  <button type="submit">Save</button>
                </div>
              </form>
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
