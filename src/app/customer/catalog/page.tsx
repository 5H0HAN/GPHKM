import Link from "next/link";
import { headers } from "next/headers";
import { loadCustomerWorkspace, selectedOrganizationId } from "../workspace";
import { listCustomerListings } from "@/server/catalog/customer";
import { LISTING_CATEGORY_NAMES, LISTING_LANGUAGES } from "@/modules/catalog/taxonomy";
import { firstQueryValue } from "@/modules/query-params";
import { CatalogBrowser, CatalogFilters, CatalogPagination } from "../catalog-browser";
import styles from "../customer.module.css";

export const dynamic = "force-dynamic";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[]; q?: string | string[]; category?: string | string[]; country?: string | string[]; language?: string | string[]; doFollowOnly?: string | string[]; page?: string | string[] }> }) {
  const workspace = await loadCustomerWorkspace();
  if (!workspace.authenticated) return null;
  const params = await searchParams;
  const organizationId = selectedOrganizationId(workspace.organizations, firstQueryValue(params.organizationId));
  if (!organizationId) return <div className={styles.error}>A customer organization is required before the marketplace can be opened.</div>;
  const search = firstQueryValue(params.q);
  const category = firstQueryValue(params.category);
  const country = firstQueryValue(params.country)?.slice(0, 3);
  const language = firstQueryValue(params.language)?.slice(0, 40);
  const doFollowOnly = firstQueryValue(params.doFollowOnly) === "1";
  const requestedPage = Number(firstQueryValue(params.page));
  const filters = { search: search?.slice(0, 100), category, country, language, doFollowOnly,
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 10_000) : 1 };
  let result: Awaited<ReturnType<typeof listCustomerListings>>;
  try { result = await listCustomerListings(await headers(), organizationId, filters); }
  catch { return <div className={styles.error}>Marketplace access could not be checked. Refresh or contact support if this continues.</div>; }

  return (
    <>
      <div className={styles.headingRow}>
        <div>
          <h1 className={styles.title}>Marketplace</h1>
          <p className={styles.subtitle}>Compare placement requirements, select up to 25 websites, and prepare one order.</p>
        </div>
      </div>
      {!result.accessAllowed ? (
        <section className={styles.marketplaceGate} aria-labelledby="marketplace-access-ended">
          <div className={styles.lockedMarketplacePreview} aria-hidden="true">
            <div className={styles.lockedPreviewToolbar}><span /><span /><span /></div>
            <div className={styles.lockedPreviewGrid}>
              {Array.from({ length: 6 }, (_, index) => (
                <div className={styles.lockedPreviewCard} key={index}>
                  <span className={styles.lockedPreviewTitle} />
                  <span className={styles.lockedPreviewLine} />
                  <span className={styles.lockedPreviewLineShort} />
                  <span className={styles.lockedPreviewMeta} />
                </div>
              ))}
            </div>
          </div>
          <div className={styles.marketplaceGateOverlay}>
            <div className={styles.marketplaceGateMessage}>
              <h2 id="marketplace-access-ended" className={styles.panelTitle}>Marketplace access has ended</h2>
              <p className={styles.panelText}>Load the required minimum wallet amount to restore browsing and reveal eligible website addresses. Your current orders and account remain available.</p>
              <Link className={styles.panelAction} href={`/customer/wallet?organizationId=${encodeURIComponent(organizationId)}`}>Go to wallet</Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          <CatalogFilters organizationId={organizationId} search={filters.search ?? ""} category={filters.category ?? ""} country={filters.country ?? ""} language={filters.language ?? ""} doFollowOnly={filters.doFollowOnly} categories={LISTING_CATEGORY_NAMES} languages={LISTING_LANGUAGES} />
          <CatalogPagination organizationId={organizationId} search={filters.search ?? ""} category={filters.category ?? ""} country={filters.country ?? ""} language={filters.language ?? ""} doFollowOnly={filters.doFollowOnly} page={result.pagination.page} pageCount={result.pagination.pageCount} total={result.pagination.total} />
          <section className={styles.panel} hidden={result.listings.length > 0}>
            <h2 className={styles.panelTitle}>{filters.search || filters.category || filters.country || filters.language || filters.doFollowOnly ? "No listings match these filters" : "No listings are available yet"}</h2>
            <p className={styles.panelText}>{filters.search || filters.category || filters.country || filters.language || filters.doFollowOnly ? "Clear a filter or try another search." : "Reviewed website offers will appear here when staff publishes them."}</p>
          </section>
          <CatalogBrowser key={organizationId} organizationId={organizationId} listings={result.listings} />
        </>
      )}
    </>
  );
}
