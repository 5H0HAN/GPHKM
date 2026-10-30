import Link from "next/link";
import { headers } from "next/headers";
import { listStaffSuppliers } from "@/server/catalog/admin";
import { listStagedImports } from "@/server/catalog/imports";
import styles from "../../catalog/catalog.module.css";

const mappings = [
  ["websiteUrl", "Website URL", true], ["title", "Listing title", false], ["description", "Description", false],
  ["countryCode", "Country code", false], ["primaryLanguage", "Language", false], ["categories", "Categories, separated with |", false],
  ["linkType", "Link type", false], ["linkValidity", "Link validity", false], ["turnaroundDays", "Turnaround days", false],
  ["allowsSportsAndGaming", "Sports and gaming allowed", false], ["allowsPharmacy", "Pharmacy allowed", false],
  ["allowsCrypto", "Crypto allowed", false], ["allowsForeignLanguage", "Foreign language allowed", false],
  ["sponsoredContentMarking", "Sponsored marking", false],
] as const;

export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ error?: string; supplierId?: string }> }) {
  const requestHeaders = await headers();
  const [suppliers, batches, query] = await Promise.all([
    listStaffSuppliers(requestHeaders), listStagedImports(requestHeaders), searchParams,
  ]);
  const selectedSupplierId = suppliers.some((supplier) => supplier.id === query.supplierId) ? query.supplierId : suppliers[0]?.id;
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>SUPPLIERS / INVENTORY IMPORT</p><h1>Stage inventory</h1><p className={styles.lede}>Upload a supplier spreadsheet or refresh a readable Google Sheet. Rows stay staged until staff review them.</p></div><Link className={styles.backLink} href="/staff/suppliers">Back to suppliers</Link></header>
    {query.error === "busy" ? <p className={styles.error}>An XLSX file is already being parsed. Wait for it to finish, then retry this import.</p> : query.error && <p className={styles.error}>Import could not be staged. Check the file, mapping, supplier, and access permissions.</p>}
    {suppliers.length === 0 ? <section className={styles.empty}><strong>Add a supplier first</strong><p>Imports must be linked to an internal supplier record.</p><Link href="/staff/suppliers">Open suppliers</Link></section> : <form action="/api/staff/catalog/import" method="post" encType="multipart/form-data" className={styles.listingForm}>
      <fieldset><legend>Source</legend>
        <div className={styles.formGrid}>
          <label>Supplier<select name="supplierId" required defaultValue={selectedSupplierId}>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
          <label>Source format<select name="sourceType" defaultValue="CSV"><option value="CSV">CSV upload</option><option value="XLSX">XLSX upload</option><option value="GOOGLE_SHEETS">Public Google Sheet</option></select></label>
          <label>CSV/XLSX file<input name="file" type="file" accept=".csv,.xlsx" /></label>
          <label>Google Sheets URL<input name="sheetReference" type="url" placeholder="https://docs.google.com/spreadsheets/d/…" /></label>
          <label>XLSX sheet number (starting at 0)<input name="sheetIndex" type="number" min="0" max="9" defaultValue="0" /></label>
        </div>
        <p className={styles.hint}>Uploaded source files are retained in private storage with no automatic deletion period configured. Only Super Admins can download raw source files. Do not upload files containing unnecessary sensitive data. Maximum 10 MB, 5,000 rows, 32 columns and 8,000 characters per cell. Public Sheets are fetched from Google’s fixed CSV endpoint; redirects are rejected.</p>
      </fieldset>
      <fieldset><legend>Column mapping</legend>
        <p className={styles.hint}>Enter each source column’s zero-based position. Choose which row contains the headers; leave unmapped fields blank. Categories use | between values. At least map Website URL. Bare domain names are imported as HTTPS site roots. Source costs and third-party metrics are handled separately from listing imports.</p>
        <div className={styles.mapGrid}><label>Header row number<input name="headerRowNumber" type="number" min="1" max="100" defaultValue="1" required /></label>{mappings.map(([field, label, required]) => <label key={field}>{label}<input name={field} type="number" min="0" max="31" placeholder={required ? "Required" : "Skip"} required={required} /></label>)}</div>
      </fieldset>
      <button className={styles.button} type="submit">Parse and stage rows</button>
    </form>}
    <section className={styles.history}>
      <h2>Recent staged imports</h2>
      {batches.length === 0 ? <p className={styles.hint}>No imports staged yet.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Supplier</th><th>Source</th><th>File</th><th>Rows</th><th>Staged</th></tr></thead><tbody>{batches.map((batch) => <tr key={batch.id}><td>{batch.supplierName}</td><td>{batch.sourceType.replaceAll("_", " ")}</td><td>{batch.sourceFilename ?? "Google Sheet"}</td><td>{batch.rowCount}</td><td><Link href={`/staff/suppliers/imports/${batch.id}`}>{new Date(batch.createdAt).toLocaleString()}</Link></td></tr>)}</tbody></table></div>}
    </section>
  </>;
}
