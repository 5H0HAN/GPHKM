import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireStaffAccess } from "@/server/auth/staff";
import { listStaffCustomers } from "@/server/identity/staff-customer-directory";
import styles from "./customers.module.css";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function customerHref(customerId: string) {
  return `/staff/customers/${encodeURIComponent(customerId)}`;
}

export default async function CustomersPage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[]; state?: string | string[]; page?: string | string[] }>;
}) {
  const query = await searchParams;
  const requestHeaders = await headers();
  try { await requireStaffAccess(requestHeaders, "customer.directory.read"); }
  catch { notFound(); }
  const result = await listStaffCustomers(requestHeaders, first(query.page), first(query.q), first(query.state));
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (result.search) params.set("q", result.search);
    if (result.state !== "ALL") params.set("state", result.state);
    params.set("page", String(page));
    return `/staff/customers?${params.toString()}`;
  };

  return <>
    <header className={styles.header}>
      <div><h1>Customers</h1><p>Find a customer and manage account access, organization membership, orders, and support follow-up.</p></div>
      <span className={styles.count}>{result.pagination.total.toLocaleString()} customers</span>
    </header>
    <p className={styles.boundaryNote}>Admin and Super Admin only. Account access changes revoke sessions and are audited. Customer profile details and credentials remain customer-managed.</p>
    <form className={styles.filters} action="/staff/customers" method="get">
      <label className={styles.searchField}>Search customers
        <input type="search" name="q" maxLength={100} defaultValue={result.search} placeholder="Name, email, or organization" />
      </label>
      <label>Status
        <select name="state" defaultValue={result.state}>
          <option value="ALL">All accounts</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
        </select>
      </label>
      <button type="submit">Search</button>
    </form>
    {result.search && <p className={styles.resultText}>Showing matches for <strong>{result.search}</strong></p>}
    {result.pagination.truncated && <p className={styles.resultText} role="status">
      Pagination is limited to the newest 100,000 matches. Refine your search to reach older customers.
    </p>}
    {result.rows.length ? <>
      <div className={styles.list} role="table" aria-label="Customers">
        <div className={styles.listHeader} role="row">
          <span role="columnheader">Customer</span><span role="columnheader">Account</span><span role="columnheader">Organizations</span>
          <span role="columnheader">Orders</span><span role="columnheader">Open support</span><span role="columnheader">Joined</span><span role="columnheader">Actions</span>
        </div>
        {result.rows.map((row) => <article className={styles.customerRow} role="row" key={row.customer_id}>
          <div className={styles.identity} role="cell" data-label="Customer">
            <span className={styles.cellLabel}>Customer</span>
            <Link href={customerHref(row.customer_id)}><strong>{row.customer_name || "Name not provided"}</strong></Link>
            <span>{row.customer_email}{row.email_verified ? " · verified" : " · unverified"}</span>
          </div>
          <div role="cell" data-label="Account"><span className={styles.cellLabel}>Account</span><span className={row.account_state === "SUSPENDED" ? styles.suspended : styles.active}>{row.account_state === "SUSPENDED" ? "Suspended" : "Active"}</span></div>
          <div role="cell" data-label="Organizations"><span className={styles.cellLabel}>Organizations</span>{row.active_organization_count} active · {row.organization_count} total</div>
          <div role="cell" data-label="Orders"><span className={styles.cellLabel}>Orders</span>{row.paid_order_count}</div>
          <div role="cell" data-label="Open support"><span className={styles.cellLabel}>Open support</span>{row.open_support_count}</div>
          <div role="cell" data-label="Joined"><span className={styles.cellLabel}>Joined</span>{new Date(row.joined_at).toLocaleDateString()}</div>
          <div role="cell" data-label="Actions"><span className={styles.cellLabel}>Actions</span><Link className={styles.manageLink} href={customerHref(row.customer_id)} aria-label={`Manage customer ${row.customer_name || "record"}`}>Manage</Link></div>
        </article>)}
      </div>
      <nav className={styles.pagination} aria-label="Customer pages">
        {result.pagination.page > 1 ? <Link href={pageHref(result.pagination.page - 1)}>Previous</Link> : <span />}
        <span>Page {result.pagination.page} of {result.pagination.totalPages}{result.pagination.truncated ? " available" : ""}</span>
        {result.pagination.page < result.pagination.totalPages ? <Link href={pageHref(result.pagination.page + 1)}>Next</Link> : <span />}
      </nav>
    </> : <section className={styles.empty}>
      <h2>{result.search || result.state !== "ALL" ? "No customers match these filters" : "No customer accounts yet"}</h2>
      <p>{result.search || result.state !== "ALL" ? "Try another name, email, organization, or account status." : "Customer records appear here when an account joins an organization."}</p>
      {(result.search || result.state !== "ALL") && <Link href="/staff/customers">Clear search and filters</Link>}
    </section>}
  </>;
}
