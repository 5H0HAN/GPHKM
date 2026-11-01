import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStagedImportRows } from "@/server/catalog/imports";
import styles from "../../../catalog/catalog.module.css";
import layout from "../imports.module.css";
import {
  applyAllImportRowsAction, applySelectedImportAction, discardImportBatchAction,
  refreshGoogleSheetAction,
} from "./actions";
import { ImportActionForm } from "../action-form";
import { ImportStagedRow } from "./import-row";

const fields = [
  ["websiteUrl", "Website URL"], ["title", "Title"], ["description", "Description"], ["countryCode", "Country"],
  ["primaryLanguage", "Language"], ["categories", "Categories (use | between values)"], ["linkType", "Link type"],
  ["linkValidity", "Placement term"], ["turnaroundDays", "Turnaround days"], ["allowsSportsAndGaming", "Sports and gaming allowed"],
  ["allowsPharmacy", "Pharmacy allowed"], ["allowsCrypto", "Crypto allowed"], ["allowsForeignLanguage", "Foreign language allowed"],
  ["sponsoredContentMarking", "Sponsored marking"],
] as const;
const mappingLabels: Record<string, string> = Object.fromEntries(fields.map(([field, label]) => [field, label]));
const statuses = [
  ["READY", "Ready"], ["NEEDS_REVIEW", "Needs review"], ["DUPLICATE_REVIEW", "Possible matches"],
  ["INVALID", "Invalid"], ["APPLIED", "Applied"], ["REJECTED", "Rejected"],
] as const;

function columnLabel(index: number) {
  let value = index;
  let label = "";
  while (value >= 0) {
    label = String.fromCharCode((value % 26) + 65) + label;
    value = Math.floor(value / 26) - 1;
  }
  return label;
}

function rowActionError(code?: string) {
  switch (code) {
    case "price": return "Enter a valid USD retail price for every selected row. No rows were applied.";
    case "update": return "The update was not applied. Review the match, row warnings, and reason; the listing may have changed since this batch was staged.";
    case "discard": return "This batch has apply history or applied listings and must stay available for audit.";
    case "correct": return "The row could not be corrected. Check the values and try again.";
    case "decision": return "The duplicate decision could not be saved. Review the row and reason.";
    case "reject": return "The row could not be rejected. It may already have been applied.";
    case "apply": return "The selected rows could not be applied. Review their current status and prices.";
    case "all-review": return "The whole list is not ready yet. Review or reject every pending row, then try again.";
    case "all-price": return "Save a valid USD retail price for every ready row before importing the whole list.";
    case "all-apply": return "The whole list could not be imported. Refresh this page and review the current row statuses.";
    default: return code ? "That action could not be completed. Review the row and try again." : null;
  }
}

