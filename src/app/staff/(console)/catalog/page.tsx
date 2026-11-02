import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { listStaffListings } from "@/server/catalog/admin";
import { LISTING_STATUSES, type ListingStatus } from "@/modules/catalog/domain";
import { transitionListingAction } from "./actions";
import { ListingStatusActionForm, ListingStatusFeedback } from "./listing-status-action-form";
import styles from "./catalog.module.css";

const actionsByStatus: Record<ListingStatus, ListingStatus[]> = {
  DRAFT: ["REVIEW", "ARCHIVED"],
  REVIEW: ["LIVE", "DRAFT", "ARCHIVED"],
  LIVE: ["PAUSED", "ARCHIVED"],
  PAUSED: ["LIVE", "ARCHIVED"],
  ARCHIVED: ["DRAFT"],
};

function actionLabel(status: ListingStatus, currentStatus: ListingStatus) {
  if (currentStatus === "ARCHIVED" && status === "DRAFT") return "Unarchive";
  if (currentStatus === "PAUSED" && status === "LIVE") return "Resume";
  return status === "LIVE" ? "Publish"
    : status === "REVIEW" ? "Send to review"
      : status === "PAUSED" ? "Pause"
        : status === "DRAFT" ? "Return to draft" : "Archive";
}

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ created?: string; updated?: string; error?: string; listing?: string; page?: string | string[]; q?: string | string[]; status?: string | string[]; source?: string | string[] }> }) {
  const [requestHeaders, params] = await Promise.all([headers(), searchParams]);
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const search = (first(params.q) ?? "").trim().slice(0, 120);
  const requestedStatus = first(params.status) ?? "";
  const status = LISTING_STATUSES.includes(requestedStatus as ListingStatus) ? requestedStatus as ListingStatus : "";
  const requestedSource = first(params.source) ?? "";
  const source = requestedSource === "PLATFORM_OWNED" || requestedSource === "SUPPLIER_SOURCED" ? requestedSource : "";
  let result;
  try {
    result = await listStaffListings(requestHeaders, first(params.page) ?? "1", { query: search, status, source });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/staff/sign-in");
    if (error instanceof Error && error.message === "Forbidden") redirect("/staff");
    throw error;
  }
  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (search) query.set("q", search);
    if (status) query.set("status", status);
    if (source) query.set("source", source);
    query.set("page", String(target));
    return `/staff/catalog?${query.toString()}`;
  };
  const errorMessage = params.error === "publish-requirements" ? "This listing still needs publication requirements reviewed. Open its editor, correct the missing details, then publish again."
    : params.error === "invalid-transition" ? "The listing status changed before this action completed. Reload the catalog and try again."
      : params.error === "listing-incomplete" ? "This listing is missing its website or sourcing record. Open the listing editor to review it."
        : params.error === "listing-unavailable" ? "This listing is no longer available. Reload the catalog."
          : params.error === "invalid-request" ? "The status request was invalid. Reload the catalog and try again."
            : "The listing status could not be changed. Reload and try again.";
  const failedListingId = params.listing && /^[0-9a-f-]{36}$/i.test(params.listing) ? params.listing : null;
  const rangeStart = result.total ? result.offset + 1 : 0;
  const rangeEnd = Math.min(result.offset + result.limit, result.total);
  const hasFilters = Boolean(result.query || result.status || result.source);
  return <>
    <header className={styles.catalogHeader}>
      <div><h1>Listings</h1><p>Manage website offers, pricing, and private sourcing details.</p></div>
      <Link className={styles.createButton} href="/staff/catalog/new">Create listing</Link>
    </header>
    {params.created && <p role="status" className={styles.success}>Draft listing created.</p>}
    {params.updated && <p role="status" className={styles.success}>Listing updated.</p>}
    {params.error && <p role="alert" className={styles.error}>{errorMessage}{failedListingId && params.error !== "listing-unavailable" && <> <Link href={`/staff/catalog/${failedListingId}/edit`}>Open this listing</Link>.</>}</p>}
    <section className={styles.filterPanel} aria-labelledby="catalog-filter-heading">
      <div className={styles.filterIntro}>
        <h2 id="catalog-filter-heading">Find listings</h2>
        <p>Search by title, website, category, or supplier name.</p>
      </div>
      <form action="/staff/catalog" method="get" className={styles.catalogFilters} role="search" aria-label="Search catalog listings">
        <label className={styles.searchField}><span>Search</span><input type="search" name="q" defaultValue={result.query} maxLength={120} placeholder="Title, website, category, or supplier" /></label>
        <label className={styles.filterField}><span>Status</span><select name="status" defaultValue={result.status}><option value="">All statuses</option>{LISTING_STATUSES.map((value) => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        <label className={styles.filterField}><span>Source</span><select name="source" defaultValue={result.source}><option value="">All sources</option><option value="SUPPLIER_SOURCED">Supplier sourced</option><option value="PLATFORM_OWNED">Platform owned</option></select></label>
        <div className={styles.filterActions}><button className={styles.filterButton} type="submit">Apply filters</button>{hasFilters && <Link className={styles.clearFilters} href="/staff/catalog">Clear</Link>}</div>
      </form>
    </section>
    <section className={styles.catalogResults} aria-label="Catalog results">
      <ListingStatusFeedback action={transitionListingAction}>
      <div className={styles.resultsBar}>
        <p className={styles.resultSummary} aria-live="polite">Showing <strong>{rangeStart}–{rangeEnd}</strong> of <strong>{result.total}</strong> listings</p>
        {result.totalPages > 1 && <nav className={styles.catalogPagination} aria-label="Catalog pages">
          {result.page > 1 && <Link href={pageHref(result.page - 1)}>Previous</Link>}
          <span className={styles.currentPage}>Page {result.page} of {result.totalPages}</span>
          {result.page < result.totalPages && <Link href={pageHref(result.page + 1)}>Next</Link>}
        </nav>}
      </div>
      {result.items.length === 0 ? <section className={styles.empty}><strong>{hasFilters ? "No matching listings" : "No listings yet"}</strong><p>{hasFilters ? "Try another title, website, category, supplier, or filter." : "Create a draft listing to start building your catalog."}</p>{hasFilters && <Link href="/staff/catalog">Clear search and filters</Link>}</section> : <div className={styles.catalogTableWrap}>
        <table className={styles.catalogTable}>
          <caption className={styles.visuallyHidden}>Catalog listings and staff actions</caption>
          <thead><tr><th scope="col">Website</th><th scope="col">Categories</th><th scope="col">Source</th><th scope="col">Retail price</th><th scope="col">Status and actions</th></tr></thead>
          <tbody>{result.items.map((item) => <tr key={item.id}>
            <td data-label="Website" className={styles.websiteCell}>
              <span className={styles.cellLabel} aria-hidden="true">Website</span>
              <strong>{item.title}</strong>
              {item.websiteUrl ? <a className={styles.websiteLink} href={item.websiteUrl} target="_blank" rel="noopener noreferrer">{item.websiteUrl}</a> : <span className={styles.missingUrl}>Website URL not recorded</span>}
              {item.status !== "ARCHIVED" && <Link className={styles.editLink} href={`/staff/catalog/${item.id}/edit`}>Edit listing <span>· revision {item.revision}</span></Link>}
            </td>
            <td data-label="Categories" className={styles.categoryCell}><span className={styles.cellLabel} aria-hidden="true">Categories</span>{item.categories.length ? item.categories.join(", ") : "No categories"}</td>
            <td data-label="Source" className={styles.sourceCell}>
              <span className={styles.cellLabel} aria-hidden="true">Source</span>
              <span className={styles.sourceType}>{item.commercialSource?.replaceAll("_", " ") ?? "Not set"}</span>
              {item.commercialSource === "SUPPLIER_SOURCED" && <small className={styles.supplierDetail}><span>Supplier</span><strong>{item.supplierName ?? "Not assigned"}</strong></small>}
            </td>
            <td data-label="Retail price" className={styles.priceCell}><span className={styles.cellLabel} aria-hidden="true">Retail price</span><span>${(Number(item.retailPriceCents) / 100).toFixed(2)}</span></td>
            <td data-label="Status and actions" className={styles.statusCell}>
              <span className={styles.cellLabel} aria-hidden="true">Status and actions</span>
              <span className={styles.listingStatus}>{item.status.replaceAll("_", " ")}</span>
              <div className={styles.catalogActions}>
                {actionsByStatus[item.status].map((nextStatus) => <ListingStatusActionForm
                  key={nextStatus}
                  listingId={item.id}
                  listingTitle={item.title}
                  nextStatus={nextStatus}
                  label={actionLabel(nextStatus, item.status)}
                  primary={nextStatus === "LIVE" || nextStatus === "REVIEW"}
                />)}
              </div>
            </td>
          </tr>)}</tbody>
        </table>
      </div>}
      </ListingStatusFeedback>
    </section>
  </>;
}
