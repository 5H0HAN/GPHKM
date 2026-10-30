import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSuppliers } from "@/server/catalog/admin";
import { createListingAction } from "../actions";
import { ListingForm } from "../listing-form";
import styles from "../catalog.module.css";
import { requireStaffAccess } from "@/server/auth/staff";
import { redirect } from "next/navigation";

export default async function NewListingPage({ searchParams }: { searchParams: Promise<{ error?: string; supplierId?: string; commercialSource?: string }> }) {
  const requestHeaders = await headers();
  try {
    await requireStaffAccess(requestHeaders, "catalog.manage");
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/staff/sign-in");
    if (error instanceof Error && error.message === "Forbidden") redirect("/staff");
    throw error;
  }
  const [suppliers, query] = await Promise.all([listStaffSuppliers(requestHeaders), searchParams]);
  const initialSupplierId = suppliers.some((supplier) => supplier.id === query.supplierId) ? query.supplierId : undefined;
  const initialCommercialSource = initialSupplierId && query.commercialSource === "SUPPLIER_SOURCED" ? "SUPPLIER_SOURCED" : undefined;
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>CATALOG / NEW LISTING</p><h1>Create a draft</h1><p className={styles.lede}>New listings stay private until reviewed and explicitly published.</p></div><Link className={styles.backLink} href="/staff/catalog">Back to listings</Link></header>
    {query.error === "invalid-options" && <p className={styles.error}>Listing not created. Choose a supported language, link type, and placement term, then select 1–7 valid categories.</p>}
    {query.error && query.error !== "invalid-options" && <p className={styles.error}>Listing not created. Check the required details and supplier selection, then try again.</p>}
    <ListingForm suppliers={suppliers} initialSupplierId={initialSupplierId} initialCommercialSource={initialCommercialSource} action={createListingAction}><button className={styles.button} type="submit">Save draft listing</button></ListingForm>
  </>;
}
