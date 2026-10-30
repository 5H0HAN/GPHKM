import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSuppliers } from "@/server/catalog/admin";
import { createListingAction } from "../actions";
import { ListingForm } from "../listing-form";
import styles from "../catalog.module.css";

export default async function NewListingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [suppliers, query] = await Promise.all([listStaffSuppliers(await headers()), searchParams]);
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>CATALOG / NEW LISTING</p><h1>Create a draft</h1><p className={styles.lede}>New listings stay private until reviewed and explicitly published.</p></div><Link className={styles.backLink} href="/staff/catalog">Back to listings</Link></header>
    {query.error && <p className={styles.error}>Listing not created. Check the required fields and supplier selection.</p>}
    <ListingForm suppliers={suppliers} action={createListingAction}><button className={styles.button} type="submit">Save draft listing</button></ListingForm>
  </>;
}
