import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { listCustomerSupportCases } from "@/server/support/cases";
import { getMyOrders, getMyOrderItemForSupport } from "@/server/orders/checkout";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import { openSupportAction } from "./actions";
import styles from "./customer-support.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";

function statusLabel(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("waiting")) return "Waiting on you";
  if (normalized.includes("review")) return "In review";
  if (normalized.includes("resolved")) return "Resolved";
  return "Received";
}

export default async function CustomerSupportPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; itemId?: string | string[]; error?: string | string[]; page?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const requestedPage = firstQueryValue(params.page);
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(params.organizationId));
  if (!organizationId) return <p>An organization is required to view Support.</p>;
  let cases; let orders; let selectedItem;
  const requestHeaders = await headers();
  const itemId = firstQueryValue(params.itemId);
  try { [cases, orders, selectedItem] = await Promise.all([listCustomerSupportCases(requestHeaders, organizationId, requestedPage), getMyOrders(requestHeaders, organizationId),
    itemId ? getMyOrderItemForSupport(requestHeaders, organizationId, itemId) : Promise.resolve(null)]); }
  catch { return <p className={styles.notice}>Support could not be loaded. Refresh and try again.</p>; }
  const placements = orders.flatMap((order) => order.items.map((item) => ({ id: item.id, title: String(item.listing.title ?? "Placement"), orderId: order.id })));
  const titleCounts = new Map<string, number>();
  for (const item of placements) titleCounts.set(item.title, (titleCounts.get(item.title) ?? 0) + 1);
  const items = placements.map((item) => ({ id: item.id, label: titleCounts.get(item.title)! > 1 ? `${item.title} · Order ${item.orderId.slice(0, 8)}` : item.title }));
  if (selectedItem && !items.some((item) => item.id === selectedItem.id)) items.unshift(selectedItem);
  return <div className={styles.supportPage}>
    <header className={styles.supportHeading}>
      <div><h1>Support</h1><p>Get help with a placement and keep every reply with its order. Your requests remain available after marketplace access ends.</p></div>
      <span className={styles.replyPromise}>Replies stay in your workspace</span>
    </header>
    {params.error && <p role="alert" className={styles.supportError}>We couldn’t open your request. Check the placement and message, then try again.</p>}
    <div className={styles.supportGrid}>
      <section className={styles.requestPanel} aria-labelledby="your-requests-title">
        <header className={styles.panelHeading}>
          <div><h2 id="your-requests-title">Your requests</h2><p>Messages and updates from GPHKM</p></div>
        </header>
        {!cases.items.length ? <div className={styles.emptyRequests}>
          <span aria-hidden="true" className={styles.emptyIcon}>?</span>
          <h3>No support requests yet</h3>
          <p>If you need help with an order, choose its placement and send us a message.</p>
        </div> : <div className={styles.requestList}>{cases.items.map((item) => <Link className={styles.requestRow} href={`/customer/support/${item.id}?organizationId=${encodeURIComponent(organizationId)}`} key={item.id}>
          <div className={styles.requestRowMeta}><span className={`${styles.statusBadge} ${item.status === "Resolved" ? styles.statusResolved : item.status === "Waiting on you" ? styles.statusWaiting : ""}`}>{statusLabel(item.status)}</span><time dateTime={item.updatedAt}>Updated {new Date(item.updatedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</time></div>
          <strong>{item.summary}</strong>
          <span className={styles.requestRowFooter}>Order #{item.orderId.slice(0, 8).toUpperCase()} <span aria-hidden="true">↗</span></span>
        </Link>)}</div>}
        {cases.totalPages > 1 && <nav className={styles.pagination} aria-label="Support request pages">{cases.page > 1 ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page - 1}`}>← Newer</Link> : <span /> }<span>Page {cases.page} of {cases.totalPages}</span>{cases.page < cases.totalPages ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page + 1}`}>Older →</Link> : <span />}</nav>}
      </section>

      <section className={styles.newRequestPanel} aria-labelledby="new-request-title">
        <div className={styles.newRequestIntro}><span className={styles.newRequestIcon} aria-hidden="true">✉</span><div><h2 id="new-request-title">Send a message</h2><p>Choose a placement so we can find the right order.</p></div></div>
        {!items.length ? <div className={styles.noPlacements}><p>Support requests are linked to an order placement.</p><Link href={`/customer/orders?organizationId=${encodeURIComponent(organizationId)}`}>View your orders</Link></div> : <form action={openSupportAction} className={styles.supportForm}>
          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Placement<select name="orderItemId" defaultValue={items.some((item) => item.id === itemId) ? itemId : items[0].id} required>{items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>Your message<textarea name="summary" maxLength={2000} rows={5} required placeholder="Tell us what you need help with…" /></label>
          <p className={styles.formHint}>Text only · Up to 2,000 characters · Include only details needed to review this placement.</p>
          <button type="submit">Send to Support</button>
        </form>}
      </section>
    </div>
  </div>;
}
