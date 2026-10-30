import Link from "next/link";
import { headers } from "next/headers";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import { getCustomerNotifications } from "@/server/notifications/customer";
import { firstQueryValue } from "@/modules/query-params";
import { markNotificationReadAction } from "./actions";
import styles from "../customer.module.css";

export const dynamic = "force-dynamic";

function destination(row: { orderItemId: string | null; supportCaseId: string | null }, organizationId: string) {
  const query = `organizationId=${encodeURIComponent(organizationId)}`;
  if (row.supportCaseId) return `/customer/support/${encodeURIComponent(row.supportCaseId)}?${query}`;
  if (row.orderItemId) return `/customer/orders?${query}`;
  return `/customer/notifications?${query}`;
}

export default async function CustomerNotificationsPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; error?: string | string[]; page?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const requestedPage = firstQueryValue(params.page);
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(params.organizationId));
  if (!organizationId) return <p className={styles.error}>An organization is required to view notifications.</p>;
  let result;
  try { result = await getCustomerNotifications(await headers(), organizationId, requestedPage); }
  catch { return <p className={styles.error}>Notifications could not be loaded. Refresh and try again.</p>; }

  return <>
    <header className={styles.headingRow}><div><h1 className={styles.title}>Notifications</h1><p className={styles.subtitle}>Order progress and customer-visible Support updates for this organization.</p></div><span>{result.unreadCount} unread</span></header>
    {params.error && <p role="alert" className={styles.error}>The notification could not be updated. Refresh and try again.</p>}
    {!result.rows.length ? <section className={styles.panel}><h2 className={styles.panelTitle}>You’re all caught up</h2><p className={styles.panelText}>New order and Support updates will appear here.</p></section> : <div className="customerOrders">
      {result.rows.map((row) => <article className="customerOrder" key={row.id}>
        <header className="customerOrderHeader"><div><h2>{row.title}</h2><p>{row.body}</p></div><time dateTime={row.createdAt.toISOString()}>{row.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time></header>
        <div className="customerOrderItemTop"><Link href={destination(row, organizationId)}>Open update</Link>{row.readAt ? <span>Read</span> : <form action={markNotificationReadAction}>
          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="notificationId" value={row.id} />
          <input type="hidden" name="page" value={result.pagination.page} />
          <button type="submit">Mark as read</button>
        </form>}</div>
      </article>)}
    </div>}
    {result.pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Notification pages">{result.pagination.page > 1 ? <Link href={`/customer/notifications?organizationId=${encodeURIComponent(organizationId)}&page=${result.pagination.page - 1}`}>Previous</Link> : <span /> }<span>Page {result.pagination.page} of {result.pagination.totalPages} · {result.pagination.total} notifications</span>{result.pagination.page < result.pagination.totalPages ? <Link href={`/customer/notifications?organizationId=${encodeURIComponent(organizationId)}&page=${result.pagination.page + 1}`}>Next</Link> : <span />}</nav>}
  </>;
}
