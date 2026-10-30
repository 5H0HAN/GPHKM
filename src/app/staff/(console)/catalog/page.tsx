import Link from "next/link";
import { headers } from "next/headers";
import { listStaffListings } from "@/server/catalog/admin";
import { transitionListingAction } from "./actions";
import styles from "./catalog.module.css";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ created?: string; updated?: string; error?: string; page?: string | string[] }> }) {
  const query = await searchParams;
  const requestedPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const result = await listStaffListings(await headers(), requestedPage);
  const pageHref = (target: number) => `/staff/catalog?page=${target}`;
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>CATALOG</p><h1>Listings</h1><p className={styles.lede}>Manage customer-facing website offers and their private sourcing records.</p></div>
      <Link className={styles.button} href="/staff/catalog/new">Create listing</Link>
    </header>
    {query.created && <p role="status" className={styles.success}>Draft listing created.</p>}
    {query.updated && <p role="status" className={styles.success}>Listing status updated.</p>}
    {query.error && <p role="alert" className={styles.error}>Listing action failed. Review the item state and publishing requirements.</p>}
    {result.items.length === 0 ? <section className={styles.empty}><strong>No listings yet</strong><p>Create a draft listing to start building your catalog.</p></section> : <>
      <nav aria-label="Catalog pages">{result.page > 1 && <Link href={pageHref(result.page - 1)}>Previous page</Link>}{" "}<span>Page {result.page} of {result.totalPages} · {result.total} listings</span>{" "}{result.page < result.totalPages && <Link href={pageHref(result.page + 1)}>Next page</Link>}</nav>
      <div className={styles.tableWrap}>
        <table><thead><tr><th>Website</th><th>Categories</th><th>Source</th><th>Retail price</th><th>Status</th></tr></thead>
          <tbody>{result.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong>{item.websiteUrl ? <a href={item.websiteUrl} target="_blank" rel="noopener noreferrer">{item.websiteUrl}</a> : <span className={styles.missingUrl}>Website URL not recorded</span>}{item.status !== "ARCHIVED" && <Link className={styles.editLink} href={`/staff/catalog/${item.id}/edit`}>Edit listing · revision {item.revision}</Link>}</td><td>{item.categories.join(", ")}</td><td>{item.commercialSource?.replaceAll("_", " ") ?? "—"}</td><td>${(Number(item.retailPriceCents) / 100).toFixed(2)}</td><td><span className={styles.status}>{item.status}</span><div className={styles.rowActions}>{(item.status === "DRAFT" ? ["REVIEW", "ARCHIVED"] : item.status === "REVIEW" ? ["LIVE", "DRAFT", "ARCHIVED"] : item.status === "LIVE" ? ["PAUSED", "ARCHIVED"] : item.status === "PAUSED" ? ["LIVE", "ARCHIVED"] : []).map((status) => <form action={transitionListingAction} key={status}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="status" value={status} /><button type="submit">{status === "LIVE" ? "Publish" : status === "REVIEW" ? "Send to review" : status === "PAUSED" ? "Pause" : status === "DRAFT" ? "Return to draft" : "Archive"}</button></form>)}</div></td></tr>)}</tbody>
        </table>
      </div>
    </>}
  </>;
}
