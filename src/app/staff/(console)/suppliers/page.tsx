import { headers } from "next/headers";
import { listStaffSuppliersPage } from "@/server/catalog/admin";
import { createSupplierAction } from "./actions";
import styles from "../catalog/catalog.module.css";
import Link from "next/link";

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ created?: string; error?: string; page?: string | string[] }> }) {
  const [requestHeaders, query] = await Promise.all([headers(), searchParams]);
  const requestedPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const result = await listStaffSuppliersPage(requestHeaders, requestedPage ?? "1");
  const pageHref = (target: number) => `/staff/suppliers?page=${target}`;
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>INVENTORY</p><h1>Suppliers</h1><p className={styles.lede}>Private contact records used for inventory and fulfillment.</p></div><Link className={styles.button} href="/staff/suppliers/imports">Import inventory</Link></header>
    {query.created && <p className={styles.success}>Supplier created.</p>}
    {query.error && <p className={styles.error}>Supplier could not be created. Check the contact details and your staff access.</p>}
    <section className={styles.formPanel}>
      <h2>Add supplier</h2>
      <form action={createSupplierAction} className={styles.supplierForm}>
        <label>Supplier name<input name="name" required maxLength={160} /></label>
        <label>Primary contact<input name="contactName" required maxLength={160} /></label>
        <label>Contact email<input name="email" type="email" required maxLength={320} /></label>
        <button className={styles.button} type="submit">Save supplier</button>
      </form>
    </section>
    {result.items.length === 0 ? <section className={styles.empty}><strong>No suppliers yet</strong><p>Supplier names and contact details remain private to authorized staff.</p></section> : <>
      <nav aria-label="Supplier pages">{result.page > 1 && <Link href={pageHref(result.page - 1)}>Previous page</Link>}{" "}<span>Page {result.page} of {result.totalPages} · {result.total} suppliers</span>{" "}{result.page < result.totalPages && <Link href={pageHref(result.page + 1)}>Next page</Link>}</nav>
      <div className={styles.tableWrap}>
        <table><thead><tr><th>Supplier</th><th>Primary contact</th><th>Email</th><th>Status</th></tr></thead><tbody>
          {result.items.map((item) => <tr key={item.id}><td><Link href={`/staff/suppliers/${item.id}`}><strong>{item.name}</strong></Link></td><td>{item.contactName ?? "—"}</td><td>{item.email ?? "—"}</td><td><span className={styles.status}>{item.status}</span></td></tr>)}
        </tbody></table>
      </div>
    </>}
  </>;
}
