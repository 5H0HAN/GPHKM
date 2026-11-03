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

export default async function CustomerSupportPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; orderId?: string | string[]; itemId?: string | string[]; error?: string | string[]; page?: string | string[] }> }) {
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
  const requestedOrderId = firstQueryValue(params.orderId) ?? selectedItem?.orderId ?? "";
  const orderOptions = orders.map((order) => ({
    id: order.id,
    label: `Order #${order.id.slice(0, 8).toUpperCase()} · ${order.items.length} placement${order.items.length === 1 ? "" : "s"}`,
  }));
  if (selectedItem && !orderOptions.some((order) => order.id === selectedItem.orderId)) {
    orderOptions.unshift({
      id: selectedItem.orderId,
      label: `Order #${selectedItem.orderId.slice(0, 8).toUpperCase()} · includes selected placement`,
    });
  }
  const selectedOrderId = orderOptions.some((order) => order.id === requestedOrderId) ? requestedOrderId : "";
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
          <p>If you need help with an order, attach it to your message. General Support stays unlinked.</p>
        </div> : <div className={styles.requestList}>{cases.items.map((item) => <Link className={styles.requestRow} href={`/customer/support/${item.id}?organizationId=${encodeURIComponent(organizationId)}`} key={item.id}>
          <div className={styles.requestRowMeta}><span className={`${styles.statusBadge} ${item.status === "Resolved" ? styles.statusResolved : item.status === "Waiting on you" ? styles.statusWaiting : ""}`}>{statusLabel(item.status)}</span><time dateTime={item.updatedAt}>Updated {new Date(item.updatedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</time></div>
          <strong>{item.summary}</strong>
          <span className={styles.requestRowFooter}>{item.orderId ? `Order #${item.orderId.slice(0, 8).toUpperCase()}` : "General Support"} <span aria-hidden="true">↗</span></span>
        </Link>)}</div>}
        {cases.totalPages > 1 && <nav className={styles.pagination} aria-label="Support request pages">{cases.page > 1 ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page - 1}`}>← Newer</Link> : <span /> }<span>Page {cases.page} of {cases.totalPages}</span>{cases.page < cases.totalPages ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page + 1}`}>Older →</Link> : <span />}</nav>}
      </section>

      <section className={styles.newRequestPanel} aria-labelledby="new-request-title">
        <div className={styles.newRequestIntro}><span className={styles.newRequestIcon} aria-hidden="true">✉</span><div><h2 id="new-request-title">Send a message</h2><p>Attach an order when the question is about one. Leave General Support selected for an unlinked request.</p></div></div>
        <form action={openSupportAction} className={styles.supportForm}>
          <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Order (optional)<select name="orderId" defaultValue={selectedOrderId}><option value="">General Support · no order attached</option>{orderOptions.map((order) => <option key={order.id} value={order.id}>{order.label}</option>)}</select></label>
          {selectedOrderId && <p className={styles.formHint}>This message will join the order’s active Support conversation. After that conversation is resolved, you can open a new case for a later issue.</p>}
          <label>Your message<textarea name="summary" maxLength={2000} rows={5} required placeholder="Tell us what you need help with…" /></label>
          <p className={styles.formHint}>Text only · Up to 2,000 characters · Don’t include passwords or payment details.</p>
          <button type="submit">Send to Support</button>
        </form>
      </section>
    </div>
  </div>;
}
