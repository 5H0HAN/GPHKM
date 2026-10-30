import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getStagedImportRows } from "@/server/catalog/imports";
import styles from "../../../catalog/catalog.module.css";
import { applySelectedImportAction, correctImportRowAction, decideDuplicateAction, rejectImportRowAction } from "./actions";

const fields = [
  ["websiteUrl", "Website URL"], ["title", "Title"], ["description", "Description"], ["countryCode", "Country"],
  ["primaryLanguage", "Language"], ["categories", "Categories (separate with |)"], ["linkType", "Link type"],
  ["linkValidity", "Link validity"], ["turnaroundDays", "Turnaround days"], ["allowsSportsAndGaming", "Sports and gaming allowed"],
  ["allowsPharmacy", "Pharmacy allowed"], ["allowsCrypto", "Crypto allowed"], ["allowsForeignLanguage", "Foreign language allowed"],
  ["sponsoredContentMarking", "Sponsored marking"],
] as const;
const comparisonFields = [
  ["websiteUrl", "Website URL"], ["title", "Title"], ["description", "Description"], ["countryCode", "Country"],
  ["primaryLanguage", "Language"], ["categories", "Categories"], ["linkType", "Link type"], ["linkValidity", "Link validity"],
  ["turnaroundDays", "Turnaround"], ["allowsSportsAndGaming", "Sports and gaming"], ["allowsPharmacy", "Pharmacy"],
  ["allowsCrypto", "Crypto"], ["allowsForeignLanguage", "Foreign language"], ["sponsoredContentMarking", "Sponsored marking"],
] as const;

