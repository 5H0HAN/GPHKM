import Link from "next/link";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { listCustomerSupportCases } from "@/server/support/cases";
import { getMyOrders, getMyOrderItemForSupport } from "@/server/orders/checkout";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import { openSupportAction } from "./actions";
import styles from "@/components/support.module.css";
import { firstQueryValue } from "@/modules/query-params";

export const dynamic = "force-dynamic";
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
  const items = orders.flatMap((order) => order.items.map((item) => ({ id: item.id, label: `${String(item.listing.title ?? "Placement")} · Order ${order.id.slice(0, 8)}` })));
  if (selectedItem && !items.some((item) => item.id === selectedItem.id)) items.unshift(selectedItem);
  return <>
    <header className={styles.header}><div><h1>Support</h1><p>Ask about a placement and keep the conversation with its order. Your requests stay available when marketplace access expires.</p></div></header>
    {params.error && <p role="alert" className={styles.notice}>The request could not be saved. Check the message and selected placement, then try again.</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><h2>Your requests</h2>{!cases.items.length ? <p>No Support requests yet.</p> : <div className={styles.list}>{cases.items.map((item) => <Link className={styles.row} href={`/customer/support/${item.id}?organizationId=${encodeURIComponent(organizationId)}`} key={item.id}><strong>{item.summary}</strong><span>{item.status} · Updated {new Date(item.updatedAt).toLocaleDateString()}</span></Link>)}</div>}
        {cases.totalPages > 1 && <nav className={styles.pagination} aria-label="Support request pages">{cases.page > 1 ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page - 1}`}>Previous</Link> : <span /> }<span>Page {cases.page} of {cases.totalPages}</span>{cases.page < cases.totalPages ? <Link href={`/customer/support?organizationId=${encodeURIComponent(organizationId)}&page=${cases.page + 1}`}>Next</Link> : <span />}</nav>}
      </section>
      <section className={styles.panel}><h2>Open a request</h2>{!items.length ? <p>Open a request from a placed order. <Link href={`/customer/orders?organizationId=${encodeURIComponent(organizationId)}`}>View orders</Link></p> : <form action={openSupportAction} className={styles.form}>
        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <label>Placement<select name="orderItemId" defaultValue={items.some((item) => item.id === itemId) ? itemId : items[0].id} required>{items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>How can we help?<textarea name="summary" maxLength={2000} rows={6} required /></label><p>Text only, up to 2,000 characters. Include only details needed to review this placement.</p><button type="submit">Open request</button>
      </form>}</section>
    </div>
  </>;
}
