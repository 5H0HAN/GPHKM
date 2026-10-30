import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getStaffListingForEdit, listStaffSuppliers } from "@/server/catalog/admin";
import { editListingAction } from "../../actions";
import { ListingForm } from "../../listing-form";
import styles from "../../catalog.module.css";

export default async function EditListingPage({ params, searchParams }: {
  params: Promise<{ listingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ listingId }, query] = await Promise.all([params, searchParams]);
  const requestHeaders = await headers();
  let listing;
  let suppliers;
  try {
    [listing, suppliers] = await Promise.all([
      getStaffListingForEdit(requestHeaders, listingId), listStaffSuppliers(requestHeaders),
    ]);
  } catch {
    notFound();
  }
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>CATALOG / LISTING REVISION {listing.revision}</p><h1>Edit {listing.terms.title}</h1><p className={styles.lede}>Changes apply to future orders. Existing orders keep the terms and price captured at checkout.</p></div><Link className={styles.backLink} href="/staff/catalog">Back to listings</Link></header>
    {query.error && <p className={styles.error}>Changes were not saved. The listing may have changed; reload it and review the fields.</p>}
    <ListingForm listing={listing} suppliers={suppliers} action={editListingAction}>
      <button className={styles.button} type="submit">Save revision</button>
    </ListingForm>
  </>;
}
