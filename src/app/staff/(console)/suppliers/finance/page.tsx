import { headers } from "next/headers";
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getSupplierFinanceData } from "@/server/catalog/supplier-finance";
import catalogStyles from "../../catalog/catalog.module.css";
import styles from "./finance.module.css";
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

function countLabel(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function pageRange(pagination: { page: number; limit: number; total: number }) {
  if (pagination.total === 0) return "No matching records";
  const first = (pagination.page - 1) * pagination.limit + 1;
  const last = Math.min(pagination.page * pagination.limit, pagination.total);
  return `Showing ${first}–${last} of ${pagination.total}`;
}

export default async function SupplierFinancePage({ searchParams }: {
  searchParams: Promise<{ saved?: string; error?: string; q?: string | string[]; listingsPage?: string | string[]; orderItemsPage?: string | string[]; transfersPage?: string | string[]; coveragePage?: string | string[] }>;
}) {
  const query = await searchParams;
  const pageParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const searchQuery = (pageParam(query.q) ?? "").trim().slice(0, 100);
  const listingsPage = pageParam(query.listingsPage) ?? "1";
  const orderItemsPage = pageParam(query.orderItemsPage) ?? "1";
  const transfersPage = pageParam(query.transfersPage) ?? "1";
  const coveragePage = pageParam(query.coveragePage) ?? "1";
  const [data] = await Promise.all([
    getSupplierFinanceData(await headers(), { listings: listingsPage, orderItems: orderItemsPage, transfers: transfersPage, coverage: coveragePage, search: searchQuery }),
  ]);
  const financeHref = (pages: { listings?: number; orderItems?: number; transfers?: number; coverage?: number }) => {
    const params = new URLSearchParams({
      listingsPage: String(pages.listings ?? data.listingPagination.page),
      orderItemsPage: String(pages.orderItems ?? data.orderItemPagination.page),
      transfersPage: String(pages.transfers ?? data.transferPagination.page),
      coveragePage: String(pages.coverage ?? data.payableCoveragePagination.page),
    });
    if (data.searchQuery) params.set("q", data.searchQuery);
    return `/staff/suppliers/finance?${params.toString()}`;
  };
  const listingPageHref = (page: number) => financeHref({ listings: page });
  const orderPageHref = (page: number) => financeHref({ orderItems: page });
  const transferPageHref = (page: number) => financeHref({ transfers: page });
  const coveragePageHref = (page: number) => financeHref({ coverage: page });
  const transferGroups = new Map<string, { supplierId: string; supplierName: string; items: Array<{ id: string; title: string }> }>();

  for (const item of data.orderItems) {
    for (const option of item.supplierOptions) {
      const group = transferGroups.get(option.id) ?? { supplierId: option.id, supplierName: option.name, items: [] };
      group.items.push({ id: item.id, title: item.listingTitle });
      transferGroups.set(option.id, group);
    }
  }

  const costHistory = [
    ...data.listingHistory.map((item) => ({
      id: item.id,
      label: item.title,
      recordId: item.listingId,
      supplierName: item.supplierName ?? "Platform",
      component: "Listing source cost",
      previousCostMinor: item.previousCostMinor,
      newCostMinor: item.newCostMinor,
      reason: item.reason,
      createdAt: item.createdAt,
    })),
    ...data.actualCostHistory.map((item) => ({
      id: item.id,
      label: item.listingTitle,
      recordId: item.orderItemId,
      supplierName: item.supplierName ?? "Platform",
      component: item.component,
      previousCostMinor: item.previousCostMinor,
      newCostMinor: item.newCostMinor,
      reason: item.reason,
      createdAt: item.createdAt,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const successMessage = query.saved === "listing-cost"
    ? "Listing source cost correction recorded."
    : query.saved === "actual-cost"
      ? "Actual order-item cost recorded."
      : query.saved === "transfer"
        ? "Supplier transfer recorded. No funds were sent from GPHKM."
        : query.saved ? "Finance record saved." : "";
  const errorMessage = query.error === "cost"
    ? "Listing source cost correction was not recorded. Check the amount and reason, then retry."
    : query.error === "actual-cost"
      ? "Actual order-item cost was not recorded. Check the amount, attribution, and reason, then retry."
      : query.error === "payment"
        ? "Supplier transfer was not recorded. Check the allocation total, unique reference, receipt, and reason."
        : query.error ? "The finance record could not be saved. Check your access and the submitted values." : "";

  return <div className={styles.page}>
    <header className={styles.header}>
      <div>
        <h1>Supplier costs &amp; payments</h1>
        <p className={styles.lede}>Record cost corrections and completed supplier transfers. This page keeps an audit record; it never sends money.</p>
      </div>
      <Link className={styles.reportLink} href="/staff/suppliers/finance/margins">View gross profit</Link>
    </header>

    {successMessage && <p className={styles.success} role="status">{successMessage}</p>}
    {errorMessage && <p className={styles.error} role="alert">{errorMessage}</p>}

    <form className={styles.financeSearch} role="search" action="/staff/suppliers/finance" method="get">
      <label htmlFor="finance-search">Search finance records</label>
      <div>
        <input id="finance-search" type="search" name="q" maxLength={100} defaultValue={data.searchQuery} placeholder="Supplier, listing, order item, or transfer reference" />
        <button className={catalogStyles.button} type="submit">Search</button>
        {data.searchQuery && <Link href="/staff/suppliers/finance">Clear</Link>}
      </div>
      <small>Searches the paginated work lists by supplier, listing, order item ID, and transfer or evidence reference. Each list keeps its own 50-row pages.</small>
    </form>

    <nav className={styles.workNav} aria-label="Finance work areas">
      <a href="#listing-source-costs"><span>Listing source costs</span><small>{countLabel(data.listingPagination.total, "listing")}</small></a>
      <a href="#order-item-costs"><span>Actual order-item costs</span><small>{countLabel(data.orderItemPagination.total, "order item")}</small></a>
      <a href="#supplier-transfers"><span>Record supplier transfers</span><small>{countLabel(transferGroups.size, "supplier")} on this page</small></a>
      <a href="#payable-coverage"><span>Payable coverage</span><small>{countLabel(data.payableCoveragePagination.total, "confirmed cost")}</small></a>
      <a href="#finance-history"><span>Finance history</span><small>Transfers and corrections</small></a>
    </nav>

    <section className={styles.section} id="listing-source-costs" aria-labelledby="listing-source-costs-title">
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="listing-source-costs-title">Listing source costs</h2>
          <p>Correct the current source-cost projection. Each change adds an audited correction; a blank amount clears the projection.</p>
        </div>
        <span className={styles.sectionCount}>{countLabel(data.listingPagination.total, "listing")}</span>
      </header>
      <nav className={styles.pager} aria-label="Finance listing pages">
        <span>{pageRange(data.listingPagination)} · Page {data.listingPagination.page} of {data.listingPagination.totalPages}</span>
        <div>
          {data.listingPagination.page > 1 && <Link href={listingPageHref(data.listingPagination.page - 1)}>Previous</Link>}
          {data.listingPagination.page < data.listingPagination.totalPages && <Link href={listingPageHref(data.listingPagination.page + 1)}>Next</Link>}
        </div>
      </nav>
      {data.listings.length === 0 ? <p className={styles.empty}>{data.searchQuery ? "No listing source costs match this search." : "No listing source costs are available."}</p> : <div className={styles.recordGrid}>
        {data.listings.map((item) => <article className={styles.record} key={item.id}>
          <div className={styles.recordHeading}>
            <div><h3>{item.title}</h3><code>{item.id}</code></div>
          </div>
          <dl className={styles.facts}>
            <div><dt>Supplier</dt><dd>{item.supplierName ?? "Platform fulfilled"}</dd></div>
            <div><dt>Current source cost</dt><dd>{usd(item.currentCostMinor)}</dd></div>
          </dl>
          <details className={styles.editDisclosure}>
            <summary>Correct listing source cost</summary>
            <p className={styles.hint}>Leave the amount blank to clear the current source-cost projection.</p>
            <form action={changeListingCostAction} className={styles.costForm}>
              <input type="hidden" name="listingsPage" value={data.listingPagination.page} />
              <input type="hidden" name="orderItemsPage" value={data.orderItemPagination.page} />
              <input type="hidden" name="transfersPage" value={data.transferPagination.page} />
              <input type="hidden" name="coveragePage" value={data.payableCoveragePagination.page} />
              <input type="hidden" name="q" value={data.searchQuery} />
              <input type="hidden" name="listingId" value={item.id} />
              <label>New amount (USD)<input name="amount" inputMode="decimal" defaultValue={dollarInput(item.currentCostMinor)} placeholder="e.g. 125.00" /></label>
              <label>Reason<input name="reason" required minLength={3} maxLength={1000} /></label>
              <button className={catalogStyles.button} type="submit">Record correction</button>
            </form>
          </details>
        </article>)}
      </div>}
    </section>

    <section className={styles.section} id="order-item-costs" aria-labelledby="order-item-costs-title">
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="order-item-costs-title">Actual order-item costs</h2>
          <p>Record placement or writing costs against an order’s eligible supplier routes. Checkout snapshots and previous corrections stay unchanged.</p>
        </div>
        <span className={styles.sectionCount}>{countLabel(data.orderItemPagination.total, "order item")}</span>
      </header>
      <nav className={styles.pager} aria-label="Finance order item pages">
        <span>{pageRange(data.orderItemPagination)} · Page {data.orderItemPagination.page} of {data.orderItemPagination.totalPages}</span>
        <div>
          {data.orderItemPagination.page > 1 && <Link href={orderPageHref(data.orderItemPagination.page - 1)}>Previous</Link>}
          {data.orderItemPagination.page < data.orderItemPagination.totalPages && <Link href={orderPageHref(data.orderItemPagination.page + 1)}>Next</Link>}
        </div>
      </nav>
      {data.orderItems.length === 0 ? <p className={styles.empty}>{data.searchQuery ? "No order items match this search." : "No order items are available."}</p> : <div className={styles.recordGrid}>
        {data.orderItems.map((item) => <article className={styles.record} key={item.id}>
          <div className={styles.recordHeading}>
            <div><h3>Order item</h3><code>{item.id}</code></div>
            <span className={styles.recordTag}>{item.supplierOptions.length ? "Supplier route" : "Internal cost"}</span>
          </div>
          <dl className={styles.facts}>
            <div><dt>Eligible supplier routes</dt><dd>{item.supplierOptions.length ? item.supplierOptions.map((option) => option.name).join(", ") : "Internal fulfillment"}</dd></div>
            <div><dt>Checkout placement cost</dt><dd>{usd(item.sourceCostMinor)}</dd></div>
            <div><dt>Checkout writing cost</dt><dd>{item.writingSelected ? usd(item.writingCostMinor) : "Not ordered"}</dd></div>
          </dl>
          <details className={styles.editDisclosure}>
            <summary>Record actual cost</summary>
            <p className={styles.hint}>This adds a new history record. Writing cost is internal unless attributed to an eligible supplier.</p>
            <form action={recordActualCostAction} className={styles.actualCostForm}>
              <input type="hidden" name="orderItemId" value={item.id} />
              <input type="hidden" name="listingsPage" value={data.listingPagination.page} />
              <input type="hidden" name="orderItemsPage" value={data.orderItemPagination.page} />
              <input type="hidden" name="transfersPage" value={data.transferPagination.page} />
              <input type="hidden" name="coveragePage" value={data.payableCoveragePagination.page} />
              <input type="hidden" name="q" value={data.searchQuery} />
              <label>Cost component<select name="component"><option value="PLACEMENT">Placement</option>{item.writingSelected && <option value="WRITING">Writing</option>}</select></label>
              <label>Supplier attribution<select name="supplierId"><option value="">Internal / GPHKM cost</option>{item.supplierOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
              <label>Actual amount (USD)<input name="amount" required inputMode="decimal" placeholder="e.g. 125.00" /></label>
              <label>Reason<input name="reason" required minLength={3} maxLength={1000} /></label>
              <button className={catalogStyles.button} type="submit">Record actual cost</button>
            </form>
          </details>
        </article>)}
      </div>}
    </section>

    <section className={styles.section} id="supplier-transfers" aria-labelledby="supplier-transfers-title">
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="supplier-transfers-title">Record supplier transfers</h2>
          <p>Record only a completed manual transfer. Attach its private PDF or EML receipt and allocate the full amount to order items for the same supplier.</p>
        </div>
      </header>
      <p className={styles.notice}>This is an audited record of a transfer that already happened. GPHKM does not initiate or independently verify supplier bank payments.</p>
      {transferGroups.size === 0
        ? <p className={styles.empty}>{data.searchQuery ? "No supplier-linked order items match this search. Search by a supplier name or order item ID to find allocation candidates." : "No supplier-linked order items are on this page. Use the order-item pages above to reach items with eligible supplier routes."}</p>
        : <div className={styles.transferGroups}>{[...transferGroups.values()].map((group) => <article className={styles.transferGroup} key={group.supplierId}>
          <h3>{group.supplierName}</h3>
          <TransferAllocationEditor
            items={group.items}
            supplierId={group.supplierId}
            idempotencyKey={randomUUID()}
            listingsPage={data.listingPagination.page}
            orderItemsPage={data.orderItemPagination.page}
            transfersPage={data.transferPagination.page}
            coveragePage={data.payableCoveragePagination.page}
            searchQuery={data.searchQuery}
            searchAction={searchSupplierTransferItemsAction}
          />
        </article>)}</div>}
    </section>

    <section className={styles.section} id="payable-coverage" aria-labelledby="payable-coverage-title">
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="payable-coverage-title">Supplier payable coverage</h2>
          <p>Compare completed transfer allocations with confirmed actual costs for the same supplier and order item. Unknown costs stay provisional, not zero.</p>
        </div>
        <span className={styles.sectionCount}>{countLabel(data.payableCoveragePagination.total, "confirmed cost")}</span>
      </header>
      {data.payableCoverage.length === 0 ? <p className={styles.empty}>{data.searchQuery ? "No payable coverage matches this search." : "No confirmed supplier costs to reconcile. Add an actual cost above to include an item here."}</p> : <>
        <nav className={styles.pager} aria-label="Supplier payable coverage pages">
          <span>{pageRange(data.payableCoveragePagination)} · Page {data.payableCoveragePagination.page} of {data.payableCoveragePagination.totalPages}</span>
          <div>
            {data.payableCoveragePagination.page > 1 && <Link href={coveragePageHref(data.payableCoveragePagination.page - 1)}>Previous</Link>}
            {data.payableCoveragePagination.page < data.payableCoveragePagination.totalPages && <Link href={coveragePageHref(data.payableCoveragePagination.page + 1)}>Next</Link>}
          </div>
        </nav>
        <div className={styles.coverageList}>
        {data.payableCoverage.map((item) => <article className={styles.coverageRecord} key={`${item.orderItemId}:${item.supplierId}`}>
          <div className={styles.coverageHeading}>
            <div><h3>{item.supplierName}</h3><code>{item.orderItemId}</code></div>
            <span className={`${styles.coverageStatus} ${item.status === "PAID" ? styles.coveragePaid : item.status === "OVERPAID" ? styles.coverageOverpaid : styles.coveragePending}`}>{item.status.replaceAll("_", " ")}</span>
          </div>
          <dl className={styles.coverageFacts}>
            <div><dt>Confirmed cost</dt><dd>{usd(item.confirmedCostMinor)}</dd></div>
            <div><dt>Transferred</dt><dd>{usd(item.transferredMinor)}</dd></div>
          </dl>
        </article>)}
        </div>
      </>}
    </section>

    <section className={styles.section} id="finance-history" aria-labelledby="finance-history-title">
      <header className={styles.sectionHeader}>
        <div>
          <h2 id="finance-history-title">Finance history</h2>
          <p>Recorded transfers and cost corrections remain available for audit. Legacy payment labels do not count as transfers.</p>
        </div>
      </header>

      <details className={styles.historyGroup}>
        <summary>Supplier transfer events <span>{countLabel(data.transferPagination.total, "record")}</span></summary>
        <nav className={styles.pager} aria-label="Supplier transfer pages">
          <span>{pageRange(data.transferPagination)} · Page {data.transferPagination.page} of {data.transferPagination.totalPages}</span>
          <div>
            {data.transferPagination.page > 1 && <Link href={transferPageHref(data.transferPagination.page - 1)}>Previous</Link>}
            {data.transferPagination.page < data.transferPagination.totalPages && <Link href={transferPageHref(data.transferPagination.page + 1)}>Next</Link>}
          </div>
        </nav>
        {data.payments.length === 0 ? <p className={styles.empty}>No transfers recorded.</p> : <div className={styles.historyList}>
          {data.payments.map((item) => <article className={styles.historyRecord} key={item.id}>
            <div className={styles.recordHeading}>
              <div><h3>{item.supplierName}</h3><span>{when(item.transferDate)} · {item.transferReference}</span></div>
              <strong className={styles.recordAmount}>{usd(item.amountMinor)}</strong>
            </div>
            <div className={styles.allocationList}>
              <strong>Order-item allocations</strong>
              {item.allocations.map((allocation) => <p key={`${item.id}:${allocation.orderItemId}`}><code>{allocation.orderItemId}</code><span>{usd(allocation.amountMinor)} · {allocation.coverage.replaceAll("_", " ")}</span></p>)}
            </div>
            <dl className={styles.facts}>
              <div><dt>Evidence reference</dt><dd>{item.evidenceReference}</dd></div>
              <div><dt>Reason</dt><dd>{item.reason}</dd></div>
              <div><dt>Recorded</dt><dd>{when(item.createdAt)}</dd></div>
            </dl>
            {item.evidence && <a className={styles.evidenceLink} href={`/api/staff/suppliers/finance/transfers/evidence/${encodeURIComponent(item.evidence.id)}`}>Download private {item.evidence.fileKind} receipt</a>}
          </article>)}
        </div>}
      </details>

      <details className={styles.historyGroup}>
        <summary>Legacy payment status history <span>{countLabel(data.legacyPayments.length, "recent record")}</span></summary>
        <p className={styles.historyNote}>Historical PAID/UNPAID records are preserved for audit but excluded from transfer totals and payable reconciliation.</p>
        {data.legacyPayments.length === 0 ? <p className={styles.empty}>No legacy records.</p> : <div className={styles.historyList}>
          {data.legacyPayments.map((item) => <article className={styles.historyRecord} key={item.id}>
            <div className={styles.recordHeading}>
              <div><h3>{item.supplierName}</h3><code>{item.orderItemId}</code></div>
              <span className={styles.recordTag}>{item.status}</span>
            </div>
            <dl className={styles.facts}>
              <div><dt>Amount</dt><dd>{usd(item.amountMinor)}</dd></div>
              <div><dt>Payment date</dt><dd>{when(item.paymentDate)}</dd></div>
              <div><dt>Evidence reference</dt><dd>{item.evidenceReference}</dd></div>
              <div><dt>Reason</dt><dd>{item.reason}</dd></div>
              <div><dt>Recorded</dt><dd>{when(item.createdAt)}</dd></div>
            </dl>
          </article>)}
        </div>}
      </details>

      <details className={styles.historyGroup}>
        <summary>Recent cost corrections <span>{countLabel(costHistory.length, "recent record")}</span></summary>
        {costHistory.length === 0 ? <p className={styles.empty}>No cost corrections recorded.</p> : <div className={styles.historyList}>
          {costHistory.map((item) => <article className={styles.historyRecord} key={item.id}>
            <div className={styles.recordHeading}>
              <div><h3>{item.label}</h3><code>{item.recordId}</code></div>
              <span className={styles.recordTag}>{item.component}</span>
            </div>
            <dl className={styles.facts}>
              <div><dt>Supplier</dt><dd>{item.supplierName}</dd></div>
              <div><dt>Previous amount</dt><dd>{usd(item.previousCostMinor)}</dd></div>
              <div><dt>New amount</dt><dd>{usd(item.newCostMinor)}</dd></div>
              <div><dt>Reason</dt><dd>{item.reason}</dd></div>
              <div><dt>Recorded</dt><dd>{when(item.createdAt)}</dd></div>
            </dl>
          </article>)}
        </div>}
      </details>
    </section>
  </div>;
}
