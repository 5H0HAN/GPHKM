import Link from "next/link";
import { headers } from "next/headers";
import { listMetricRedistributionCandidates, listMetricRefreshCandidates } from "@/server/catalog/metrics";
import { isOpenPageRankConfigured } from "@/server/metrics/open-page-rank";
import { refreshOpenPageRankAction, setMetricRedistributionApprovalAction } from "./actions";
import styles from "../catalog/catalog.module.css";

export default async function MetricsPage({ searchParams }: { searchParams: Promise<{ refreshed?: string; error?: string; approvalError?: string; approvalSaved?: string; approvalPage?: string; page?: string | string[] }> }) {
  const [requestHeaders, query] = await Promise.all([headers(), searchParams]);
  const requestedPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const refreshData = await listMetricRefreshCandidates(requestHeaders, requestedPage);
  const items = refreshData.items;
  const approvals = refreshData.canApprove ? await listMetricRedistributionCandidates(requestHeaders, Number(query.approvalPage ?? "1")) : null;
  const providerConfigured = isOpenPageRankConfigured();
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>INTERNAL DATA</p><h1>Domain metrics</h1><p className={styles.lede}>Refresh Open PageRank for selected catalog listings. Super Admin may record an internal redistribution attestation with attribution and rights-review evidence.</p></div></header>
    <p role="note">An internal attestation does not establish provider licensing or legal rights. L-05 remains a hard customer-display gate until external licensing, attribution, redistribution, API access, and cost review is complete. Do not enable customer display before that review.</p>
    {query.refreshed && <p className={styles.success}>Refreshed {query.refreshed} listing observations.</p>}
    {query.error && <p className={styles.error}>Refresh failed or reached the daily limit. No customer-visible metric approval was changed.</p>}
    {!providerConfigured && <p role="status" className={styles.error}>Metric refresh is unavailable because the Open PageRank server key is missing or invalid. Configure OPEN_PAGE_RANK_API_KEY in the server environment; the key is never shown here.</p>}
    {query.approvalSaved && <p className={styles.success}>The internal metric attestation was recorded in the append-only audit history.</p>}
    {query.approvalError && <p className={styles.error}>The review could not be saved. Confirm the observation is still current and complete all required review fields.</p>}
    <section className={styles.formPanel}>
      <h2>Open PageRank refresh</h2>
      <p>Choose up to 100 listings per batch. Each staff account may run up to five batches in a rolling 24-hour period. Provider requests use the fixed Open PageRank endpoint.</p>
      {items.length === 0 ? <p>No listings are available to refresh.</p> : <form action={refreshOpenPageRankAction}>
        <input type="hidden" name="page" value={refreshData.page} />
        <div className={styles.tableWrap}><table><thead><tr><th>Select</th><th>Listing</th><th>Domain</th><th>State</th><th>Latest OPR</th><th>Observed</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id}><td><input type="checkbox" name="listingId" value={item.id} aria-label={`Refresh ${item.title}`} /></td><td>{item.title}</td><td><code>{new URL(item.websiteUrl).hostname}</code></td><td>{item.status}</td><td>{item.metric?.status === "AVAILABLE" ? `${item.metric.value} (${item.metric.metricScope.toLowerCase().replaceAll("_", " ")})` : item.metric?.status ?? "Not refreshed"}</td><td>{item.metric?.observedOn?.toISOString().slice(0, 10) ?? "—"}</td></tr>)}
        </tbody></table></div>
        {refreshData.totalPages > 1 && <nav aria-label="Metric refresh pages">
          {refreshData.page > 1 && <Link href={`/staff/metrics?page=${refreshData.page - 1}`}>Previous</Link>}{" "}
          <span>Page {refreshData.page} of {refreshData.totalPages} · {refreshData.total} listings</span>{" "}
          {refreshData.page < refreshData.totalPages && <Link href={`/staff/metrics?page=${refreshData.page + 1}`}>Next</Link>}
        </nav>}
        <button className={styles.button} type="submit" disabled={!providerConfigured}>Refresh selected metrics</button>
      </form>}
    </section>
    {refreshData.canApprove && <section className={styles.formPanel}>
      <h2>Customer redistribution review</h2>
      <p>Only current observations are eligible. A later refresh becomes the current observation and remains hidden until separately reviewed. Evidence reference and review reason are required for approval and revocation.</p>
      {approvals?.total === 0 ? <p>No metric observations are available for review.</p> : <><div className={styles.tableWrap}><table><thead><tr><th>Listing</th><th>Provider</th><th>Value/state</th><th>Current decision</th><th>Review</th></tr></thead><tbody>
          {approvals?.items.map((item) => <tr key={item.observationId}><td>{item.title}<br /><code>{new URL(item.websiteUrl).hostname}</code></td><td>{item.provider} ({item.metricScope.toLowerCase().replaceAll("_", " ")})<br /><code>{item.metricTarget}</code></td><td>{item.value ?? "—"} / {item.status}</td><td>{item.decision ?? "Not reviewed"}</td><td>
          <form action={setMetricRedistributionApprovalAction}>
            <input type="hidden" name="approvalPage" value={approvals?.page ?? 1} />
            <input type="hidden" name="observationId" value={item.observationId} />
            <label>Attribution text<input name="attributionText" defaultValue={item.attributionText ?? ""} maxLength={300} required /></label>
            <label>Rights evidence reference<input name="evidenceReference" defaultValue={item.evidenceReference ?? ""} maxLength={500} minLength={5} required placeholder="Ticket, contract, or review record ID" /></label>
            <label>Review reason<textarea name="reason" defaultValue={item.reviewReason ?? ""} maxLength={1000} minLength={5} required /></label>
            {item.status === "AVAILABLE" && <button className={styles.button} name="decision" value="APPROVED" type="submit">Record attestation</button>}
            {item.decision === "APPROVED" && <button className={styles.button} name="decision" value="REVOKED" type="submit">Revoke attestation</button>}
          </form>
        </td></tr>)}
      </tbody></table></div>
      {approvals && approvals.pageCount > 1 && <nav aria-label="Metric review pages">
        {approvals.page > 1 && <a href={`?approvalPage=${approvals.page - 1}`}>Previous</a>}
        <span>Page {approvals.page} of {approvals.pageCount} ({approvals.total} observations)</span>
        {approvals.page < approvals.pageCount && <a href={`?approvalPage=${approvals.page + 1}`}>Next</a>}
      </nav>}</>}
    </section>}
  </>;
}
