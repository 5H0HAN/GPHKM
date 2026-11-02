import Link from "next/link";
import { headers } from "next/headers";
import { listMetricRedistributionCandidates, listMetricRefreshCandidates } from "@/server/catalog/metrics";
import { isOpenPageRankConfigured } from "@/server/metrics/open-page-rank";
import { MetricApprovalForm, MetricRefreshForm } from "./metric-controls";
import styles from "./metrics.module.css";

type SearchParams = {
  page?: string | string[];
  approvalPage?: string | string[];
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function metricsHref(page: number, approvalPage: number) {
  const params = new URLSearchParams({ page: String(page), approvalPage: String(approvalPage) });
  return `/staff/metrics?${params.toString()}`;
}

function displayDate(value: Date | string | null | undefined) {
  const text = value instanceof Date
    ? Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null
    : typeof value === "string" ? value.slice(0, 10) : null;
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return "—";
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text ? text : "—";
}

export default async function MetricsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [requestHeaders, query] = await Promise.all([headers(), searchParams]);
  const refreshPage = first(query.page) ?? "1";
  const approvalPage = first(query.approvalPage) ?? "1";
  const refreshData = await listMetricRefreshCandidates(requestHeaders, refreshPage);
  const approvals = refreshData.canApprove
    ? await listMetricRedistributionCandidates(requestHeaders, Number(approvalPage))
    : null;
  const providerConfigured = isOpenPageRankConfigured();

  return <div className={styles.page}>
    <header className={styles.header}>
      <div>
        <h1>Domain metrics</h1>
        <p>Refresh catalog domain observations and manage the internal rights review for customer redistribution.</p>
      </div>
      <p className={styles.accessScope}>Refresh: Admin and Super Admin<br />Rights review: Super Admin only</p>
    </header>

    <nav className={styles.sectionNav} aria-label="Domain metrics sections">
      <a href="#refresh">Refresh data</a>
      {approvals && <a href="#review">Customer redistribution review</a>}
    </nav>

    <aside className={styles.gateNotice} aria-labelledby="l05-heading">
      <strong id="l05-heading">Customer display remains disabled</strong>
      <p>Recording an internal attestation does not establish provider licensing or redistribution rights. L-05 must be completed separately before any metric can appear in the customer catalog.</p>
    </aside>

    <section className={styles.section} id="refresh" aria-labelledby="refresh-heading">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="refresh-heading">Refresh Open PageRank</h2>
          <p>Choose up to 100 listings. Only each selected hostname is sent to the provider; URL paths and customer data are not included.</p>
        </div>
        <p className={styles.limitNote}>5 batches per staff account in 24 hours</p>
      </div>

      {!providerConfigured && <p role="status" className={styles.error}>Refresh is unavailable because the server provider key is not configured. The key is never shown in this page.</p>}

      {refreshData.items.length === 0 ? <p className={styles.empty}>No catalog listings are available to refresh.</p> :
        <MetricRefreshForm page={refreshData.page} canRefresh={providerConfigured && refreshData.items.some((item) => item.refreshable)}>
          <div className={styles.refreshTableWrap}>
            <table className={styles.refreshTable}>
              <thead><tr><th scope="col">Select</th><th scope="col">Listing and domain</th><th scope="col">Listing state</th><th scope="col">Latest PageRank</th><th scope="col">Observed</th></tr></thead>
              <tbody>{refreshData.items.map((item) => {
                const metricValue = item.metric?.status === "AVAILABLE" ? item.metric.value : null;
                const metricDescription = !item.refreshable && item.metric?.status === "STALE"
                  ? "Stored value hidden · non-public hostname"
                  : item.metric?.status === "AVAILABLE"
                  ? `${metricValue ?? "—"} · ${item.metric.metricScope.toLowerCase().replaceAll("_", " ")}`
                  : item.metric?.status === "STALE" ? "Stale · refresh needed" : item.metric?.status ?? "Not refreshed";
                return <tr key={item.id}>
                  <td data-label="Select">
                    <label className={styles.selectControl}>
                      <input type="checkbox" name="listingId" value={item.id} aria-label={`Refresh ${item.title}`}
                        aria-describedby={!item.refreshable ? `refresh-availability-${item.id}` : undefined}
                        disabled={!item.refreshable} />
                    </label>
                  </td>
                  <td data-label="Listing and domain">
                    <strong>{item.title}</strong>
                    <code>{item.hostname ?? "Unsupported website URL"}</code>
                  </td>
                  <td data-label="Listing state">
                    <span className={styles.stateTag}>{item.status}</span>
                    {!item.refreshable && <span className={styles.secondaryText} id={`refresh-availability-${item.id}`}>
                      {item.hostname ? "Reserved or local-only hostname · not sent" : "Unsupported website URL · not sent"}
                    </span>}
                  </td>
                  <td data-label="Latest PageRank">{metricDescription}</td>
                  <td data-label="Observed">{displayDate(item.metric?.observedOn)}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {refreshData.totalPages > 1 && <nav className={styles.pagination} aria-label="Metric refresh pages">
            {refreshData.page > 1 && <Link href={metricsHref(refreshData.page - 1, approvals?.page ?? 1)}>Previous listings</Link>}
            <span>Page {refreshData.page} of {refreshData.totalPages} · {refreshData.total} listings</span>
            {refreshData.page < refreshData.totalPages && <Link href={metricsHref(refreshData.page + 1, approvals?.page ?? 1)}>Next listings</Link>}
          </nav>}
        </MetricRefreshForm>}
    </section>

    {approvals && <section className={styles.section} id="review" aria-labelledby="review-heading">
      <div className={styles.sectionHeading}>
        <div>
          <h2 id="review-heading">Customer redistribution review</h2>
          <p>Review applies only to the latest observation for the listing’s current hostname. A newer refresh must be reviewed again.</p>
        </div>
        <p className={styles.limitNote}>Internal attestation · Super Admin</p>
      </div>

      {approvals.total === 0 ? <p className={styles.empty}>No current metric observations are eligible for review. Refresh an available public listing first.</p> : <>
        <p className={styles.resultCount}>Showing {approvals.items.length} of {approvals.total} current observations</p>
        <div className={styles.reviewList}>
          {approvals.items.map((item) => <article className={styles.reviewItem} key={item.observationId}>
            <header className={styles.reviewHeader}>
              <div><h3>{item.title}</h3><code>{item.hostname ?? "Unsupported website URL"}</code></div>
              <span className={styles.stateTag}>{item.decision ?? "Not reviewed"}</span>
            </header>
            <dl className={styles.observationDetails}>
              <div><dt>Provider</dt><dd>{item.provider}</dd></div>
              <div><dt>Measurement</dt><dd>{item.value ?? "—"} · {item.metricScope.toLowerCase().replaceAll("_", " ")}</dd></div>
              <div><dt>Metric target</dt><dd><code>{item.metricTarget ?? "—"}</code></dd></div>
              <div><dt>Observed</dt><dd>{displayDate(item.observedOn)}</dd></div>
              <div><dt>Refresh date</dt><dd>{displayDate(item.refreshedAt)}</dd></div>
            </dl>
            {item.status === "AVAILABLE" ? <MetricApprovalForm
              observationId={item.observationId}
              attributionText={item.attributionText}
              evidenceReference={item.evidenceReference}
              reason={item.reviewReason}
              reviewVersion={item.reviewVersion ?? "unreviewed"}
              canApprove
              canRevoke={item.decision === "APPROVED"}
            /> : <p className={styles.unavailable}>This observation has no available value, so it cannot be approved.</p>}
          </article>)}
        </div>
        {approvals.pageCount > 1 && <nav className={styles.pagination} aria-label="Metric review pages">
          {approvals.page > 1 && <Link href={metricsHref(refreshData.page, approvals.page - 1)}>Previous reviews</Link>}
          <span>Page {approvals.page} of {approvals.pageCount} · {approvals.total} observations</span>
          {approvals.page < approvals.pageCount && <Link href={metricsHref(refreshData.page, approvals.page + 1)}>Next reviews</Link>}
        </nav>}
      </>}
    </section>}
  </div>;
}
