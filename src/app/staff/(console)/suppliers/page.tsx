import { headers } from "next/headers";
import { listStaffSuppliersPage } from "@/server/catalog/admin";
import { AddSupplierDialog } from "./add-supplier-dialog";
import styles from "./suppliers.module.css";
import Link from "next/link";

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ created?: string; error?: string; page?: string | string[]; q?: string | string[]; status?: string | string[] }> }) {
  const [requestHeaders, query] = await Promise.all([headers(), searchParams]);
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const search = (first(query.q) ?? "").trim().slice(0, 120);
  const status = first(query.status) ?? "";
  const result = await listStaffSuppliersPage(requestHeaders, { page: first(query.page) ?? "1", query: search, status });
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (result.query) params.set("q", result.query);
    if (result.status) params.set("status", result.status);
    params.set("page", String(target));
    return `/staff/suppliers?${params.toString()}`;
  };
  const pageNumbers = Array.from({ length: result.totalPages }, (_, index) => index + 1)
    .filter((page) => page === 1 || page === result.totalPages || Math.abs(page - result.page) <= 1);
  const rangeStart = result.total ? result.offset + 1 : 0;
  const rangeEnd = Math.min(result.offset + result.limit, result.total);
  const supplierCount = `${result.total} supplier${result.total === 1 ? "" : "s"}`;
  return <>
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>Inventory sources</p>
        <h1>Suppliers</h1>
        <p className={styles.lede}>Manage private supplier contacts and bring their inventory into the catalog for review.</p>
      </div>
      <Link className={styles.importAction} href="/staff/suppliers/imports">Import inventory</Link>
    </header>
    <div className={styles.supplierToolbar}>
      <p>Supplier contact records stay private to staff. Import inventory after adding its source.</p>
      <AddSupplierDialog error={query.error} created={Boolean(query.created)} />
    </div>

    <section className={styles.directoryPanel} aria-labelledby="supplier-directory-heading">
        <div className={styles.directoryHeading}>
          <div><h2 id="supplier-directory-heading">Supplier directory</h2><p>Search by supplier, contact, email, or status. Open a record to review its inventory.</p></div>
          <span className={styles.count}>{supplierCount}</span>
        </div>

        <form action="/staff/suppliers" method="get" className={styles.filters} role="search" aria-label="Search suppliers">
          <label className={styles.searchField}>
            <span>Search suppliers</span>
            <input type="search" name="q" defaultValue={search} maxLength={120} placeholder="Name, contact, email, or status" />
          </label>
          <label className={styles.statusField}>
            <span>Status</span>
            <select name="status" defaultValue={result.status}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </label>
          <button className={styles.filterAction} type="submit">Search</button>
          {(result.query || result.status) && <Link className={styles.clearAction} href="/staff/suppliers">Clear</Link>}
        </form>

        {result.total > 0 && <div className={styles.resultSummary} aria-live="polite">
          Showing <strong>{rangeStart}–{rangeEnd}</strong> of <strong>{result.total}</strong> suppliers
        </div>}

        {result.items.length === 0 ? <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true">{result.query || result.status ? "⌕" : "＋"}</span>
          <h3>{result.query || result.status ? "No matching suppliers" : "No suppliers added yet"}</h3>
          <p>{result.query || result.status ? "Try a different name, contact, email, or status filter." : "Use Add supplier above to create a private contact record, then import its inventory."}</p>
          {result.query || result.status
            ? <Link href="/staff/suppliers">Clear search and filters</Link>
            : null}
        </div> : <>
          {result.totalPages > 1 && <nav className={styles.pagination} aria-label="Supplier directory pages">
            <span>Page {result.page} of {result.totalPages}</span>
            <div className={styles.pageControls}>
              {result.page > 1
                ? <Link href={pageHref(result.page - 1)} rel="prev" aria-label="Previous page">Previous</Link>
                : <span className={styles.disabledPage}>Previous</span>}
              {pageNumbers.map((page, index) => <span className={styles.pageSlot} key={page}>
                {index > 0 && pageNumbers[index - 1] !== page - 1 && <span className={styles.ellipsis} aria-hidden="true">…</span>}
                {page === result.page
                  ? <span className={styles.currentPage} aria-current="page" aria-label={`Page ${page}`}>{page}</span>
                  : <Link href={pageHref(page)} aria-label={`Go to page ${page}`}>{page}</Link>}
              </span>)}
              {result.page < result.totalPages
                ? <Link href={pageHref(result.page + 1)} rel="next" aria-label="Next page">Next</Link>
                : <span className={styles.disabledPage}>Next</span>}
            </div>
          </nav>}
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th scope="col">Supplier</th><th scope="col">Primary contact</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col"><span className={styles.srOnly}>Profile</span></th></tr></thead>
              <tbody>
                {result.items.map((item) => <tr key={item.id}>
                  <td data-label="Supplier"><strong>{item.name}</strong></td>
                  <td data-label="Primary contact">{item.contactName ?? "—"}</td>
                  <td data-label="Email">{item.email ?? "—"}</td>
                  <td data-label="Status"><span className={styles.status}>{item.status}</span></td>
                  <td data-label=""><Link className={styles.profileAction} href={`/staff/suppliers/${item.id}`}>Open supplier</Link></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {result.totalPages > 1 && <nav className={`${styles.pagination} ${styles.bottomPagination}`} aria-label="Supplier directory pages">
            <span>Showing {rangeStart}–{rangeEnd} of {result.total}</span>
            <div className={styles.pageControls}>
              {result.page > 1 ? <Link href={pageHref(result.page - 1)} rel="prev">Previous</Link> : <span className={styles.disabledPage}>Previous</span>}
              {result.page < result.totalPages ? <Link href={pageHref(result.page + 1)} rel="next">Next</Link> : <span className={styles.disabledPage}>Next</span>}
            </div>
          </nav>}
        </>}
      </section>
  </>;
}