export default async function ImportReviewPage({ params, searchParams }: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ batchId }, query] = await Promise.all([params, searchParams]);
  const pageNumber = typeof query.page === "string" && /^\d{1,2}$/.test(query.page) ? Number(query.page) : 0;
  let result;
  try { result = await getStagedImportRows(await headers(), batchId, pageNumber, query.status); } catch { notFound(); }
  const page = result.rows;
  const readyCount = page.filter((row) => row.status === "READY").length;
  const reviewCount = page.filter((row) => row.status !== "READY" && row.status !== "APPLIED" && row.status !== "REJECTED").length;
  const totalRows = statuses.reduce((total, [status]) => total + Number(result.counts[status] ?? 0), 0);
  const activeStatus = result.activeStatus ?? "";
  const statusHref = (status: string) => `/staff/suppliers/imports/${batchId}${status ? `?status=${status}` : ""}`;
  const firstRowNeedingAttention = page.find((row) => !["READY", "APPLIED", "REJECTED"].includes(row.status));
  const errorMessage = rowActionError(query.error);
  const pendingReviewCount = Math.max(0, result.pendingCount - Number(result.counts.READY ?? 0));
  const canImportAll = result.pendingCount > 0 && pendingReviewCount === 0 && result.unpricedReadyCount === 0;
  const mappedFields = Object.entries(result.batch.mapping).filter(([field, column]) => field !== "__headerRowNumber" && mappingLabels[field] && Number.isInteger(column));
  const headerRowNumber = Number(result.batch.mapping.__headerRowNumber ?? 1);
  const ambiguousHeaderFields = Array.isArray(result.batch.mapping.__ambiguousHeaderFields)
    ? result.batch.mapping.__ambiguousHeaderFields.filter((field): field is string => typeof field === "string") : [];
  const headerLabelsRaw = result.batch.mapping.__headerLabels;
  const headerLabels = headerLabelsRaw && typeof headerLabelsRaw === "object" && !Array.isArray(headerLabelsRaw)
    ? headerLabelsRaw as Record<string, string> : {};
  const sourceHeaders = Array.isArray(result.batch.mapping.__sourceHeaders)
    ? result.batch.mapping.__sourceHeaders.filter((header): header is string => typeof header === "string") : [];
  const mappedColumnIndexes = new Set(mappedFields.map(([, column]) => Number(column)));
  const unmappedHeaders = sourceHeaders.flatMap((header, index) => mappedColumnIndexes.has(index) ? [] : [`${header} (${columnLabel(index)})`]);
  const mappedDescription = mappedFields.length ? mappedFields.map(([field, column]) => {
    const sourceColumn = columnLabel(Number(column));
    return headerLabels[field]
      ? `${mappingLabels[field]} ← “${headerLabels[field]}” (${sourceColumn})`
      : `${mappingLabels[field]} ← column ${sourceColumn}`;
  }).join(" · ") : "No supported fields detected.";
  const tabId = result.batch.sourceReference?.split(":").at(-1);
  return <>
    <header className={`${styles.header} ${layout.reviewHeader}`}>
      <div><h1>Review supplier import</h1><p className={styles.lede}>{result.batch.supplierName} · {totalRows} source rows · staged {new Date(result.batch.createdAt).toLocaleString()}</p></div>
      <Link className={styles.backLink} href="/staff/suppliers/imports">All imports</Link>
    </header>
    {query.staged && <p className={styles.success} role="status">{query.staged} rows staged from a saved source snapshot. Nothing was published.</p>}
    {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}
    {query.allApplied !== undefined && <p className={styles.success} role="status">{query.allApplied} draft listings created across the batch.{query.partial ? " Processing stopped because a row changed or needs review; check the remaining staged rows." : " Nothing was published."}</p>}
    {query.decision && <p className={styles.success} role="status">Duplicate decision recorded.</p>}
    {query.rejected && <p className={styles.success} role="status">Row rejected and recorded.</p>}
    {query.updated && <p className={styles.success} role="status">The matched listing was revised. Its retail price and live status were preserved.</p>}
    {query.applied !== undefined && <p className={styles.success} role="status">{query.applied} new draft listings created. Other rows remain staged for review.</p>}
    <section className={layout.batchOverview} aria-labelledby="batch-overview-title">
      <div className={layout.batchOverviewHeader}>
        <div><h2 id="batch-overview-title">Batch overview</h2><p>Rows are checked independently. Importing creates unpublished drafts; existing listings are only changed when you choose a reviewed match.</p></div>
        <span className={layout.batchStatus}>{result.batch.status.replaceAll("_", " ")}</span>
      </div>
      <dl className={layout.summary}>
        <div><dt>Source</dt><dd>{result.batch.sourceType === "GOOGLE_SHEETS" ? `Google Sheet · tab ${tabId ?? "0"}` : result.batch.sourceFilename ?? result.batch.sourceType}</dd></div>
        <div><dt>Source rows</dt><dd>{totalRows}</dd></div>
        <div><dt>Header row</dt><dd>{headerRowNumber}</dd></div>
        <div><dt>Mapped fields</dt><dd>{mappedFields.length}</dd></div>
        <div><dt>Ready rows without price</dt><dd>{result.unpricedReadyCount}</dd></div>
      </dl>
      <details className={layout.mappingDetails}>
        <summary>Source columns and mapping</summary>
        <p><strong>Detected fields:</strong> {mappedDescription}</p>
        {unmappedHeaders.length > 0 && <p><strong>Not mapped:</strong> {unmappedHeaders.join(" · ")}</p>}
      </details>
      {ambiguousHeaderFields.length > 0 && <p className={layout.mappingWarning}>Multiple columns matched {ambiguousHeaderFields.map((field) => mappingLabels[field] ?? field).join(", ")}; these fields were skipped. Stage a new batch with manual mapping to choose the right columns. <Link className={styles.backLink} href={`/staff/suppliers/imports?supplierId=${encodeURIComponent(result.batch.supplierId)}`}>Start a new import</Link></p>}
    </section>
    {result.pendingCount > 0 && <ImportActionForm action={applyAllImportRowsAction} className={layout.applyAllPanel}>
      <input type="hidden" name="batchId" value={batchId} />
      <div><strong>Import the whole list</strong><p>Applies to all {result.pendingCount} remaining rows across every page. Every pending row must be ready and have a saved USD retail price. New listings are drafts and stay unpublished.</p>
        {pendingReviewCount > 0 && <small>{pendingReviewCount} rows still need review or must be rejected.</small>}
        {result.unpricedReadyCount > 0 && <small>{result.unpricedReadyCount} ready rows still need a saved retail price.</small>}
      </div><button type="submit" disabled={!canImportAll}>Create all remaining drafts</button>
    </ImportActionForm>}
    <details className={layout.batchTools}>
      <summary>Source and batch tools</summary>
      <div className={layout.batchToolsContent}>
        {result.batch.sourceType === "GOOGLE_SHEETS" && result.batch.sourceReference && <ImportActionForm action={refreshGoogleSheetAction} className={layout.refreshForm}>
          <input type="hidden" name="supplierId" value={result.batch.supplierId} />
          <input type="hidden" name="sourceReference" value={result.batch.sourceReference} />
          <p>Fetch the current public tab as a new snapshot. Earlier batches stay available for review.</p>
          <button type="submit">Refresh this Google Sheet</button>
        </ImportActionForm>}
        {result.sourceAvailable && result.actorRole === "SUPER_ADMIN" && <p className={styles.hint}>The source snapshot may contain unmapped supplier data. <Link className={styles.backLink} href={`/api/staff/catalog/import/${encodeURIComponent(batchId)}/source`}>Download source snapshot</Link></p>}
        {result.canDiscard ? <details className={layout.discardDetails}>
          <summary>Discard this unapplied staging batch</summary>
          <p className={styles.hint}>This removes its staged rows and private source file. It cannot be undone. Batches with apply attempts or applied listings stay in the audit history.</p>
          <ImportActionForm action={discardImportBatchAction} className={layout.discardForm}>
            <input type="hidden" name="batchId" value={batchId} />
            <label>Reason for discarding<input name="reason" required minLength={5} maxLength={1000} /></label>
            <label>Type DISCARD to confirm<input name="confirmation" required pattern="DISCARD" autoComplete="off" /></label>
            <button type="submit">Discard batch</button>
          </ImportActionForm>
        </details> : <p className={styles.hint}>This batch has apply history and stays available for audit. Reject any remaining staged rows to finish reviewing it.</p>}
      </div>
    </details>

    <section className={layout.reviewQueue} id="review-queue" aria-labelledby="review-queue-title">
      <div className={layout.reviewQueueHeader}>
        <div><h2 id="review-queue-title">Review rows</h2><p>Correct supplier details, choose GPHKM categories, set retail prices, and check for existing inventory before importing.</p></div>
        {firstRowNeedingAttention && <a className={layout.nextReviewLink} href={`#import-row-${firstRowNeedingAttention.id}`}>Next row needing attention</a>}
      </div>
      <nav className={layout.statusFilters} aria-label="Filter import rows">
        <Link href={statusHref("")} aria-current={!activeStatus ? "page" : undefined}>All <small>{totalRows}</small></Link>
        {statuses.map(([status, label]) => <Link key={status} href={statusHref(status)} aria-current={activeStatus === status ? "page" : undefined}>{label} <small>{result.counts[status] ?? 0}</small></Link>)}
      </nav>
    {page.length === 0 ? <section className={styles.empty}><strong>No rows in this view</strong><p>Choose another status filter or return to all rows.</p><Link href={statusHref("")}>Show all rows</Link></section> : <>
      {activeStatus !== "APPLIED" && activeStatus !== "REJECTED" && <ImportActionForm id="apply-form" action={applySelectedImportAction} className={styles.applyPanel} noValidate>
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="page" value={pageNumber} />
        <input type="hidden" name="status" value={activeStatus} />
        <div><strong>{page.length} rows on this page</strong><p>{readyCount} ready to create · {reviewCount} need review. Select ready rows with saved USD retail prices. New listings become drafts.</p></div>
        <button className={styles.button} type="submit" disabled={readyCount === 0}>Create selected drafts</button>
      </ImportActionForm>}
      <div className={layout.importRows}>{page.map((row) => <ImportStagedRow key={row.id} row={row} batchId={batchId} supplierId={result.batch.supplierId} pageNumber={pageNumber} activeStatus={activeStatus} />)}</div>
      <nav className={styles.pagination} aria-label="Import row pages"><span>Showing rows {page[0]?.rowNumber}–{page.at(-1)?.rowNumber}</span>{pageNumber > 0 && <Link href={`/staff/suppliers/imports/${batchId}?page=${pageNumber - 1}${activeStatus ? `&status=${activeStatus}` : ""}`}>Previous 50 rows</Link>}{result.hasNext && <Link href={`/staff/suppliers/imports/${batchId}?page=${pageNumber + 1}${activeStatus ? `&status=${activeStatus}` : ""}`}>Next 50 rows</Link>}</nav>
    </>}
    </section>
  </>;
}
