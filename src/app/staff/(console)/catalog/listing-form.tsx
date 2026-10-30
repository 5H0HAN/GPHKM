import type { ReactNode } from "react";
import { LISTING_CATEGORY_NAMES, LISTING_LANGUAGES, LISTING_LINK_TYPES, LISTING_LINK_VALIDITIES } from "@/modules/catalog/taxonomy";
import type { ListingTerms } from "@/modules/catalog/domain";
import type { listStaffSuppliers } from "@/server/catalog/admin";
import styles from "./catalog.module.css";

type SupplierRows = Awaited<ReturnType<typeof listStaffSuppliers>>;
type ListingEdit = { id: string; revision: number; terms: ListingTerms; sourcing: {
  commercialSource: "PLATFORM_OWNED" | "SUPPLIER_SOURCED"; supplierId: string | null;
  fulfillmentSupplierId: string | null; urlVisibleWithoutRecharge: boolean;
} };

const flags = [
  ["allowsSportsAndGaming", "Sports and gaming"], ["allowsPharmacy", "Pharmacy"],
  ["allowsCrypto", "Crypto"], ["allowsForeignLanguage", "Foreign language content"],
] as const;
const dollars = (cents: number | string | null) => cents === null ? "" : (Number(cents) / 100).toFixed(2);
const triState = (value: boolean | null) => value === true ? "yes" : value === false ? "no" : "unset";

export function ListingForm({ suppliers, listing, action, children }: {
  suppliers: SupplierRows; listing?: ListingEdit; action: (formData: FormData) => void | Promise<void>; children: ReactNode;
}) {
  const terms = listing?.terms;
  return <form action={action} className={styles.listingForm}>
    {listing && <><input type="hidden" name="id" value={listing.id} /><input type="hidden" name="expectedRevision" value={listing.revision} /></>}
    <fieldset><legend>Website and offer</legend>
      <label>Listing title<input name="title" required maxLength={120} defaultValue={terms?.title} /></label>
      <label>Website URL<input name="websiteUrl" type="url" placeholder="https://example.com/" required defaultValue={terms?.websiteUrl} /></label>
      <label>Description<textarea name="description" required maxLength={4000} rows={4} defaultValue={terms?.description} /></label>
      <div className={styles.formGrid}>
        <label>Retail price (USD)<input name="retailPrice" type="number" min="0.01" step="0.01" required defaultValue={dollars(terms?.retailPriceCents ?? null)} /></label>
        <label>Country code<input name="countryCode" defaultValue={terms?.countryCode ?? "US"} pattern="[A-Za-z]{2}" maxLength={2} required /></label>
        <label>Primary language<select name="primaryLanguage" defaultValue={terms?.primaryLanguage ?? "English"}>{LISTING_LANGUAGES.map((language) => <option key={language}>{language}</option>)}</select></label>
        <label>Turnaround (days)<input name="turnaroundDays" type="number" min="1" max="365" defaultValue={terms?.turnaroundDays ?? 30} required /></label>
        <label>Link type<select name="linkType" defaultValue={terms?.linkType ?? "DOFOLLOW"}>{LISTING_LINK_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
        <label>Placement term<select name="linkValidity" defaultValue={terms?.linkValidity ?? "PERMANENT"}>{LISTING_LINK_VALIDITIES.map((term) => <option key={term} value={term}>{term.replaceAll("_", " ")}</option>)}</select></label>
      </div>
      <label>Categories (choose 1–7; use Ctrl/Cmd to select several)<select name="categories" multiple required size={7} defaultValue={terms?.categories}>{LISTING_CATEGORY_NAMES.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
      <label>Buyer requirements<textarea name="buyerRequirements" maxLength={4000} rows={3} defaultValue={terms?.buyerRequirements ?? ""} /></label>
    </fieldset>
    <fieldset><legend>Placement requirements</legend>
      <div className={styles.formGrid}>{flags.map(([name, label]) => <label key={name}>{label}<select name={name} defaultValue={triState(terms?.[name] ?? null)}><option value="unset">Review required</option><option value="yes">Allowed</option><option value="no">Not allowed</option></select></label>)}
        <label>Sponsored marking<select name="sponsoredContentMarking" defaultValue={terms?.sponsoredContentMarking === false ? "no" : "yes"}><option value="yes">Required</option><option value="no">Not required</option></select></label>
      </div>
    </fieldset>
    <fieldset><legend>Internal sourcing</legend>
      <div className={styles.formGrid}>
        <label>Commercial source<select name="commercialSource" defaultValue={listing?.sourcing.commercialSource ?? "PLATFORM_OWNED"}><option value="PLATFORM_OWNED">Platform owned</option><option value="SUPPLIER_SOURCED">Supplier sourced</option></select></label>
        <label>Source supplier<select name="supplierId" defaultValue={listing?.sourcing.supplierId ?? ""}><option value="">Choose if supplier sourced</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
        <label>Fulfillment supplier (optional)<select name="fulfillmentSupplierId" defaultValue={listing?.sourcing.fulfillmentSupplierId ?? ""}><option value="">None</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
        <label>Show website URL during allowed browsing?<select name="urlVisibleWithoutRecharge" defaultValue={listing?.sourcing.urlVisibleWithoutRecharge ? "yes" : "no"}><option value="no">No, keep hidden</option><option value="yes">Yes</option></select></label>
      </div>
    </fieldset>
    <fieldset><legend>GPHKM Writing (optional)</legend>
      <label>Offer writing?<select name="writingEnabled" defaultValue={terms?.writingEnabled ? "yes" : "no"}><option value="no">No</option><option value="yes">Yes</option></select></label>
      <div className={styles.formGrid}>
        <label>Writing price (USD)<input name="writingPrice" type="number" min="0" step="0.01" defaultValue={dollars(terms?.writingPriceCents ?? null)} /></label>
        <label>Writing turnaround (days)<input name="writingTurnaroundDays" type="number" min="1" max="365" defaultValue={terms?.writingTurnaroundDays ?? ""} /></label>
        <label>First draft stage (USD)<input name="writingFirstDraft" type="number" min="0" step="0.01" defaultValue={dollars(terms?.writingFirstDraftCents ?? null)} /></label>
        <label>Final draft stage (USD)<input name="writingFinalDraft" type="number" min="0" step="0.01" defaultValue={dollars(terms?.writingFinalDraftCents ?? null)} /></label>
      </div>
      <p className={styles.hint}>When enabled, the two disclosed stage prices must add up to the writing price.</p>
    </fieldset>
    {listing && <label>Reason for this change<input name="reason" required minLength={5} maxLength={500} placeholder="For example, updated retail price after supplier review" /></label>}
    {children}
  </form>;
}
