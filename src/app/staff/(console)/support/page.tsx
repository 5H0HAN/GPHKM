import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSupportCases } from "@/server/support/cases";
import styles from "@/components/support.module.css";
import { PreHandoffCancellationQueue } from "./cancellations";
import { listStaffOrganizationClosures } from "@/server/identity/organization-closure";
import { SUPPORT_QUEUE_FILTERS } from "@/modules/support/cases";

export const dynamic = "force-dynamic";
const filterLabel: Record<(typeof SUPPORT_QUEUE_FILTERS)[number], string> = {
  ACTIVE: "Active work", ALL: "All cases", OPEN: "Received", INVESTIGATING: "In review",
  WAITING_ON_CUSTOMER: "Waiting on customer", WAITING_ON_SUPPLIER: "Waiting on supplier",
  FINANCE_REVIEW: "Finance review", RESOLVED: "Resolved", CLOSED: "Closed",
};

export default async function SupportPage({ searchParams }: { searchParams: Promise<{ reviewed?: string; cancellationError?: string; cancellationUpdated?: string; page?: string | string[]; state?: string | string[]; cancellationPage?: string | string[]; closurePage?: string | string[] }> }) {
  const query = await searchParams;
  const requestedPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const requestedFilter = Array.isArray(query.state) ? query.state[0] : query.state;
  const cancellationPage = Array.isArray(query.cancellationPage) ? query.cancellationPage[0] : query.cancellationPage;
  const closurePage = Array.isArray(query.closurePage) ? query.closurePage[0] : query.closurePage;
  const { rows, actorRole, pagination, filter } = await listStaffSupportCases(await headers(), requestedPage, requestedFilter);
  const stateQuery = filter === "ACTIVE" ? "" : `&state=${encodeURIComponent(filter)}`;
  const closures = actorRole === "ADMIN" || actorRole === "SUPER_ADMIN" ? await listStaffOrganizationClosures(await headers(), closurePage) : null;
  return <>
    <header className={styles.header}><div><h1>Support cases</h1><p>{actorRole === "FINANCE" ? "Cases referred for financial review. Decisions remain private and do not execute a refund." : "One active conversation per order, plus general requests without an order. Item actions remain scoped to each assigned placement."}</p></div>{actorRole === "SUPER_ADMIN" && <Link href="/staff/support/notices/reconciliation">Supplier notice reconciliation</Link>}</header>
    {query.reviewed && <p className={styles.notice}>The review was recorded and returned to the assigned Admin. No wallet funds were moved.</p>}
    {query.cancellationUpdated && <p className={styles.notice}>The cancellation decision was saved and audited.</p>}
    {query.cancellationError && <p className={styles.notice}>The cancellation request could not be updated. Refresh the queue and review its current state.</p>}
    <section className={styles.panel}>
      <h2>{pagination.total} {filter === "ACTIVE" ? "active" : "visible"} cases</h2>
      <form action="/staff/support" method="get" className={styles.queueFilter}>
        <label htmlFor="support-state">Case queue<select key={filter} id="support-state" name="state" defaultValue={filter}>{SUPPORT_QUEUE_FILTERS.map((value) => <option key={value} value={value}>{filterLabel[value]}</option>)}</select></label>
        <button type="submit">Apply filter</button>
        {filter !== "ACTIVE" && <Link href="/staff/support">Reset to active</Link>}
      </form>
      {!rows.length ? <p>No cases match this queue for your role or assignment.</p> : rows.map((row) => <Link className={styles.row} href={`/staff/support/${row.id}`} key={row.id}>
        <strong>{row.summary}</strong>
        <span className={styles.rowMeta}><span className={styles.stateLabel}>{filterLabel[row.state as keyof typeof filterLabel] ?? row.state}</span><span>{row.orderId ? `Order #${row.orderId.slice(0, 8).toUpperCase()} · ${row.itemCount} placement${row.itemCount === 1 ? "" : "s"}` : "General Support · no order attached"}</span><time dateTime={row.updatedAt.toISOString()}>Updated {row.updatedAt.toLocaleString()}</time></span>
      </Link>)}
      {pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Support case pages">{pagination.page > 1 ? <Link href={`/staff/support?page=${pagination.page - 1}${stateQuery}`}>Previous</Link> : <span /> }<span>Page {pagination.page} of {pagination.totalPages}</span>{pagination.page < pagination.totalPages ? <Link href={`/staff/support?page=${pagination.page + 1}${stateQuery}`}>Next</Link> : <span />}</nav>}
    </section>
    {closures && <section className={styles.panel}><h2>Organization closure requests · {closures.total} total</h2>{!closures.rows.length ? <p>No organization closure requests.</p> : closures.rows.map((row) => <Link className={styles.row} href={`/staff/support/closures/${row.id}`} key={row.id}><strong>{row.organizationName}</strong><span>{row.state.toLowerCase().replaceAll("_", " ")} · {row.summary} · Updated {row.updatedAt.toLocaleString()}</span></Link>)}
      {closures.totalPages > 1 && <nav className={styles.pagination} aria-label="Organization closure request pages">{closures.page > 1 ? <Link href={`/staff/support?page=${pagination.page}&closurePage=${closures.page - 1}${stateQuery}`}>Previous</Link> : <span /> }<span>Page {closures.page} of {closures.totalPages}</span>{closures.page < closures.totalPages ? <Link href={`/staff/support?page=${pagination.page}&closurePage=${closures.page + 1}${stateQuery}`}>Next</Link> : <span />}</nav>}
    </section>}
    {(actorRole === "ADMIN" || actorRole === "SUPER_ADMIN") && <PreHandoffCancellationQueue headers={await headers()} page={cancellationPage} supportPage={pagination.page} />}
  </>;
}
