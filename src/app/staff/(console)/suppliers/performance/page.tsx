import { headers } from "next/headers";
import Link from "next/link";
import { getSupplierPerformanceReport } from "@/server/catalog/supplier-report";
import { sortSupplierPerformance, type SupplierPerformanceSort } from "@/modules/catalog/supplier-performance";
import styles from "../../catalog/catalog.module.css";

function money(minor: string) {
  const negative = minor.startsWith("-");
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, "0");
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${padded.slice(-2)}`;
}

const columns: Array<{ key: SupplierPerformanceSort; label: string }> = [
  { key: "name", label: "Supplier" }, { key: "paidPlacements", label: "Paid placements" },
  { key: "completed", label: "Completed" }, { key: "rejected", label: "Rejected" },
  { key: "canceled", label: "Canceled" }, { key: "refunded", label: "Refunded" },
  { key: "netSalesMinor", label: "Net sales" },
  { key: "medianPublicationHours", label: "Median publish time" }, { key: "onTimeRate", label: "On time" },
];

export default async function SupplierPerformancePage({ searchParams }: { searchParams: Promise<{ sort?: string; direction?: string }> }) {
  const query = await searchParams;
  const report = await getSupplierPerformanceReport(await headers());
  const sort = columns.some((column) => column.key === query.sort) ? query.sort as SupplierPerformanceSort : "name";
  const direction = query.direction === "desc" ? "desc" : "asc";
  const rows = sortSupplierPerformance(report.suppliers, sort, direction);
  const heading = (key: SupplierPerformanceSort, label: string) => {
    const nextDirection = sort === key && direction === "asc" ? "desc" : "asc";
    const active = sort === key;
    const ariaSort = active ? (direction === "asc" ? "ascending" : "descending") : "none";
    return <th key={key} aria-sort={ariaSort}><Link href={`/staff/suppliers/performance?sort=${key}&direction=${nextDirection}`}>{label}{active ? (direction === "asc" ? " ↑" : " ↓") : ""}</Link></th>;
  };
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>INTERNAL EVALUATION</p><h1>Supplier performance</h1><p className={styles.lede}>Trailing 90 days · generated {new Date(report.generatedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}. No weighted ranking is calculated.</p></div>
      <Link className={styles.button} href="/staff/suppliers/performance/export">Export full JSON</Link></header>
    <section className={styles.empty}><strong>Read the measures with their sample size.</strong><p>Publication time starts at paid order time. On-time sample includes completed items with a saved turnaround estimate and verified live URL. Rejected counts include order items with a recorded supplier rejection, inability to fulfill, or nonresponse in this 90-day window. Net sales subtracts recorded item wallet refunds from paid placement and writing charges; provider fees and cash settlement are reconciled separately.</p></section>
    {report.suppliers.length === 0 ? <section className={styles.empty}><strong>No supplier records</strong></section> : <div className={styles.tableWrap}>
      <table><thead><tr>{columns.map(({ key, label }) => heading(key, label))}</tr></thead><tbody>
      {rows.map(({ id, name, status, performance }) => <tr key={id}><td><Link href={`/staff/suppliers/${id}`}><strong>{name}</strong></Link><div>{status}</div></td><td>{performance.paidPlacements}</td><td>{performance.completed}</td><td>{performance.rejected}</td><td>{performance.canceled}</td><td>{performance.refunded}</td><td>{performance.netSalesMinor === null ? "Unavailable" : money(performance.netSalesMinor)}</td><td>{performance.medianPublicationHours === null ? "—" : `${(performance.medianPublicationHours / 24).toFixed(1)} days`}</td><td>{performance.onTimeRate === null ? "—" : `${(performance.onTimeRate * 100).toFixed(0)}%`} (n={performance.onTimeSampleSize})</td></tr>)}
      </tbody></table>
    </div>}
  </>;
}