function compareText(value: unknown) {
  if (value === null || value === undefined) return "Not set";
  if (Array.isArray(value)) return value.join(" | ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function usdCents(value: string) {
  const cents = BigInt(value);
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, "0");
  return `${cents < 0n ? "-" : ""}$${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${digits.slice(-2)}`;
}

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ batchId }, query] = await Promise.all([params, searchParams]);
  const pageNumber = typeof query.page === "string" && /^\d{1,2}$/.test(query.page) ? Number(query.page) : 0;
  let result;
  try { result = await getStagedImportRows(await headers(), batchId, pageNumber); } catch { notFound(); }
  const page = result.rows;
  const readyCount = page.filter((row) => row.status === "READY").length;
  const reviewCount = page.filter((row) => row.status !== "READY" && row.status !== "APPLIED" && row.status !== "REJECTED").length;
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>SUPPLIERS / IMPORT REVIEW</p><h1>Staged rows</h1><p className={styles.lede}>Correct and review rows before applying selected entries as draft listings. Nothing is published automatically.</p></div><Link className={styles.backLink} href="/staff/suppliers/imports">Back to imports</Link></header>
    {query.staged && <p className={styles.success}>{query.staged} rows staged. No listing was created or published.</p>}
    {query.error && <p className={styles.error}>The row action could not be completed. Review the row state, mapping, and price.</p>}
    {query.corrected && <p className={styles.success}>Row corrections saved and revalidated.</p>}
    {query.decision && <p className={styles.success}>Duplicate decision recorded.</p>}
    {query.rejected && <p className={styles.success}>Row rejected and recorded.</p>}
    {query.applied !== undefined && <p className={styles.success}>{query.applied} rows created as draft listings. Other rows remain staged for review.</p>}
    {result.sourceAvailable && result.actorRole === "SUPER_ADMIN" && <p className={styles.lede}>Original supplier inventory file is private and may contain source costs. <Link className={styles.backLink} href={`/api/staff/catalog/import/${encodeURIComponent(batchId)}/source`}>Download source file</Link></p>}
    {page.length === 0 ? <section className={styles.empty}><strong>No rows on this page</strong><p>The file may contain only headers or an empty page number.</p></section> : <>
      <form id="apply-form" action={applySelectedImportAction} className={styles.applyPanel}>
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="page" value={pageNumber} />
        <div><strong>{page.length} rows on this page</strong><p>{readyCount} ready to apply · {reviewCount} need review. Select only ready rows and set each USD retail price. Source cost is never used as retail price; applying creates drafts only.</p></div>
        <button className={styles.button} type="submit" disabled={readyCount === 0}>Apply selected as draft listings</button>
      </form>
      <div className={styles.tableWrap}><table><thead><tr><th>Select</th><th>Row</th><th>Website</th><th>Title</th><th>Categories</th><th>Status</th><th>Review notes / actions</th></tr></thead><tbody>{page.map((row) => {
        const original = row.originalValues as Record<string, unknown>;
        const values = row.values as Record<string, unknown>;
        const editable = row.status !== "APPLIED" && row.status !== "REJECTED";
        const normalized = (field: string) => { const value = original[field] ?? values[field]; return typeof value === "boolean" ? value ? "yes" : "no" : String(value ?? ""); };
        return <tr key={row.id}>
          <td>{row.status === "READY" && <><input form="apply-form" type="checkbox" name="rowId" value={row.id} aria-label={`Select row ${row.rowNumber}`} /><label className={styles.priceInput}>USD price<input form="apply-form" name={`price_${row.id}`} type="number" min="0.01" step="0.01" /></label></>}</td>
          <td>{row.rowNumber}</td><td>{String(values.websiteUrl ?? "—")}</td><td>{String(values.title ?? "—")}</td><td>{String(values.categories ?? "—")}</td>
          <td><span className={styles.status}>{row.status.replaceAll("_", " ")}</span>{row.duplicateDecision && <small className={styles.decision}>{row.duplicateDecision.replaceAll("_", " ")}</small>}</td>
          <td><p>{[...row.errors.map((error) => `${error.field}: ${error.code}`), ...row.warnings].join(", ") || "—"}{row.duplicateOfRow ? ` (also row ${row.duplicateOfRow})` : ""}</p>
            {row.duplicateMatches.map((match) => <details key={match.id}><summary>Compare with {match.title} · revision {match.revision}</summary>
              <p>Existing listing: {match.status.replaceAll("_", " ")} · {usdCents(match.retailPriceCents)} retail price</p>
              <p>Internal source: {match.commercialSource.replaceAll("_", " ")} · {match.sourceSupplierName ?? "GPHKM"}. Fulfillment: {match.fulfillmentSupplierName ?? "GPHKM"}.</p>
              <p>Import review never changes an existing listing. Keep this as a separate draft or reject it here; use the catalog editor to revise the existing listing.</p>
              <Link className={styles.backLink} href={`/staff/catalog/${match.id}/edit`}>Open listing editor</Link>
              <div className={styles.tableWrap}><table><thead><tr><th>Field</th><th>Current listing</th><th>Imported value</th></tr></thead><tbody>
                {comparisonFields.filter(([field]) => values[field] !== undefined).map(([field, label]) => <tr key={field}><td>{label}</td><td>{compareText(match[field])}</td><td>{compareText(values[field])}</td></tr>)}
              </tbody></table></div>
            </details>)}
            {row.hiddenMatchCount > 0 && <p>{row.hiddenMatchCount} additional domain matches not shown. Review search results in Catalog before applying.</p>}
            {editable && <details><summary>Correct row details</summary><form action={correctImportRowAction} className={styles.correctForm}><input type="hidden" name="batchId" value={batchId} /><input type="hidden" name="rowId" value={row.id} /><input type="hidden" name="page" value={pageNumber} />
              <div className={styles.correctGrid}>{fields.map(([field, label]) => <label key={field}>{label}<input name={`field_${field}`} defaultValue={normalized(field)} maxLength={field === "description" ? 4000 : 2048} /></label>)}</div>
              <button className={styles.button} type="submit">Save corrections</button>
            </form></details>}
            {editable && <details className={styles.rowDecision}><summary>Row decisions</summary>
              {row.status === "DUPLICATE_REVIEW" && <form action={decideDuplicateAction} className={styles.decisionForm}><input type="hidden" name="batchId" value={batchId} /><input type="hidden" name="rowId" value={row.id} /><input type="hidden" name="page" value={pageNumber} /><label>Duplicate decision<select name="decision" defaultValue="KEEP_SEPARATE"><option value="KEEP_SEPARATE">Keep as a separate listing</option><option value="REJECT">Reject this row</option></select></label><label>Reason<input name="reason" required maxLength={1000} /></label><button type="submit">Record decision</button></form>}
              {editable && row.status !== "DUPLICATE_REVIEW" && <form action={rejectImportRowAction} className={styles.rejectForm}><input type="hidden" name="batchId" value={batchId} /><input type="hidden" name="rowId" value={row.id} /><input type="hidden" name="page" value={pageNumber} /><label>Reject reason<select name="reason" defaultValue="INVALID_SOURCE_DATA"><option value="INVALID_SOURCE_DATA">Invalid supplier data</option><option value="NO_LONGER_OFFERED">Supplier no longer offers it</option><option value="OTHER">Other review reason</option></select></label><button type="submit">Reject row</button></form>}
            </details>}
          </td>
        </tr>;
      })}</tbody></table></div>
      <nav className={styles.pagination} aria-label="Import row pages"><span>Showing {page[0]?.rowNumber}–{page.at(-1)?.rowNumber}</span>{result.hasPrevious && <Link href={`/staff/suppliers/imports/${batchId}?page=${pageNumber - 1}`}>Previous 50 rows</Link>}{result.hasNext && <Link href={`/staff/suppliers/imports/${batchId}?page=${pageNumber + 1}`}>Next 50 rows</Link>}</nav>
    </>}
  </>;
}
