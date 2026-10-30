import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSupportCases } from "@/server/support/cases";
import styles from "@/components/support.module.css";
import { PreHandoffCancellationQueue } from "./cancellations";
import { listStaffOrganizationClosures } from "@/server/identity/organization-closure";

export const dynamic = "force-dynamic";
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ reviewed?: string; cancellationError?: string; cancellationUpdated?: string; page?: string | string[]; cancellationPage?: string | string[]; closurePage?: string | string[] }> }) {
  const query = await searchParams;
  const requestedPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const cancellationPage = Array.isArray(query.cancellationPage) ? query.cancellationPage[0] : query.cancellationPage;
  const closurePage = Array.isArray(query.closurePage) ? query.closurePage[0] : query.closurePage;
  const { rows, actorRole, pagination } = await listStaffSupportCases(await headers(), requestedPage);
  const closures = actorRole === "ADMIN" || actorRole === "SUPER_ADMIN" ? await listStaffOrganizationClosures(await headers(), closurePage) : null;
  return <>
    <header className={styles.header}><div><h1>Support cases</h1><p>{actorRole === "FINANCE" ? "Cases referred for financial review. Decisions remain private and do not execute a refund." : "Customer requests for your assigned order items. Customer replies, internal notes, and Finance decisions have separate visibility."}</p></div>{actorRole === "SUPER_ADMIN" && <Link href="/staff/support/notices/reconciliation">Supplier notice reconciliation</Link>}</header>
    {query.reviewed && <p className={styles.notice}>The review was recorded and returned to the assigned Admin. No wallet funds were moved.</p>}
    {query.cancellationUpdated && <p className={styles.notice}>The cancellation decision was saved and audited.</p>}
    {query.cancellationError && <p className={styles.notice}>The cancellation request could not be updated. Refresh the queue and review its current state.</p>}
    <section className={styles.panel}><h2>{pagination.total} visible cases</h2>{!rows.length ? <p>No cases are currently available to your role or assignment.</p> : rows.map((row) => <Link className={styles.row} href={`/staff/support/${row.id}`} key={row.id}><strong>{row.summary}</strong><span>{row.state.replaceAll("_", " ").toLowerCase()} · Item {row.orderItemId.slice(0, 8)} · Updated {row.updatedAt.toLocaleString()}</span></Link>)}
      {pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Support case pages">{pagination.page > 1 ? <Link href={`/staff/support?page=${pagination.page - 1}`}>Previous</Link> : <span /> }<span>Page {pagination.page} of {pagination.totalPages}</span>{pagination.page < pagination.totalPages ? <Link href={`/staff/support?page=${pagination.page + 1}`}>Next</Link> : <span />}</nav>}
    </section>
    {closures && <section className={styles.panel}><h2>Organization closure requests · {closures.total} total</h2>{!closures.rows.length ? <p>No organization closure requests.</p> : closures.rows.map((row) => <Link className={styles.row} href={`/staff/support/closures/${row.id}`} key={row.id}><strong>{row.organizationName}</strong><span>{row.state.toLowerCase().replaceAll("_", " ")} · {row.summary} · Updated {row.updatedAt.toLocaleString()}</span></Link>)}
      {closures.totalPages > 1 && <nav className={styles.pagination} aria-label="Organization closure request pages">{closures.page > 1 ? <Link href={`/staff/support?page=${pagination.page}&closurePage=${closures.page - 1}`}>Previous</Link> : <span /> }<span>Page {closures.page} of {closures.totalPages}</span>{closures.page < closures.totalPages ? <Link href={`/staff/support?page=${pagination.page}&closurePage=${closures.page + 1}`}>Next</Link> : <span />}</nav>}
    </section>}
    {(actorRole === "ADMIN" || actorRole === "SUPER_ADMIN") && <PreHandoffCancellationQueue headers={await headers()} page={cancellationPage} supportPage={pagination.page} />}
  </>;
}
