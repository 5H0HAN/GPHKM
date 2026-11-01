"use client";

import { useId, useMemo, useState, useTransition } from "react";
import styles from "../../catalog/catalog.module.css";
import financeStyles from "./finance.module.css";

type SearchAction = (supplierId: string, query: string) => Promise<ItemOption[]>;
type ItemOption = { id: string; title: string };
type AllocationRow = { key: string; orderItemId: string; amount: string };

export function TransferAllocationEditor({ items, supplierId, idempotencyKey, listingsPage, orderItemsPage, transfersPage, coveragePage, searchQuery, searchAction }: { items: ItemOption[]; supplierId: string; idempotencyKey: string; listingsPage: number; orderItemsPage: number; transfersPage: number; coveragePage: number; searchQuery: string; searchAction: SearchAction }) {
  const initialRowId = useId();
  const [rows, setRows] = useState<AllocationRow[]>([{ key: initialRowId, orderItemId: "", amount: "" }]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ItemOption[]>(items);
  const [searchMessage, setSearchMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const allocations = useMemo(() => rows.filter((row) => row.orderItemId && row.amount.trim()).map(({ orderItemId, amount }) => ({ orderItemId, amount })), [rows]);
  const options = useMemo(() => [...new Map([...matches, ...items, ...rows.flatMap((row) => {
    const selected = matches.find((item) => item.id === row.orderItemId) ?? items.find((item) => item.id === row.orderItemId);
    return selected ? [selected] : [];
  })].map((item) => [item.id, item])).values()], [items, matches, rows]);

  function update(key: string, patch: Partial<AllocationRow>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  }

  function addRow() {
    setRows((current) => [...current, { key: crypto.randomUUID(), orderItemId: "", amount: "" }]);
  }

  function search() {
    startTransition(async () => {
      try {
        const found = await searchAction(supplierId, query);
        setMatches((current) => [...new Map([...current, ...found].map((item) => [item.id, item])).values()]);
        setSearchMessage(found.length ? `${found.length} matching order item${found.length === 1 ? "" : "s"} loaded.` : "No matching order items. Enter at least eight characters from the item ID.");
      } catch {
        setSearchMessage("Order item search failed. Check Finance access and try again.");
      }
    });
  }

  return <form action="/api/staff/suppliers/finance/transfers" method="post" encType="multipart/form-data" className={financeStyles.transferForm} aria-label="Record a supplier transfer">
    <input type="hidden" name="supplierId" value={supplierId} />
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <input type="hidden" name="listingsPage" value={listingsPage} />
    <input type="hidden" name="orderItemsPage" value={orderItemsPage} />
    <input type="hidden" name="transfersPage" value={transfersPage} />
    <input type="hidden" name="coveragePage" value={coveragePage} />
    <input type="hidden" name="q" value={searchQuery} />
    <input type="hidden" name="allocationsJson" value={JSON.stringify(allocations)} />
    <div className={financeStyles.transferFields}>
      <label>Total transferred (USD)<input name="amount" required inputMode="decimal" placeholder="e.g. 125.00" /></label>
      <label>Transfer date<input name="date" required type="date" /></label>
      <label>Transfer reference<input name="transferReference" required maxLength={200} /></label>
      <label>Bank or provider evidence reference<input name="evidenceReference" required maxLength={500} /></label>
      <label className={financeStyles.transferReceipt}>Receipt evidence (PDF or EML)<input name="evidenceFile" type="file" accept=".pdf,.eml,application/pdf,message/rfc822" required /><small>Private, audited, and download-only. Up to 5 MiB; exclude customer information and payment-card data.</small></label>
      <label className={financeStyles.transferReason}>Reason<input name="reason" required minLength={3} maxLength={1000} /></label>
    </div>

    <section className={financeStyles.transferAllocation} aria-labelledby={`${initialRowId}-allocation-title`}>
      <header className={financeStyles.transferAllocationHeader}>
        <h4 id={`${initialRowId}-allocation-title`}>Allocate the transfer</h4>
        <p>Split the full amount across one or more order items for this supplier.</p>
      </header>
      <div className={financeStyles.transferSearch}>
        <label>Find order items by ID<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={36} autoComplete="off" /></label>
        <button className={styles.button} type="button" onClick={search} disabled={isPending}>{isPending ? "Searching…" : "Search order items"}</button>
        <small role="status">{searchMessage || "Search returns at most 25 matches. Enter at least 8 characters from the order item ID."}</small>
      </div>
      <div className={financeStyles.allocationRows}>
        {rows.map((row, index) => <fieldset className={financeStyles.allocationRow} key={row.key}>
          <legend>Order item {index + 1}</legend>
          <div className={financeStyles.allocationFields}>
            <label>Order item<select required value={row.orderItemId} onChange={(event) => update(row.key, { orderItemId: event.target.value })}>
              <option value="">Choose an item</option>{options.filter((item) => item.id === row.orderItemId || !rows.some((other) => other.key !== row.key && other.orderItemId === item.id)).map((item) => <option key={item.id} value={item.id}>{item.title} · {item.id}</option>)}
            </select></label>
            <label>Allocated amount (USD)<input required inputMode="decimal" value={row.amount} onChange={(event) => update(row.key, { amount: event.target.value })} placeholder="e.g. 80.00" /></label>
            {rows.length > 1 && <button className={styles.button} type="button" onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}>Remove</button>}
          </div>
        </fieldset>)}
      </div>
      <div className={financeStyles.transferActions}>
        <button className={styles.button} type="button" onClick={addRow}>Add order item</button>
        <button className={`${styles.button} ${financeStyles.recordTransferButton}`} type="submit">Record transfer</button>
      </div>
    </section>
  </form>;
}
