import { headers } from "next/headers";
import Link from "next/link";
import { getFinanceGrossProfitReport } from "@/server/catalog/gross-profit-report";
import styles from "../../../catalog/catalog.module.css";

export const dynamic = "force-dynamic";

function usd(minor: string | null) {
  if (minor === null) return "Provisional";
  const amount = BigInt(minor);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}$${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function pageValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FinanceGrossProfitPage({ searchParams }: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const query = await searchParams;
  const report = await getFinanceGrossProfitReport(await headers(), pageValue(query.page));
  const pageHref = (page: number) => `/staff/suppliers/finance/margins?page=${page}`;
  return <>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>RESTRICTED FINANCE</p><h1>Gross profit</h1>
        <p className={styles.lede}>Paid order items purchased in the trailing 90 days · generated {new Date(report.generatedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}.</p></div>
      <Link className={styles.button} href="/staff/suppliers/finance">Cost records</Link>
    </header>
    <section className={styles.empty}>
      <strong>Confirmed cost is required for gross profit.</strong>
      <p>Gross profit equals retail charges minus recorded item refunds and confirmed direct placement and writing costs. When any required direct cost is missing or provisional, gross profit stays unavailable; known costs remain visible separately. Stripe processing fees are excluded here and reconciled separately in Finance.</p>
    </section>
    <section className={styles.formPanel}>
      <h2>Order-item detail</h2>
      <nav className={styles.pagination} aria-label="Gross profit report pages">
        {report.pagination.page > 1 ? <Link href={pageHref(report.pagination.page - 1)}>Previous page</Link> : <span />}
        <span>Page {report.pagination.page} of {report.pagination.totalPages} · {report.pagination.total} items</span>
        {report.pagination.page < report.pagination.totalPages ? <Link href={pageHref(report.pagination.page + 1)}>Next page</Link> : <span />}
      </nav>
      {!report.items.length ? <p>No paid order items in this 90-day period.</p> : <div className={styles.tableWrap}>
        <table><thead><tr><th>Purchased</th><th>Order item</th><th>Retail</th><th>Refunds</th><th>Known direct costs</th><th>Cost state</th><th>Gross profit</th></tr></thead>
          <tbody>{report.items.map((item) => <tr key={item.orderItemId}>
            <td>{new Date(item.purchasedAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}</td>
            <td><code>{item.orderItemId}</code></td>
            <td>{usd(item.retailMinor)}</td><td>{usd(item.refundedMinor)}</td><td>{usd(item.knownDirectCostMinor)}</td>
            <td>{item.costStatus}</td><td>{item.grossProfitMinor === null ? (item.costStatus === "UNKNOWN" ? "Unavailable" : "Provisional") : usd(item.grossProfitMinor)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </>;
}
