import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaffSupplierProfile } from "@/server/catalog/admin";
import { saveSupplierContactAction, updateSupplierProfileAction } from "../actions";
import styles from "../../catalog/catalog.module.css";
import pageStyles from "./supplier-profile.module.css";

function metric(value: string | number | null | undefined) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");
}

export default async function SupplierProfilePage({ params, searchParams }: {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<{ saved?: string; error?: string; contactsPage?: string | string[]; inventoryPage?: string | string[] }>;
}) {
  const [{ supplierId }, query] = await Promise.all([params, searchParams]);
  let profile;
  const firstPage = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  try { profile = await getStaffSupplierProfile(await headers(), supplierId, {
    contacts: firstPage(query.contactsPage), inventory: firstPage(query.inventoryPage),
  }); }
  catch { notFound(); }
  const performance = profile.performance;
  const sample = Number(performance.on_time_sample_size ?? 0);
  const onTime = Number(performance.on_time_count ?? 0);
  const paginationHref = (key: "contactsPage" | "inventoryPage", page: number) => {
    const contactsPage = key === "contactsPage" ? page : profile.contactPagination.page;
    const inventoryPage = key === "inventoryPage" ? page : profile.inventoryPagination.page;
    return `/staff/suppliers/${encodeURIComponent(profile.supplier.id)}?contactsPage=${contactsPage}&inventoryPage=${inventoryPage}`;
  };
  return <>
    <header className={styles.header}>
      <div><Link className={styles.backLink} href="/staff/suppliers">← Suppliers</Link><p className={styles.eyebrow}>PRIVATE SUPPLIER PROFILE</p>
        <h1>{profile.supplier.name}</h1><p className={styles.lede}>Contact records, associated listings, and operational measures for the trailing 90 days.</p></div>
      <span className={styles.status}>{profile.supplier.status}</span>
    </header>
    {query.saved && <p className={styles.success}>Changes saved.</p>}
    {query.error && <p className={styles.error}>Could not save these changes. Check the fields and your staff access.</p>}
    <section className={styles.formPanel}>
      <h2>Supplier details</h2>
      <form action={updateSupplierProfileAction} className={styles.listingForm}>
        <input type="hidden" name="supplierId" value={profile.supplier.id} />
        <div className={styles.formGrid}>
          <label>Supplier name<input name="name" required maxLength={160} defaultValue={profile.supplier.name} /></label>
          <label>Status<select name="status" defaultValue={profile.supplier.status}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
        </div>
        <p className={styles.hint}>Changing supplier status does not automatically pause or reprice linked listings.</p>
        <label>Internal notes<textarea name="notes" rows={4} maxLength={4000} defaultValue={profile.supplier.notes ?? ""} /></label>
        <button className={styles.button} type="submit">Save supplier</button>
      </form>
    </section>
    <section className={styles.formPanel}>
      <h2>Contacts</h2>
      <p className={styles.hint}>Changing a contact does not alter a recipient already frozen in a supplier packet.</p>
      <nav className={styles.pagination} aria-label="Supplier contact pages">
        {profile.contactPagination.page > 1 ? <Link href={paginationHref("contactsPage", profile.contactPagination.page - 1)}>Previous page</Link> : <span />}
        <span>Page {profile.contactPagination.page} of {profile.contactPagination.totalPages} · {profile.contactPagination.total} contacts</span>
        {profile.contactPagination.page < profile.contactPagination.totalPages ? <Link href={paginationHref("contactsPage", profile.contactPagination.page + 1)}>Next page</Link> : <span />}
      </nav>
      {profile.contacts.map((contact) => <form action={saveSupplierContactAction} className={pageStyles.contactForm} key={contact.id}>
        <input type="hidden" name="supplierId" value={profile.supplier.id} /><input type="hidden" name="contactId" value={contact.id} />
        <label>Name<input name="name" required maxLength={160} defaultValue={contact.name} /></label>
        <label>Email<input name="email" type="email" required maxLength={320} defaultValue={contact.email} /></label>
        <label>Role / department<input name="roleLabel" maxLength={120} defaultValue={contact.roleLabel ?? ""} /></label>
        {contact.isPrimary ? <label className={pageStyles.checkbox}><input name="isPrimary" type="hidden" value="on" /><span>Primary contact · required</span></label>
          : <label className={pageStyles.checkbox}><input name="isPrimary" type="checkbox" /> Make primary contact</label>}
        <button className={styles.button} type="submit">Save contact</button>
      </form>)}
      <form action={saveSupplierContactAction} className={pageStyles.contactForm}>
        <input type="hidden" name="supplierId" value={profile.supplier.id} />
        <label>Name<input name="name" required maxLength={160} /></label>
        <label>Email<input name="email" type="email" required maxLength={320} /></label>
        <label>Role / department<input name="roleLabel" maxLength={120} /></label>
        <label className={pageStyles.checkbox}><input name="isPrimary" type="checkbox" /> Primary contact</label>
        <button className={styles.button} type="submit">Add contact</button>
      </form>
    </section>
    <section className={styles.formPanel}>
      <h2>Operational performance <span className={pageStyles.window}>Trailing 90 days</span></h2>
      <p className={styles.hint}>Internal measures only. Sample sizes are shown; no weighted ranking is calculated.</p>
      <dl className={pageStyles.metrics}>
        <div><dt>Paid placements</dt><dd>{metric(performance.paid_placements)}</dd></div>
        <div><dt>Completed</dt><dd>{metric(performance.completed)}</dd></div>
        <div><dt>Recorded supplier failures</dt><dd>{metric(performance.rejected)}</dd></div>
        <div><dt>Cancelled</dt><dd>{metric(performance.canceled)}</dd></div>
        <div><dt>Refunded</dt><dd>{metric(performance.refunded)}</dd></div>
        <div><dt>Median publication time</dt><dd>{performance.median_publication_hours == null ? "—" : `${(Number(performance.median_publication_hours) / 24).toFixed(1)} days`}</dd></div>
        <div><dt>On time</dt><dd>{sample ? `${Math.round(onTime / sample * 100)}% (n=${sample})` : "— (n=0)"}</dd></div>
      </dl>
    </section>
    <section className={styles.formPanel}>
      <h2>Associated inventory <span className={pageStyles.window}>{profile.inventoryPagination.total} listings</span></h2>
      <nav className={styles.pagination} aria-label="Supplier inventory pages">
        {profile.inventoryPagination.page > 1 ? <Link href={paginationHref("inventoryPage", profile.inventoryPagination.page - 1)}>Previous page</Link> : <span />}
        <span>Page {profile.inventoryPagination.page} of {profile.inventoryPagination.totalPages}</span>
        {profile.inventoryPagination.page < profile.inventoryPagination.totalPages ? <Link href={paginationHref("inventoryPage", profile.inventoryPagination.page + 1)}>Next page</Link> : <span />}
      </nav>
      {profile.inventory.length === 0 ? <p className={styles.hint}>No listings are currently linked to this supplier.</p> : <div className={styles.tableWrap}>
        <table><thead><tr><th>Listing</th><th>Website</th><th>Relationship</th><th>Status</th><th>Retail price</th></tr></thead><tbody>
          {profile.inventory.map((item) => <tr key={item.id}><td><Link href={`/staff/catalog/${item.id}/edit`}>{item.title}</Link><small className={pageStyles.subline}>{item.categories.join(", ")}</small></td>
            <td>{item.websiteUrl ?? "—"}</td><td>{item.commercialSource.replaceAll("_", " ")}</td><td>{item.status}</td><td>${(Number(item.retailPriceCents) / 100).toFixed(2)}</td></tr>)}
        </tbody></table>
      </div>}
    </section>
  </>;
}
