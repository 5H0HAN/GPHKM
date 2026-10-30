import { headers } from "next/headers";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getSupplierFinanceData } from "@/server/catalog/supplier-finance";
import styles from "../../catalog/catalog.module.css";
import { changeListingCostAction, recordActualCostAction, searchSupplierTransferItemsAction } from "./actions";
import { TransferAllocationEditor } from "./transfer-allocation-editor";

function usd(minor: string | null) {
  if (minor === null) return "Not recorded";
  const value = BigInt(minor);
  return `$${(value / 100n).toLocaleString("en-US")}.${(value % 100n).toString().padStart(2, "0")}`;
}

function dollarInput(minor: string | null) {
  if (minor === null) return "";
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function when(date: Date) {
  return new Date(date).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" });
}

export default async function SupplierFinancePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; listingsPage?: string | string[]; orderItemsPage?: string | string[]; transfersPage?: string | string[] }> }) {
  const query = await searchParams;
  const pageParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const listingsPage = pageParam(query.listingsPage) ?? "1";
  const orderItemsPage = pageParam(query.orderItemsPage) ?? "1";
  const transfersPage = pageParam(query.transfersPage) ?? "1";
  const [data] = await Promise.all([getSupplierFinanceData(await headers(), { listings: listingsPage, orderItems: orderItemsPage, transfers: transfersPage })]);
  const listingPageHref = (page: number) => `/staff/suppliers/finance?listingsPage=${page}&orderItemsPage=${data.orderItemPagination.page}&transfersPage=${data.transferPagination.page}`;
  const orderPageHref = (page: number) => `/staff/suppliers/finance?listingsPage=${data.listingPagination.page}&orderItemsPage=${page}&transfersPage=${data.transferPagination.page}`;
  const transferPageHref = (page: number) => `/staff/suppliers/finance?listingsPage=${data.listingPagination.page}&orderItemsPage=${data.orderItemPagination.page}&transfersPage=${page}`;
  const transferGroups = new Map<string, { supplierId: string; supplierName: string; items: Array<{ id: string; title: string }> }>();
  for (const item of data.orderItems) {
    for (const option of item.supplierOptions) {
      const group = transferGroups.get(option.id) ?? { supplierId: option.id, supplierName: option.name, items: [] };
      group.items.push({ id: item.id, title: item.listingTitle });
      transferGroups.set(option.id, group);
    }
  }
  return <>
    <header className={styles.header}><div><p className={styles.eyebrow}>RESTRICTED FINANCE</p><h1>Supplier costs & records</h1><p className={styles.lede}>Append-only cost corrections and manual payment evidence. No money is transferred from this page.</p></div><Link className={styles.button} href="/staff/suppliers/finance/margins">View gross profit</Link></header>
    {query.saved && <p className={styles.success}>Finance record saved.</p>}
    {query.error && <p className={styles.error}>The record could not be saved. Verify the values, supplier assignment, and Finance access.</p>}
    <section className={styles.formPanel}><h2>Listing source costs</h2><p>Blank amount clears the current source-cost projection. Every change records the previous and new amount.</p>
      <nav className={styles.pagination} aria-label="Finance listing pages">{data.listingPagination.page > 1 && <Link href={listingPageHref(data.listingPagination.page - 1)}>Previous page</Link>}<span>Page {data.listingPagination.page} of {data.listingPagination.totalPages} · {data.listingPagination.total} listings</span>{data.listingPagination.page < data.listingPagination.totalPages && <Link href={listingPageHref(data.listingPagination.page + 1)}>Next page</Link>}</nav>
      {data.listings.length === 0 ? <p>No listings are available.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Listing</th><th>Supplier</th><th>Current source cost</th><th>Correct cost</th></tr></thead><tbody>{data.listings.map((item) => <tr key={item.id}>
        <td><strong>{item.title}</strong><div><small>{item.id}</small></div></td><td>{item.supplierName ?? "Platform fulfilled"}</td><td>{usd(item.currentCostMinor)}</td><td><form action={changeListingCostAction} className={styles.supplierForm}>
          <input type="hidden" name="listingsPage" value={data.listingPagination.page} /><input type="hidden" name="orderItemsPage" value={data.orderItemPagination.page} /><input type="hidden" name="transfersPage" value={data.transferPagination.page} />
          <input type="hidden" name="listingId" value={item.id} /><label>New amount (USD; blank clears)<input name="amount" inputMode="decimal" defaultValue={dollarInput(item.currentCostMinor)} placeholder="e.g. 125.00" /></label>
          <label>Reason<input name="reason" required minLength={3} maxLength={1000} /></label><button className={styles.button} type="submit">Record correction</button>
        </form></td></tr>)}</tbody></table></div>}
    </section>

    <section className={styles.formPanel}><h2>Actual order-item direct costs</h2><p>Each correction is a new history record. The checkout snapshot and prior corrections remain unchanged. Writing costs are internal to GPHKM; supplier attribution applies to placement costs.</p>
      <nav className={styles.pagination} aria-label="Finance order item pages">{data.orderItemPagination.page > 1 && <Link href={orderPageHref(data.orderItemPagination.page - 1)}>Previous page</Link>}<span>Page {data.orderItemPagination.page} of {data.orderItemPagination.totalPages} · {data.orderItemPagination.total} order items</span>{data.orderItemPagination.page < data.orderItemPagination.totalPages && <Link href={orderPageHref(data.orderItemPagination.page + 1)}>Next page</Link>}</nav>
      {data.orderItems.length === 0 ? <p>No order items are available.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Order item</th><th>Eligible supplier routes</th><th>Checkout source cost</th><th>Checkout writing cost</th><th>Record actual cost</th></tr></thead><tbody>{data.orderItems.map((item) => <tr key={item.id}>
        <td><strong>Order item</strong><div><small>{item.id}</small></div></td><td>{item.supplierOptions.length ? item.supplierOptions.map((option) => option.name).join(", ") : "Internal fulfillment"}</td><td>{usd(item.sourceCostMinor)}</td><td>{item.writingSelected ? usd(item.writingCostMinor) : "Not ordered"}</td><td>
          <form action={recordActualCostAction} className={styles.supplierForm}><input type="hidden" name="orderItemId" value={item.id} />
            <input type="hidden" name="listingsPage" value={data.listingPagination.page} /><input type="hidden" name="orderItemsPage" value={data.orderItemPagination.page} /><input type="hidden" name="transfersPage" value={data.transferPagination.page} />
            <label>Cost component<select name="component"><option value="PLACEMENT">Placement</option>{item.writingSelected && <option value="WRITING">Writing</option>}</select></label>
            <label>Supplier attribution<select name="supplierId"><option value="">Internal / GPHKM cost</option>{item.supplierOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
            <label>Actual amount (USD)<input name="amount" required inputMode="decimal" placeholder="e.g. 125.00" /></label>
            <label>Reason<input name="reason" required minLength={3} maxLength={1000} /></label><button className={styles.button} type="submit">Record actual cost</button>
          </form>
        </td></tr>)}</tbody></table></div>}
    </section>

    <section className={styles.formPanel}><h2>Record an actual supplier transfer</h2><p>Record a completed manual transfer once, then allocate its full amount across one or more order items for that supplier. Partial payment across an item’s cost is allowed. This records what happened; it never initiates a payout. The reference must be unique for that supplier.</p>
      {transferGroups.size === 0 ? <p>No supplier-linked order items are available on this page. Use order item pages above to select other items.</p> : [...transferGroups.values()].map((group) => <div key={group.supplierId}><h3>{group.supplierName}</h3><TransferAllocationEditor items={group.items} supplierId={group.supplierId} idempotencyKey={randomUUID()} orderItemsPage={data.orderItemPagination.page} transfersPage={data.transferPagination.page} searchAction={searchSupplierTransferItemsAction} /></div>)}
    </section>

    <section className={styles.formPanel}><h2>Confirmed supplier payable coverage</h2><p>Coverage uses actual cost corrections and transfer events for the same supplier and order item. A missing actual cost remains provisional and is not treated as zero.</p>{data.payableCoverage.length === 0 ? <p>No confirmed supplier costs to reconcile.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Supplier / item</th><th>Confirmed cost</th><th>Transferred</th><th>Coverage</th></tr></thead><tbody>{data.payableCoverage.map((item) => <tr key={`${item.orderItemId}:${item.supplierId}`}><td>{item.supplierName}<div><small>{item.orderItemId}</small></div></td><td>{usd(item.confirmedCostMinor)}</td><td>{usd(item.transferredMinor)}</td><td>{item.status}</td></tr>)}</tbody></table></div>}</section>

    <section className={styles.formPanel}><h2>Supplier transfer events</h2>
      <nav className={styles.pagination} aria-label="Supplier transfer pages">{data.transferPagination.page > 1 && <Link href={transferPageHref(data.transferPagination.page - 1)}>Previous page</Link>}<span>Page {data.transferPagination.page} of {data.transferPagination.totalPages} · {data.transferPagination.total} transfers</span>{data.transferPagination.page < data.transferPagination.totalPages && <Link href={transferPageHref(data.transferPagination.page + 1)}>Next page</Link>}</nav>
      {data.payments.length === 0 ? <p>No transfers recorded.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Supplier</th><th>Transfer amount</th><th>Allocations</th><th>Date / reference</th><th>Evidence and reason</th><th>Recorded</th></tr></thead><tbody>{data.payments.map((item) => <tr key={item.id}><td>{item.supplierName}</td><td>{usd(item.amountMinor)}</td><td>{item.allocations.map((allocation) => <div key={`${item.id}:${allocation.orderItemId}`}>{allocation.orderItemId}: {usd(allocation.amountMinor)} ({allocation.coverage})</div>)}</td><td>{when(item.transferDate)}<div><small>{item.transferReference}</small></div></td><td>{item.evidenceReference}{item.evidence && <div><a href={`/api/staff/suppliers/finance/transfers/evidence/${encodeURIComponent(item.evidence.id)}`}>Download {item.evidence.fileKind}</a></div>}<div>{item.reason}</div></td><td>{when(item.createdAt)}</td></tr>)}</tbody></table></div>}
    </section>

    <section className={styles.formPanel}><h2>Legacy payment status history</h2><p>Historical PAID/UNPAID records are preserved for audit, but are excluded from transfer and payable reconciliation.</p>{data.legacyPayments.length === 0 ? <p>No legacy records.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Supplier / item</th><th>Legacy status</th><th>Amount</th><th>Date</th><th>Evidence reference</th><th>Reason</th><th>Recorded</th></tr></thead><tbody>{data.legacyPayments.map((item) => <tr key={item.id}><td>{item.supplierName}<div><small>{item.orderItemId}</small></div></td><td>{item.status}</td><td>{usd(item.amountMinor)}</td><td>{when(item.paymentDate)}</td><td>{item.evidenceReference}</td><td>{item.reason}</td><td>{when(item.createdAt)}</td></tr>)}</tbody></table></div>}</section>

    <section className={styles.formPanel}><h2>Recent cost corrections</h2>
      {data.listingHistory.length === 0 && data.actualCostHistory.length === 0 ? <p>No cost corrections recorded.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Listing / item</th><th>Supplier</th><th>Component</th><th>Previous</th><th>New</th><th>Reason</th><th>Recorded</th></tr></thead><tbody>
        {data.listingHistory.map((item) => <tr key={item.id}><td>{item.title}<div><small>{item.listingId}</small></div></td><td>{item.supplierName ?? "Platform"}</td><td>Listing source cost</td><td>{usd(item.previousCostMinor)}</td><td>{usd(item.newCostMinor)}</td><td>{item.reason}</td><td>{when(item.createdAt)}</td></tr>)}
        {data.actualCostHistory.map((item) => <tr key={item.id}><td>{item.listingTitle}<div><small>{item.orderItemId}</small></div></td><td>{item.supplierName ?? "Platform"}</td><td>{item.component}</td><td>{usd(item.previousCostMinor)}</td><td>{usd(item.newCostMinor)}</td><td>{item.reason}</td><td>{when(item.createdAt)}</td></tr>)}
      </tbody></table></div>}
    </section>
  </>;
}
