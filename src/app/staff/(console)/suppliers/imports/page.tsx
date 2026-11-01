import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSuppliers } from "@/server/catalog/admin";
import { listStagedImports } from "@/server/catalog/imports";
import styles from "../../catalog/catalog.module.css";
import layout from "./imports.module.css";
import { ImportActionForm } from "./action-form";
import { discardRecentImportBatchAction } from "./recent-actions";

const mappings = [
  ["websiteUrl", "Website URL or domain"], ["title", "Listing title"], ["description", "Description"],
  ["countryCode", "Country code"], ["primaryLanguage", "Primary language"], ["categories", "Categories"],
  ["linkType", "Link type"], ["linkValidity", "Placement term"], ["turnaroundDays", "Turnaround days"],
  ["allowsSportsAndGaming", "Sports and gaming allowed"], ["allowsPharmacy", "Pharmacy allowed"],
  ["allowsCrypto", "Crypto allowed"], ["allowsForeignLanguage", "Foreign language allowed"],
  ["sponsoredContentMarking", "Sponsored marking"],
] as const;

function errorMessage(code?: string) {
  switch (code) {
    case "busy": return "An XLSX file is already being parsed. Wait for it to finish, then try again.";
    case "sheet-access": return "Google would not provide this tab’s CSV export. The sheet can still open in a browser while export fails; check the tab’s public viewer access, retry, or upload a downloaded CSV.";
    case "sheet-export": return "Google returned a page instead of a CSV export. Check that the link selects the intended tab and that Google allows public export; CSV upload remains available.";
    case "sheet-fetch": return "We couldn’t fetch this tab’s CSV export from Google. Check the link and selected tab, then retry. You can also upload a CSV.";
    case "sheet-size": return "This Sheet export exceeds the 10 MB import limit. Download a smaller tab as CSV or split it into separate imports.";
    case "mapping": return "We couldn’t identify a website column or use that manual mapping. Choose manual mapping and check the header row and column positions.";
    case "format": return "Use a .csv or .xlsx file. Macro-enabled Excel files are not accepted.";
    case "file": return "Choose a non-empty CSV/XLSX file within the 10 MB limit.";
    case "size": return "The import is larger than the allowed request or row limits.";
    case "source": return "Paste a Google Sheets link with the tab you want to import selected.";
    case "discarded": return "The unapplied staging batch was removed along with its stored source file.";
    case "cleanup": return "The staging batch was discarded. Its private source file needs operational cleanup.";
    case "discard": return "This batch has apply history or applied listings, so it must remain available for audit.";
    case "discard-failed": return "The batch could not be removed. It may have apply history; open it to review the batch status.";
    default: return code ? "The import could not be staged. Check the source access, supplier, and field mapping." : null;
  }
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ error?: string; supplierId?: string }> }) {
  const requestHeaders = await headers();
  const [suppliers, batches, query] = await Promise.all([
    listStaffSuppliers(requestHeaders), listStagedImports(requestHeaders), searchParams,
  ]);
  const selectedSupplierId = suppliers.some((supplier) => supplier.id === query.supplierId) ? query.supplierId : suppliers[0]?.id;
  const message = errorMessage(query.error);
  return <>
    <header className={styles.header}>
      <div><h1>Import supplier inventory</h1><p className={styles.lede}>Take a source snapshot, review the mapped rows, and choose which listings to create or update.</p></div>
      <Link className={styles.backLink} href="/staff/suppliers">Back to suppliers</Link>
    </header>
    {query.error && message && query.error !== "discarded" && query.error !== "cleanup" && <p className={styles.error} role="alert">{message}</p>}
    {query.error === "discarded" && <p className={styles.success} role="status">{message}</p>}
    {query.error === "cleanup" && <p className={styles.error} role="status">{message}</p>}
    {suppliers.length === 0 ? <section className={styles.empty}><strong>Add a supplier first</strong><p>Each import belongs to an internal supplier record.</p><Link href="/staff/suppliers">Open suppliers</Link></section> : <form action="/api/staff/catalog/import" method="post" encType="multipart/form-data" className={styles.listingForm}>
      <fieldset>
        <legend>Choose a source</legend>
        <div className={`${styles.formGrid} ${layout.sourceFields}`}>
          <label>Supplier<select name="supplierId" required defaultValue={selectedSupplierId}>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
          <label>Source format<select name="sourceType" defaultValue="GOOGLE_SHEETS"><option value="GOOGLE_SHEETS">Google Sheet link</option><option value="CSV">CSV upload</option><option value="XLSX">XLSX upload</option></select></label>
          <label data-source="sheet-link">Google Sheets link<input name="sheetReference" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" /></label>
          <label data-source="upload">CSV/XLSX file<input name="file" type="file" accept=".csv,.xlsx" /></label>
          <label data-source="xlsx">XLSX sheet number, starting at 0<input name="sheetIndex" type="number" min="0" max="9" defaultValue="0" /></label>
        </div>
        <p className={styles.hint}>For Google Sheets, select the tab to import before copying its link. The source must be readable without a Google sign-in. Each import saves a point-in-time snapshot; refreshes are staff-triggered.</p>
        <div className={layout.sourceNote}><strong>Keep the shared tab focused on inventory.</strong> Treat its contents as public. Legacy metrics, sample URLs, supplier costs, and retail prices are not imported into listing fields. CSV/XLSX upload stays available when a Sheet cannot be read.</div>
      </fieldset>

      <fieldset>
        <legend>Read the supplier’s columns</legend>
        <p className={styles.hint}>Automatic detection scans the first 100 rows for supported headers and maps only known fields. Unrecognized columns stay out of the catalog. Rows with ambiguous values remain in review.</p>
        <div className={layout.modeChoices}>
          <label><input type="radio" name="mappingMode" value="AUTO" defaultChecked /> Detect headers automatically</label>
        </div>
        <details className={layout.mappingDetails}>
          <summary>Use manual column mapping</summary>
          <label className={layout.modeChoices}><input type="radio" name="mappingMode" value="MANUAL" /> I’ll map columns by position</label>
          <div className={styles.mapGrid}>
            <label>Header row, starting at 1<input name="headerRowNumber" type="number" min="1" max="100" defaultValue="1" /></label>
            {mappings.map(([field, label]) => <label key={field}>{label}<input name={field} type="number" min="0" max="31" placeholder="Skip" /></label>)}
          </div>
          <p className={styles.hint}>Column positions start at 0. Map Website URL or domain to continue. For categories, separate values with |.</p>
        </details>
      </fieldset>
      <button className={styles.button} type="submit">Fetch and stage snapshot</button>
    </form>}

    <section className={styles.history}>
      <h2>Recent import batches</h2>
      {batches.length === 0 ? <p className={styles.hint}>No imports staged yet.</p> : <div className={`${styles.tableWrap} ${layout.historyTable}`}><table><thead><tr><th>Supplier</th><th>Source</th><th>Status</th><th>Rows</th><th>Staged / actions</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.id}>
        <td>{batch.supplierName}</td>
        <td>{batch.sourceType === "GOOGLE_SHEETS" ? "Google Sheet" : batch.sourceFilename ?? batch.sourceType}</td>
        <td><span className={layout.batchStatus}>{statusLabel(batch.status)}</span></td>
        <td><div className={layout.rowCounts}><span>{batch.readyCount} ready</span><span>{batch.reviewCount} review</span><span>{batch.duplicateCount} duplicates</span><span>{batch.invalidCount} invalid</span>{batch.appliedCount > 0 && <span>{batch.appliedCount} applied</span>}</div></td>
        <td><div className={layout.historyRowActions}>
          <Link href={`/staff/suppliers/imports/${batch.id}`}>{new Date(batch.createdAt).toLocaleString()}</Link>
          {batch.canDiscard ? <>
          <button type="button" className={layout.historyRemoveTrigger} popoverTarget={`discard-${batch.id}`}>Remove staged batch</button>
          <div id={`discard-${batch.id}`} popover="auto" className={layout.historyRemove}>
          <ImportActionForm action={discardRecentImportBatchAction} className={layout.historyRemoveForm}>
            <input type="hidden" name="batchId" value={batch.id} />
            <p>This removes the staged rows and saved source snapshot. Apply history is never removed.</p>
            <label>Reason<input name="reason" required minLength={5} maxLength={1000} /></label>
            <label>Type DISCARD to confirm<input name="confirmation" required pattern="DISCARD" autoComplete="off" /></label>
            <button type="submit">Remove batch</button>
          </ImportActionForm>
          </div>
          </> : <span className={layout.retainedBatch} title="Batches with apply history are retained for audit">Retained</span>}
        </div></td>
      </tr>)}</tbody></table></div>}
    </section>
  </>;
}
